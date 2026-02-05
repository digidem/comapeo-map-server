import { fetch as secretStreamFetchOrig } from 'secret-stream-http'

import { errors } from './errors.js'
import { isArrayReadonly } from './utils.js'

/**
 * A wrapper around secret-stream-http's fetch that tries multiple URLs until one works.
 * This is useful when the server has multiple IPs for different network interfaces.
 */
export async function secretStreamFetch(
	urls: string | URL | readonly [string | URL, ...Array<string | URL>],
	options: Parameters<typeof secretStreamFetchOrig>[1],
) {
	if (!isArrayReadonly(urls)) {
		urls = [urls]
	}
	let response: Response | undefined
	let error: unknown

	// The server could have multiple IPs for different network interfaces, and
	// not all of them may be on the same network as us, so try each URL until
	// one works
	for (const url of urls) {
		try {
			response = (await secretStreamFetchOrig(
				url,
				options,
			)) as unknown as Response // Subtle difference bewteen Undici fetch Response and whatwg Response
			break // Exit loop on successful fetch
		} catch (err) {
			error = err
			// Ignore errors and try the next URL
		}
	}
	if (!response) {
		throw new errors.DOWNLOAD_ERROR({
			message: 'Could not connect to map share sender',
			urls,
			cause: error,
		})
	}
	return response
}
