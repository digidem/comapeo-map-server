import type { StyleSpecification as MapboxStyleSpecification } from '@mapbox/mapbox-gl-style-spec'
import type { StyleSpecification as MaplibreStyleSpecification } from '@maplibre/maplibre-gl-style-spec'

export const BASE_MAPBOX_API_URL = 'https://api.mapbox.com' as const

type MapboxURI = `mapbox://${string}`

/**
 * Updates a provided style to be compatible with MapLibre. Note that this mutates the input.
 * If it is preferable to preserve the original value, create a new value and use that for the input instead.
 *
 * @example
 * ```ts
 * const cloned = structuredClone(style)
 * const result = transformStyle(cloned)
 * ```
 *
 * @returns Boolean indicating if changes were made to the input.
 */
export function transformUrls(
	style: MapboxStyleSpecification | MaplibreStyleSpecification,
	options?: { accessToken?: string },
): boolean {
	let madeChanges = false

	// Update sprite
	if (typeof style.sprite === 'string') {
		if (isMapboxURI(style.sprite)) {
			style.sprite = normalizeSprite(style.sprite, options?.accessToken)
			madeChanges = true
		}
	} else if (Array.isArray(style.sprite)) {
		style.sprite = style.sprite.map((sprite) => {
			if (isMapboxURI(sprite.url)) {
				madeChanges = true

				return {
					id: sprite.id,
					url: normalizeSprite(sprite.url, options?.accessToken),
				}
			} else {
				return sprite
			}
		})
	}

	// Update glyphs
	if (style.glyphs && isMapboxURI(style.glyphs)) {
		style.glyphs = normalizeGlyphs(style.glyphs, options?.accessToken)
		madeChanges = true
	}

	// Update sources
	if (style.sources) {
		for (const sourceId of Object.keys(style.sources)) {
			const source = style.sources[sourceId]

			if (
				'url' in source &&
				typeof source.url === 'string' &&
				isMapboxURI(source.url)
			) {
				source.url = normalizeSource(source.url, options?.accessToken)
				madeChanges = true
			}
		}
	}

	return madeChanges
}

function isMapboxURI(url: string): url is MapboxURI {
	return new URL(url).protocol === 'mapbox:'
}

function normalizeGlyphs(uri: MapboxURI, accessToken?: string) {
	const u = new URL(uri)

	if (u.host !== 'fonts') {
		throw new Error(`Expected URL for font resource. Received ${u.host}`)
	}

	const result = new URL(`fonts/v1${u.pathname}`, BASE_MAPBOX_API_URL)

	if (accessToken) {
		result.searchParams.set('access_token', accessToken)
	}

	// Need to preserve the placeholders (`{}`) used by the clients
	return decodeURI(result.href)
}

function normalizeSprite(uri: MapboxURI, accessToken?: string) {
	const u = new URL(uri)

	if (u.host !== 'sprites') {
		throw new Error(`Expected URL for sprite resource. Received ${u.host}`)
	}

	const result = new URL(`styles/v1${u.pathname}/sprite`, BASE_MAPBOX_API_URL)

	if (accessToken) {
		result.searchParams.set('access_token', accessToken)
	}

	// Need to preserve the placeholders (`{}`) used by the clients
	return decodeURI(result.href)
}

function normalizeSource(uri: MapboxURI, accessToken?: string) {
	const u = new URL(uri)

	const tilesetId = u.host

	const result = new URL(`v4/${tilesetId}.json`, BASE_MAPBOX_API_URL)

	if (accessToken) {
		result.searchParams.set('access_token', accessToken)
	}

	return result.href
}
