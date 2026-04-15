import { setImmediate as setImmediateP } from 'node:timers/promises'

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { anyFetch } from '../src/lib/secret-stream-fetch.js'

type Resolver = (value: Response) => void
type Rejecter = (reason: unknown) => void

type ControllableFetch = {
	// `any` at the call sites: Undici's Response type (what anyFetch expects
	// for the fetch option) differs slightly from the WHATWG Response that
	// the tests construct.
	fn: any
	resolvers: Resolver[]
	rejecters: Rejecter[]
	signalAt: (index: number) => AbortSignal
	methodAt: (index: number) => string | undefined
}

/**
 * Build a mock fetch whose calls are deferred promises — the test resolves
 * or rejects each one explicitly. Captures the AbortSignal and method of
 * every call for later assertions, and rejects a pending call with
 * AbortError whenever its signal is aborted (mirroring real fetch).
 */
function makeControllableFetch(): ControllableFetch {
	const resolvers: Resolver[] = []
	const rejecters: Rejecter[] = []
	const signals: AbortSignal[] = []
	const methods: Array<string | undefined> = []

	const fn = vi.fn(
		(_input: any, init?: any) =>
			new Promise<Response>((resolve, reject) => {
				resolvers.push(resolve)
				rejecters.push(reject)
				const signal = init.signal as AbortSignal
				signals.push(signal)
				methods.push(init?.method)
				const onAbort = () => {
					reject(
						signal.reason ??
							new DOMException('The operation was aborted.', 'AbortError'),
					)
				}
				if (signal.aborted) {
					onAbort()
				} else {
					signal.addEventListener('abort', onAbort, { once: true })
				}
			}),
	)

	return {
		fn,
		resolvers,
		rejecters,
		signalAt: (i) => signals[i]!,
		methodAt: (i) => methods[i],
	}
}

describe('anyFetch — single URL', () => {
	let mock: ControllableFetch

	beforeEach(() => {
		mock = makeControllableFetch()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('skips the OPTIONS probe and fetches directly', async () => {
		const p = anyFetch(['https://example.com/a'], {
			fetch: mock.fn,
			method: 'POST',
		})
		// Only one call — no probe.
		expect(mock.resolvers).toHaveLength(1)
		expect(mock.methodAt(0)).toBe('POST')
		const winner = new Response('ok')
		mock.resolvers[0]!(winner)
		await expect(p).resolves.toBe(winner)
	})

	it('throws the original error when the only URL fails', async () => {
		const p = anyFetch(['https://example.com/a'], { fetch: mock.fn })
		const error = new Error('ECONNREFUSED')
		mock.rejecters[0](error)
		await expect(p).rejects.toBe(error)
	})

	it('aborts the in-flight fetch after the 5s connection timeout', async () => {
		vi.useFakeTimers()
		const p = anyFetch(['https://example.com/a'], { fetch: mock.fn })
		const rejection = p.catch((err: unknown) => err)
		await vi.advanceTimersByTimeAsync(5000)
		expect(mock.signalAt(0).aborted).toBe(true)
		await expect(rejection).resolves.toMatchObject({ name: 'TimeoutError' })
	})
})

describe('anyFetch — multiple URLs', () => {
	let mock: ControllableFetch

	beforeEach(() => {
		mock = makeControllableFetch()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('sends OPTIONS probes in parallel before any real request', async () => {
		const p = anyFetch(
			[
				'https://example.com/a',
				'https://example.com/b',
				'https://example.com/c',
			],
			{ fetch: mock.fn, method: 'POST' },
		)
		// Three OPTIONS probes were dispatched up front.
		expect(mock.resolvers).toHaveLength(3)
		expect(mock.methodAt(0)).toBe('OPTIONS')
		expect(mock.methodAt(1)).toBe('OPTIONS')
		expect(mock.methodAt(2)).toBe('OPTIONS')
		// Resolve probe 1 as the winner.
		mock.resolvers[1]!(new Response(null, { status: 204 }))
		// The real request follows as a fourth call, with the caller's method.
		await vi.waitFor(() => expect(mock.resolvers).toHaveLength(4))
		expect(mock.methodAt(3)).toBe('POST')
		expect(mock.fn.mock.calls[3]![0]).toBe('https://example.com/b')
		const real = new Response('ok')
		mock.resolvers[3]!(real)
		await expect(p).resolves.toBe(real)
	})

	it('aborts losing probes once a winner is declared', async () => {
		const p = anyFetch(
			[
				'https://example.com/a',
				'https://example.com/b',
				'https://example.com/c',
			],
			{ fetch: mock.fn },
		)
		mock.resolvers[0]!(new Response(null, { status: 204 }))
		// Wait for the winner IIFE to resume and run its abort cascade.
		await vi.waitFor(() => expect(mock.resolvers).toHaveLength(4))
		// Winner's signal not aborted; loser probes ARE aborted.
		expect(mock.signalAt(0).aborted).toBe(false)
		expect(mock.signalAt(1).aborted).toBe(true)
		expect(mock.signalAt(2).aborted).toBe(true)
		mock.resolvers[3]!(new Response('ok'))
		await p
	})

	it('does not abort the winner probe when a sibling fulfills in the same tick', async () => {
		// Regression: two probes fulfill near-simultaneously. Without the
		// winnerIndex guard, the second IIFE's abort cascade would fire and
		// wastefully abort the winner that Promise.any has already picked.
		const p = anyFetch(
			[
				'https://example.com/a',
				'https://example.com/b',
				'https://example.com/c',
			],
			{ fetch: mock.fn },
		)
		mock.resolvers[0]!(new Response(null, { status: 204 }))
		mock.resolvers[1]!(new Response(null, { status: 204 }))
		await vi.waitFor(() => expect(mock.resolvers).toHaveLength(4))
		expect(mock.signalAt(0).aborted).toBe(false)
		expect(mock.signalAt(1).aborted).toBe(true)
		expect(mock.signalAt(2).aborted).toBe(true)
		// Real request goes to URL a (the first responder).
		expect(mock.fn.mock.calls[3]![0]).toBe('https://example.com/a')
		mock.resolvers[3]!(new Response('ok'))
		await p
	})

	it('treats any response (including non-ok) as reachable', async () => {
		const p = anyFetch(['https://example.com/a', 'https://example.com/b'], {
			fetch: mock.fn,
		})
		mock.resolvers[1]!(new Response('not found', { status: 404 }))
		await vi.waitFor(() => expect(mock.resolvers).toHaveLength(3))
		// Real request is sent to URL b — 404 still counts as reachable.
		expect(mock.fn.mock.calls[2]![0]).toBe('https://example.com/b')
		mock.resolvers[2]!(new Response('ok'))
		await p
	})

	it('falls through to the next URL when the winner real request fails', async () => {
		const p = anyFetch(['https://example.com/a', 'https://example.com/b'], {
			fetch: mock.fn,
		})
		mock.resolvers[1]!(new Response(null, { status: 204 }))
		// Real request to URL b (the probe winner) is the third call.
		await vi.waitFor(() => expect(mock.resolvers).toHaveLength(3))
		expect(mock.fn.mock.calls[2]![0]).toBe('https://example.com/b')
		// Reject the winner's real request.
		mock.rejecters[2]!(new Error('ECONNRESET'))
		// Sequential fallback: try URL a next.
		await vi.waitFor(() => expect(mock.resolvers).toHaveLength(4))
		expect(mock.fn.mock.calls[3]![0]).toBe('https://example.com/a')
		const real = new Response('ok')
		mock.resolvers[3]!(real)
		await expect(p).resolves.toBe(real)
	})

	it('falls through probe failures to the first responding probe', async () => {
		const p = anyFetch(['https://example.com/a', 'https://example.com/b'], {
			fetch: mock.fn,
		})
		mock.rejecters[0]!(new Error('ECONNREFUSED'))
		mock.resolvers[1]!(new Response(null, { status: 204 }))
		await vi.waitFor(() => expect(mock.resolvers).toHaveLength(3))
		// Winner is URL b (the only probe that responded).
		expect(mock.fn.mock.calls[2]![0]).toBe('https://example.com/b')
		mock.resolvers[2]!(new Response('ok'))
		await p
	})

	it('throws AggregateError when every probe fails', async () => {
		const p = anyFetch(['https://example.com/a', 'https://example.com/b'], {
			fetch: mock.fn,
		})
		const errorA = new Error('fail a')
		const errorB = new Error('fail b')
		mock.rejecters[0]!(errorA)
		mock.rejecters[1]!(errorB)
		await expect(p).rejects.toMatchObject({
			name: 'AggregateError',
			errors: [errorA, errorB],
		})
	})

	it('throws AggregateError when every sequential real request fails', async () => {
		const p = anyFetch(['https://example.com/a', 'https://example.com/b'], {
			fetch: mock.fn,
		})
		const errorA = new Error('a failed')
		const errorB = new Error('b failed')
		// Both probes succeed → URL a wins, fallback list is [a, b].
		mock.resolvers[0]!(new Response(null, { status: 204 }))
		await vi.waitFor(() => expect(mock.resolvers).toHaveLength(3))
		mock.rejecters[2]!(errorA)
		await vi.waitFor(() => expect(mock.resolvers).toHaveLength(4))
		mock.rejecters[3]!(errorB)
		await expect(p).rejects.toMatchObject({
			name: 'AggregateError',
			errors: [errorA, errorB],
		})
	})

	it('propagates an external abort signal to every probe', async () => {
		const external = new AbortController()
		const p = anyFetch(['https://example.com/a', 'https://example.com/b'], {
			fetch: mock.fn,
			signal: external.signal,
		})
		external.abort()
		expect(mock.signalAt(0).aborted).toBe(true)
		expect(mock.signalAt(1).aborted).toBe(true)
		await expect(p).rejects.toMatchObject({
			name: 'AggregateError',
			errors: [
				expect.objectContaining({ name: 'AbortError' }),
				expect.objectContaining({ name: 'AbortError' }),
			],
		})
	})

	it('aborts every probe after the 5s connection timeout', async () => {
		vi.useFakeTimers()
		const p = anyFetch(['https://example.com/a', 'https://example.com/b'], {
			fetch: mock.fn,
		})
		const rejection = p.catch((err: unknown) => err)
		await vi.advanceTimersByTimeAsync(5000)
		expect(mock.signalAt(0).aborted).toBe(true)
		expect(mock.signalAt(1).aborted).toBe(true)
		await expect(rejection).resolves.toMatchObject({
			name: 'AggregateError',
			errors: [
				expect.objectContaining({ name: 'TimeoutError' }),
				expect.objectContaining({ name: 'TimeoutError' }),
			],
		})
	})

	it('does not emit unhandled rejections when losing probes reject with AbortError', async () => {
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason)
		}
		process.on('unhandledRejection', onUnhandled)
		try {
			const p = anyFetch(
				[
					'https://example.com/a',
					'https://example.com/b',
					'https://example.com/c',
				],
				{ fetch: mock.fn },
			)
			mock.resolvers[0]!(new Response(null, { status: 204 }))
			await vi.waitFor(() => expect(mock.resolvers).toHaveLength(4))
			mock.resolvers[3]!(new Response('ok'))
			await p
			// Let the unhandledRejection check run a couple of event-loop turns.
			await setImmediateP()
			await setImmediateP()
			expect(unhandled).toEqual([])
		} finally {
			process.off('unhandledRejection', onUnhandled)
		}
	})
})
