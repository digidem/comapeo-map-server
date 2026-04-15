import { fetch as secretStreamFetchOrig } from 'secret-stream-http'

import { noop } from './utils.js'

const CONNECTION_TIMEOUT_MS = 5000 // 5s

type FetchFn = typeof secretStreamFetchOrig
type FetchInput = Parameters<FetchFn>[0]
type FetchInit = NonNullable<Parameters<FetchFn>[1]>

type AnyFetchInit = FetchInit & {
	/**
	 * Underlying fetch implementation. Defaults to secret-stream-http's fetch.
	 * Useful for overriding in tests.
	 */
	fetch?: FetchFn
	/**
	 * Connection timeout in milliseconds. This is a timeout for establishing the
	 * connection only, not for the entire request. If the connection is not
	 * established within this time, the request will be aborted and treated as a
	 * connection failure. Default is 5000ms (5s), which should be plenty of time
	 * for a local network request
	 */
	timeoutMs?: number
}

/**
 * A fetch-compatible wrapper that accepts an array of URLs that are first
 * probed in parallel with OPTIONS requests. The real request is then sent to
 * each URL in series — starting with whichever probe responded first — until
 * one succeeds. The probe step is what makes this safe against stateful
 * endpoints: only one real request ever hits the server per call.
 *
 * Adds a per-request connection timeout, set by `init.timeoutMs` and defaults
 * to 5000ms (5s).
 *
 * The `init.fetch` option overrides the underlying fetch implementation
 * and defaults to secret-stream-http's fetch.
 */
export async function anyFetch(
	inputs: readonly [FetchInput, ...FetchInput[]],
	init?: AnyFetchInit,
): Promise<Response> {
	if (inputs.length === 1) {
		return await timeoutFetch(inputs[0], init)
	}

	let winningInput: FetchInput
	try {
		winningInput = await raceProbes(inputs, init)
	} catch (err) {
		// If the caller aborted mid-probe, propagate that as an AbortError
		// (via signal.reason) rather than the probe's AggregateError — the
		// caller needs to distinguish "I cancelled this" from "nothing was
		// reachable".
		init?.signal?.throwIfAborted()
		throw err
	}
	const orderedInputs = [
		winningInput,
		...inputs.filter((i) => i !== winningInput),
	]

	const errors: unknown[] = []
	for (const input of orderedInputs) {
		try {
			return await timeoutFetch(input, init)
		} catch (err) {
			// If the caller aborted mid-fetch, propagate that rather than our
			// internal connection-timeout abort (or whatever lower-level error).
			init?.signal?.throwIfAborted()
			errors.push(err)
		}
	}
	throw new AggregateError(errors, 'All fetch attempts failed')
}

/**
 * Fetch a single URL with a connection timeout (different than calling WHAT-WG
 * fetch with a timeout signal, which applies to the entire request, not just
 * connection establishment).
 */
async function timeoutFetch(
	url: FetchInput,
	{
		fetch: innerFetch = secretStreamFetchOrig,
		timeoutMs = CONNECTION_TIMEOUT_MS,
		...fetchInit
	}: AnyFetchInit = {},
): Promise<Response> {
	const controller = new AbortController()
	const timeout = setTimeout(() => {
		controller.abort(new DOMException('Connection timed out', 'TimeoutError'))
	}, timeoutMs)
	const signal = fetchInit.signal
		? AbortSignal.any([fetchInit.signal, controller.signal])
		: controller.signal
	try {
		return (await innerFetch(url, {
			...fetchInit,
			signal,
		})) as unknown as Response // Subtle difference between Undici fetch Response and whatwg Response
	} finally {
		clearTimeout(timeout)
	}
}

/**
 * Probe URLs in parallel with OPTIONS requests. Returns the "winning" URL.
 * Throws AggregateError if no probe responds before the connection timeout or
 * if all probes fail with a network error.
 */
async function raceProbes(
	inputs: readonly FetchInput[],
	fetchInit: FetchInit = {},
): Promise<FetchInput> {
	const controllers: AbortController[] = []
	const probePromises: Promise<FetchInput>[] = []
	let hasWinner = false

	for (const url of inputs) {
		const controller = new AbortController()
		const signal = fetchInit.signal
			? AbortSignal.any([fetchInit.signal, controller.signal])
			: controller.signal
		controllers.push(controller)
		const probePromise = (async () => {
			const response = await timeoutFetch(url, {
				...fetchInit,
				method: 'OPTIONS',
				body: undefined,
				signal,
			})
			response.body?.cancel().catch(noop) // We don't care about the response body, and we want to free resources as soon as possible
			if (hasWinner) {
				throw new DOMException('Aborted by winner', 'AbortError')
			}
			hasWinner = true
			for (const c of controllers) {
				if (c !== controller) {
					c.abort(new DOMException('Aborted by winner', 'AbortError'))
				}
			}
			return url
		})()
		probePromises.push(probePromise)
	}

	return Promise.any(probePromises)
}
