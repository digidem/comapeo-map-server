import crypto from 'node:crypto'

import { randomBytes } from 'crypto'
import type { SMPStyle } from 'styled-map-package'
import z32 from 'z32'

import type { BBox } from '../types.js'

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

/**
 * Returns a bbox that is the smallest bounding box that contains all the input bboxes.
 *
 * @param bboxes
 * @returns Bounding Box [w, s, e, n] of all input bboxes
 */
export function unionBBox(bboxes: [BBox, ...BBox[]]): BBox {
	let [w, s, e, n] = bboxes[0]
	for (let i = 1; i < bboxes.length; i++) {
		const [w1, s1, e1, n1] = bboxes[i]
		w = Math.min(w, w1)
		s = Math.min(s, s1)
		e = Math.max(e, e1)
		n = Math.max(n, n1)
	}
	return [w, s, e, n]
}

export function getStyleBbox(style: SMPStyle): BBox {
	const sourceBboxes: BBox[] = []
	for (const source of Object.values(style.sources)) {
		if (!('bounds' in source)) continue
		sourceBboxes.push(source.bounds)
	}
	if (!isNonEmptyArray(sourceBboxes)) {
		return [-180, -85.0511, 180, 85.0511]
	}
	return unionBBox(sourceBboxes)
}

export function getStyleMaxZoom(style: SMPStyle): number {
	let maxzoom = -1
	for (const source of Object.values(style.sources)) {
		if (!('maxzoom' in source)) continue
		maxzoom = Math.max(maxzoom, source.maxzoom ?? -1)
	}
	return maxzoom === -1 ? 22 : maxzoom
}

export function getStyleMinZoom(style: SMPStyle): number {
	let minzoom = 99
	for (const source of Object.values(style.sources)) {
		if (!('minzoom' in source)) continue
		minzoom = Math.min(minzoom, source.minzoom ?? 99)
	}
	return minzoom === 99 ? 0 : minzoom
}

function isNonEmptyArray<T>(arr: T[]): arr is [T, ...T[]] {
	return arr.length > 0
}

export function addTrailingSlash(url: string): string {
	return url.endsWith('/') ? url : url + '/'
}

// Typescript's Array.isArray definition does not work as a type guard for
// readonly arrays, so we need to define our own type guard for that
export function isArrayReadonly<T, U>(
	value: U | readonly T[],
): value is readonly T[] {
	return Array.isArray(value)
}
