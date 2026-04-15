import { setImmediate as setImmediateP } from 'node:timers/promises'

import { fetch as mockedFetch } from 'secret-stream-http'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { secretStreamFetch } from '../src/lib/secret-stream-fetch.js'

vi.mock('secret-stream-http', () => ({ fetch: vi.fn() }))

// Per-call resolvers for pending fetches, indexed by call order.
const resolvers: Array<(value: Response) => void> = []
const rejecters: Array<(reason: unknown) => void> = []

const signalAt = (i: number) =>
	vi.mocked(mockedFetch).mock.calls[i]![1]!.signal as AbortSignal

describe('secretStreamFetch', () => {
	beforeEach(() => {
		resolvers.length = 0
		rejecters.length = 0
		vi.mocked(mockedFetch).mockReset()
		vi.mocked(mockedFetch).mockImplementation(
			(_url, init) =>
				new Promise<Response>((resolve, reject) => {
					resolvers.push(resolve)
					rejecters.push(reject)
					// Mirror real fetch: aborting the signal rejects with AbortError.
					init!.signal!.addEventListener(
						'abort',
						() =>
							reject(
								new DOMException('The operation was aborted.', 'AbortError'),
							),
						{ once: true },
					)
				}) as never,
		)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('wraps a single URL string into an array', async () => {
		const p = secretStreamFetch('https://example.com/a')
		expect(resolvers).toHaveLength(1)
		const winner = new Response('ok')
		resolvers[0](winner)
		await expect(p).resolves.toBe(winner)
	})

	it('returns the first fulfilled response', async () => {
		const p = secretStreamFetch([
			'https://example.com/a',
			'https://example.com/b',
			'https://example.com/c',
		])
		expect(resolvers).toHaveLength(3)
		const winner = new Response('winner')
		resolvers[1](winner)
		await expect(p).resolves.toBe(winner)
	})

	it('aborts losing siblings but not the winner', async () => {
		const p = secretStreamFetch([
			'https://example.com/a',
			'https://example.com/b',
			'https://example.com/c',
		])
		resolvers[1](new Response('winner'))
		await p
		expect(signalAt(0).aborted).toBe(true)
		expect(signalAt(1).aborted).toBe(false)
		expect(signalAt(2).aborted).toBe(true)
	})

	it('does not abort the winner when a sibling fulfills in the same tick', async () => {
		// Regression: on Windows CI, multiple mapShareUrls connect successfully
		// to the same sender. Two fetches fulfill near-simultaneously, and the
		// second IIFE to resume used to run its own abort cascade — tearing
		// down the winner's controller and body mid-read. The winnerDeclared
		// guard makes the second IIFE bow out.
		const p = secretStreamFetch([
			'https://example.com/a',
			'https://example.com/b',
			'https://example.com/c',
		])
		// Both fulfill before microtasks flush, queuing two await-resumes.
		const winnerResponse = new Response('winner')
		const laterResponse = new Response('too late')
		resolvers[0](winnerResponse)
		resolvers[1](laterResponse)
		const winner = await p
		expect(winner).toBe(winnerResponse)
		// The winner's controller must NEVER be aborted by a later-fulfilling
		// sibling — without the fix, signalAt(0).aborted would be true.
		expect(signalAt(0).aborted).toBe(false)
		// Both other URLs were aborted by the winner's cascade.
		expect(signalAt(1).aborted).toBe(true)
		expect(signalAt(2).aborted).toBe(true)
		// The late fulfiller's body was released (cancelled stream is locked
		// and its reader reports done on first read).
		expect(laterResponse.body?.locked).toBe(false)
		const reader = laterResponse.body!.getReader()
		const { done } = await reader.read()
		expect(done).toBe(true)
	})

	it('returns a later URL when an earlier one rejects', async () => {
		const p = secretStreamFetch([
			'https://example.com/a',
			'https://example.com/b',
		])
		rejecters[0](new Error('ECONNREFUSED'))
		const winner = new Response('ok')
		resolvers[1](winner)
		await expect(p).resolves.toBe(winner)
	})

	it('throws DOWNLOAD_ERROR when every URL rejects', async () => {
		const p = secretStreamFetch([
			'https://example.com/a',
			'https://example.com/b',
		])
		rejecters[0](new Error('fail a'))
		rejecters[1](new Error('fail b'))
		await expect(p).rejects.toMatchObject({
			code: 'DOWNLOAD_ERROR',
			status: 500,
		})
	})

	it('propagates an external abort signal to every in-flight fetch', async () => {
		const external = new AbortController()
		const p = secretStreamFetch(
			['https://example.com/a', 'https://example.com/b'],
			{ signal: external.signal },
		)
		external.abort()
		expect(signalAt(0).aborted).toBe(true)
		expect(signalAt(1).aborted).toBe(true)
		await expect(p).rejects.toMatchObject({ code: 'DOWNLOAD_ERROR' })
	})

	it('aborts every fetch after the 5s connection timeout', async () => {
		vi.useFakeTimers()
		const p = secretStreamFetch([
			'https://example.com/a',
			'https://example.com/b',
		])
		// Swallow the eventual rejection so it doesn't surface as unhandled
		// while we're advancing timers.
		const rejection = p.catch((err) => err)
		await vi.advanceTimersByTimeAsync(5000)
		expect(signalAt(0).aborted).toBe(true)
		expect(signalAt(1).aborted).toBe(true)
		await expect(rejection).resolves.toMatchObject({ code: 'DOWNLOAD_ERROR' })
	})

	it('clears the connection timeout once a response arrives', async () => {
		vi.useFakeTimers()
		const p = secretStreamFetch(
			['https://example.com/a', 'https://example.com/b'] as const,
			{},
		)
		resolvers[0](new Response('ok'))
		await p
		// If the winner's timeout weren't cleared, advancing time would abort it.
		await vi.advanceTimersByTimeAsync(10000)
		expect(signalAt(0).aborted).toBe(false)
	})

	it('does not emit unhandled rejections when losers reject with AbortError', async () => {
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason)
		}
		process.on('unhandledRejection', onUnhandled)
		try {
			const p = secretStreamFetch([
				'https://example.com/a',
				'https://example.com/b',
				'https://example.com/c',
			])
			resolvers[0](new Response('ok'))
			await p
			// unhandledRejection fires at the end of a microtask checkpoint;
			// wait a couple of event-loop turns for it to surface.
			await setImmediateP()
			await setImmediateP()
			expect(unhandled).toEqual([])
		} finally {
			process.off('unhandledRejection', onUnhandled)
		}
	})
})
