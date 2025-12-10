import crypto from 'node:crypto'

import { randomBytes } from 'crypto'
import z32 from 'z32'

/**
 * If the argument is an `Error` instance, return its `code` property if it is a string.
 * Otherwise, returns `undefined`.
 *
 * @param {unknown} maybeError
 * @returns {undefined | string}
 * @example
 * try {
 *   // do something
 * } catch (err) {
 *   console.error(getErrorCode(err))
 * }
 */
export function getErrorCode(maybeError: unknown) {
	if (
		maybeError instanceof Error &&
		'code' in maybeError &&
		typeof maybeError.code === 'string'
	) {
		return maybeError.code
	}
	return undefined
}

export function noop() {}

export function generateId() {
	return z32.encode(randomBytes(8))
}

export function getOrInsert<K, V>(map: Map<K, V>, key: K, value: V): V {
	if (map.has(key)) {
		return map.get(key)!
	}
	map.set(key, value)
	return value
}

export function timingSafeEqual(a: string, b: string): boolean {
	const aBuf = Buffer.from(a)
	const bBuf = Buffer.from(b)
	if (aBuf.length !== bBuf.length) {
		return false
	}
	return crypto.timingSafeEqual(aBuf, bBuf)
}
