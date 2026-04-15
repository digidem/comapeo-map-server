import { fetch as secretStreamFetchOrig } from 'secret-stream-http'

import { errors } from './errors.js'
import { isArrayReadonly } from './utils.js'

const CONNECTION_TIMEOUT_MS = 5000 // 5s

/**
 * A wrapper around secret-stream-http's fetch that tries multiple URLs and
 * returns the first successful response. This is useful when the server has
 * multiple IPs for different network interfaces.
 */
export async function secretStreamFetch(
	urls: string | URL | readonly [string | URL, ...Array<string | URL>],
	options?: Parameters<typeof secretStreamFetchOrig>[1],
) {
	if (!isArrayReadonly(urls)) {
		urls = [urls]
	}
	const responsePromises: Array<Promise<Response>> = []
	const controllers: AbortController[] = []

	// The server could have multiple IPs for different network interfaces, and
	// not all of them may be on the same network as us, so try every URL and
	// return the first response.
	for (const url of urls) {
		// We need a separate AbortController for each request, because with fetch,
		// aborting the signal will abort the response body, so the fulfilled
		// response would be aborted before we can download it.
		const controller = new AbortController()
		const timeout = setTimeout(() => {
			controller.abort()
		}, CONNECTION_TIMEOUT_MS)
		const signal = options?.signal
			? AbortSignal.any([options.signal, controller.signal])
			: controller.signal
		controllers.push(controller)

		const responsePromise = (async () => {
			try {
				const response = (await secretStreamFetchOrig(url, {
					...options,
					signal,
				})) as unknown as Response // Subtle difference between Undici fetch Response and whatwg Response
				// First to fulfill — abort the other in-flight requests so their
				// sockets close. Losers reject with AbortError, which Promise.any
				// observes, so no unhandled rejections.
				for (const c of controllers) {
					if (c !== controller) {
						c.abort()
					}
				}
				return response
			} finally {
				clearTimeout(timeout)
			}
		})()
		responsePromises.push(responsePromise)
	}

	try {
		return await Promise.any(responsePromises)
	} catch (err) {
		throw new errors.DOWNLOAD_ERROR({
			message: 'Could not connect to map share sender',
			urls,
			cause: err,
		})
	}
}
