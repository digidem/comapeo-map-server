import type { StyleSpecification as MaplibreStyleSpecification } from '@maplibre/maplibre-gl-style-spec'

const BASE_MAPBOX_API_URL = 'https://api.mapbox.com'

type MapboxURI = `mapbox://${string}`

type MapboxProjectionSpecification =
	| {
			name:
				| 'equalEarth'
				| 'equirectangular'
				| 'globe'
				| 'mercator'
				| 'naturalEarth'
				| 'winkelTripel'
	  }
	| {
			name: 'albers' | 'lambertConformalConic'
			center?: [number, number]
			parallels?: [number, number]
	  }

// Non-exhaustive alternative to what's provided in @mapbox/mapbox-gl-style-spec
export type MapboxStyleSpecification = Omit<
	MaplibreStyleSpecification,
	'projection'
> & {
	projection?: MapboxProjectionSpecification
}

/**
 * Updates a provided style to be compatible with MapLibre. Note that this mutates the input.
 * If it is preferable to preserve the original value, create a new value and use that for the input instead.
 *
 * @example
 * ```ts
 * const cloned = structuredClone(style)
 * const result = transformStyle(cloned)
 * ```
 */
export function normalizeStyle(
	style: MapboxStyleSpecification | MaplibreStyleSpecification,
	options?: { accessToken?: string },
): asserts style is MaplibreStyleSpecification {
	// Update sprite
	if (typeof style.sprite === 'string') {
		if (isMapboxURI(style.sprite)) {
			style.sprite = normalizeSprite(style.sprite, options?.accessToken)
		}
	} else if (Array.isArray(style.sprite)) {
		style.sprite = style.sprite.map((sprite) => {
			return isMapboxURI(sprite.url)
				? {
						id: sprite.id,
						url: normalizeSprite(sprite.url, options?.accessToken),
					}
				: sprite
		})
	}

	// Update glyphs
	if (style.glyphs && isMapboxURI(style.glyphs)) {
		style.glyphs = normalizeGlyphs(style.glyphs, options?.accessToken)
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
			}
		}
	}

	// As of 2026-03-30, the only values from Mapbox that port over are `mercator` and `globe`.
	// https://docs.mapbox.com/style-spec/reference/projection/#name
	// https://maplibre.org/maplibre-style-spec/types/#projectiondefinition
	if (style.projection && 'name' in style.projection) {
		if (
			style.projection.name === 'mercator' ||
			style.projection.name === 'globe'
		) {
			style.projection = { type: style.projection.name }
		} else {
			style.projection = undefined
		}
	}
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
