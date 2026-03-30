import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec'

const BASE_MAPBOX_API_URL = 'https://api.mapbox.com'

type MapboxURI = `mapbox://${string}`

export function transformMapboxStyle(
	inputStyle: StyleSpecification,
	accessToken?: string,
): StyleSpecification {
	const outputStyle = structuredClone(inputStyle)

	// Update sprite
	if (typeof outputStyle.sprite === 'string') {
		if (isMapboxURI(outputStyle.sprite)) {
			outputStyle.sprite = normalizeSprite(outputStyle.sprite, accessToken)
		}
	} else if (Array.isArray(outputStyle.sprite)) {
		outputStyle.sprite = outputStyle.sprite.map((sprite) => {
			return isMapboxURI(sprite.url)
				? {
						id: sprite.id,
						url: normalizeSprite(sprite.url, accessToken),
					}
				: sprite
		})
	}

	// Update glyphs
	if (outputStyle.glyphs && isMapboxURI(outputStyle.glyphs)) {
		outputStyle.glyphs = normalizeGlyphs(outputStyle.glyphs, accessToken)
	}

	// Update sources
	if (outputStyle.sources) {
		for (const sourceId of Object.keys(outputStyle.sources)) {
			const source = outputStyle.sources[sourceId]

			if (
				'url' in source &&
				typeof source.url === 'string' &&
				isMapboxURI(source.url)
			) {
				source.url = normalizeSource(source.url, accessToken)
			}
		}
	}

	return outputStyle
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
