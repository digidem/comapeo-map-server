/**
 * Leading-edge throttle: the first call fires immediately, subsequent calls
 * within `wait` ms are coalesced and dispatched on a trailing edge once the
 * window expires.
 *
 * The returned function exposes `flush()` to dispatch any pending call
 * immediately and `cancel()` to discard it.
 */
export function throttle<A extends readonly unknown[]>(
	fn: (...args: A) => void,
	wait: number,
): ((...args: A) => void) & { flush(): void; cancel(): void } {
	let lastDispatchedAt = 0
	let timer: ReturnType<typeof setTimeout> | undefined
	let pendingArgs: A | undefined

	const flush = () => {
		if (timer !== undefined) {
			clearTimeout(timer)
			timer = undefined
		}
		if (!pendingArgs) return
		const args = pendingArgs
		pendingArgs = undefined
		lastDispatchedAt = Date.now()
		fn(...args)
	}

	const throttled = (...args: A) => {
		pendingArgs = args
		if (timer !== undefined) return
		const remaining = wait - (Date.now() - lastDispatchedAt)
		if (remaining <= 0) {
			flush()
		} else {
			timer = setTimeout(flush, remaining)
		}
	}

	throttled.flush = flush
	throttled.cancel = () => {
		if (timer !== undefined) {
			clearTimeout(timer)
			timer = undefined
		}
		pendingArgs = undefined
	}

	return throttled
}
