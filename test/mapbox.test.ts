import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec'
import { describe, it, expect } from 'vitest'

import { transformMapboxStyle } from '../src/lib/mapbox.js'

describe('transformMapboxStyle()', () => {
	it('does nothing when input has no mapbox URIs', () => {
		// @ts-expect-error
		const input: StyleSpecification = {
			glyphs: 'https://example.com/glyphs',
			sprite: 'https://example.com/sprite',
			sources: {
				a: {
					type: 'raster',
					url: 'https://example.com/raster',
				},
				b: {
					type: 'vector',
					tiles: ['https://example.com/vector'],
				},
			},
		}

		const result = transformMapboxStyle(input)

		expect(result).toStrictEqual(input)
	})

	it('throws on bad inputs', () => {
		expect(
			() =>
				transformMapboxStyle(
					// @ts-expect-error
					{ glyphs: 'mapbox://foo/a/{fontstack}/{range}.pbf' },
				),
			'invalid glyphs URI',
		).toThrowError('Expected URL for font resource. Received foo')

		expect(
			() =>
				transformMapboxStyle(
					// @ts-expect-error
					{
						glyphs: 'mapbox://fonts/a/{fontstack}/{range}.pbf',
						sprite: 'mapbox://foo/a/b',
					},
				),
			'invalid sprite URI',
		).toThrowError('Expected URL for sprite resource. Received foo')
	})

	it('transforms mapbox URIs', () => {
		const streetsV12 = JSON.parse(
			readFileSync(
				fileURLToPath(
					new URL('./fixtures/mapbox-streets-v12.json', import.meta.url),
				),
				'utf-8',
			),
		)

		const result = transformMapboxStyle(streetsV12)

		expect(result.glyphs).toStrictEqual(
			'https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf',
		)

		expect(result.sprite).toStrictEqual(
			'https://api.mapbox.com/styles/v1/mapbox/streets-v12/sprite',
		)

		expect(result.sources).toStrictEqual({
			composite: {
				type: 'vector',
				url: 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2,mapbox.mapbox-bathymetry-v2.json',
			},
		})
	})

	it('appends access token', () => {
		const streetsV12 = JSON.parse(
			readFileSync(
				fileURLToPath(
					new URL('./fixtures/mapbox-streets-v12.json', import.meta.url),
				),
				'utf-8',
			),
		)

		const accessToken = 'abc_123'

		const result = transformMapboxStyle(streetsV12, accessToken)

		expect(result.glyphs).toStrictEqual(
			'https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=abc_123',
		)

		expect(result.sprite).toStrictEqual(
			'https://api.mapbox.com/styles/v1/mapbox/streets-v12/sprite?access_token=abc_123',
		)

		expect(result.sources).toStrictEqual({
			composite: {
				type: 'vector',
				url: 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2,mapbox.mapbox-bathymetry-v2.json?access_token=abc_123',
			},
		})
	})
})
