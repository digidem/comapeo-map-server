import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec'
import { describe, expect, it } from 'vitest'

import {
	transformStyle,
	type MapboxStyleSpecification,
} from '../src/lib/style.js'

describe('transformStyle()', () => {
	it('does nothing when input has no mapbox URIs', () => {
		const input: StyleSpecification = {
			version: 8,
			layers: [],
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

		const before = structuredClone(input)

		transformStyle(input)

		expect(input).toStrictEqual(before)
	})

	it('throws on bad inputs', () => {
		expect(
			() =>
				transformStyle({
					version: 8,
					sources: {},
					layers: [],
					glyphs: 'mapbox://foo/a/{fontstack}/{range}.pbf',
				}),
			'invalid glyphs URI',
		).toThrowError('Expected URL for font resource. Received foo')

		expect(
			() =>
				transformStyle({
					version: 8,
					sources: {},
					layers: [],
					glyphs: 'mapbox://fonts/a/{fontstack}/{range}.pbf',
					sprite: 'mapbox://foo/a/b',
				}),
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

		transformStyle(streetsV12)

		expect(streetsV12.glyphs).toStrictEqual(
			'https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf',
		)

		expect(streetsV12.sprite).toStrictEqual(
			'https://api.mapbox.com/styles/v1/mapbox/streets-v12/sprite',
		)

		expect(streetsV12.sources).toStrictEqual({
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

		transformStyle(streetsV12, { accessToken })

		expect(streetsV12.glyphs).toStrictEqual(
			'https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=abc_123',
		)

		expect(streetsV12.sprite).toStrictEqual(
			'https://api.mapbox.com/styles/v1/mapbox/streets-v12/sprite?access_token=abc_123',
		)

		expect(streetsV12.sources).toStrictEqual({
			composite: {
				type: 'vector',
				url: 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2,mapbox.mapbox-bathymetry-v2.json?access_token=abc_123',
			},
		})
	})

	it('ports projection property', async () => {
		const portableProjections = ['mercator', 'globe'] as const
		const nonportableProjections = [
			'equalEarth',
			'equirectangular',
			'naturalEarth',
			'winkelTripel',
		] as const

		for (const p of portableProjections) {
			const input: MapboxStyleSpecification = {
				version: 8,
				sources: {},
				layers: [],
				projection: { name: p },
			}

			transformStyle(input)

			expect(input.projection).toStrictEqual({ type: p })
		}

		for (const p of nonportableProjections) {
			const input: MapboxStyleSpecification = {
				version: 8,
				sources: {},
				layers: [],
				projection: { name: p },
			}

			transformStyle(input)

			expect(input.projection).toBeUndefined()
		}
	})
})
