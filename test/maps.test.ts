import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Reader } from 'styled-map-package'
import { describe, it, expect } from 'vitest'

import {
	DEMOTILES_Z2,
	goOffline,
	ONLINE_STYLE_URL,
	OSM_BRIGHT_Z6,
	startServer,
} from './helpers.js'

describe('Maps API', () => {
	it('should return 404 for unknown route (sanity check)', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/unknown-route`)
		expect(response.status).toBe(404)
	})

	it('should serve custom map style.json', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/maps/custom/style.json`)
		expect(response.status).toBe(200)
		const style = await response.json()
		expect(style).toHaveProperty('version')
		expect(style).toHaveProperty('sources')
		expect(style).toHaveProperty('layers')
	})

	it('should serve fallback map style.json', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/maps/fallback/style.json`)
		expect(response.status).toBe(200)
		const style = await response.json()
		expect(style).toHaveProperty('version')
		expect(style).toHaveProperty('sources')
		expect(style).toHaveProperty('layers')
	})

	it('should handle default map by redirecting to custom', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/maps/default/style.json`, {
			redirect: 'manual', // Don't follow redirects
		})
		expect(response.status).toBe(302)
		const location = response.headers.get('location')
		expect(location).toBeTruthy()
		expect(location).toContain('/maps/custom/style.json')
	})

	describe('Map Info Endpoints', () => {
		it('should return info for custom map', async (t) => {
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(`${localBaseUrl}/maps/custom/info`)
			expect(response.status).toBe(200)
			const info = await response.json()
			expect(info).toHaveProperty('created')
			expect(info).toHaveProperty('size')
			expect(info).toHaveProperty('name')
			expect(typeof info.created).toBe('number')
			expect(typeof info.size).toBe('number')
			expect(typeof info.name).toBe('string')
		})

		it('should return info for fallback map', async (t) => {
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(`${localBaseUrl}/maps/fallback/info`)
			expect(response.status).toBe(200)
			const info = await response.json()
			expect(info).toHaveProperty('created')
			expect(info).toHaveProperty('size')
			expect(info).toHaveProperty('name')
		})

		it('should return 404 for nonexistent map info', async (t) => {
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(`${localBaseUrl}/maps/nonexistent/info`)
			expect(response.status).toBe(404)
		})
	})

	describe('Tile Serving', () => {
		it('should handle tile requests to custom map', async (t) => {
			// Try to fetch a tile - it may or may not exist in the fixture
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(`${localBaseUrl}/maps/custom/0/0/0.pbf`)
			// Should return either 200 (tile exists) or 404 (tile doesn't exist), not 500
			expect([200, 404]).toContain(response.status)
			if (response.status === 200) {
				expect(response.headers.get('content-type')).toContain(
					'application/x-protobuf',
				)
			}
		})

		it('should handle tile requests to fallback map', async (t) => {
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(`${localBaseUrl}/maps/fallback/0/0/0.pbf`)
			// Should return either 200 (tile exists) or 404 (tile doesn't exist), not 500
			expect([200, 404]).toContain(response.status)
			if (response.status === 200) {
				expect(response.headers.get('content-type')).toContain(
					'application/x-protobuf',
				)
			}
		})

		it('should return 404 for tiles outside zoom range', async (t) => {
			// demotiles-z2 only goes to zoom 2
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(`${localBaseUrl}/maps/custom/10/512/512.pbf`)
			expect(response.status).toBe(404)
		})

		it('should handle sprite resource requests', async (t) => {
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(`${localBaseUrl}/maps/custom/sprite.json`)
			// Should either return the sprite or 404 if not present, not 500
			expect([200, 404]).toContain(response.status)
		})

		it('should serve glyphs with correct content-type', async (t) => {
			const { localBaseUrl } = await startServer(t)
			// Try to fetch glyphs - using a common font stack
			const response = await fetch(
				`${localBaseUrl}/maps/fallback/glyphs/Noto Sans Regular/0-255.pbf`,
			)
			// Glyphs may or may not exist, but should not 500
			expect([200, 404]).toContain(response.status)

			if (response.status === 200) {
				// Should have protobuf content-type
				const contentType = response.headers.get('content-type')
				expect(contentType).toContain('application/x-protobuf')
			}
		})

		it('should include content-length header for style.json', async (t) => {
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(`${localBaseUrl}/maps/custom/style.json`)
			expect(response.status).toBe(200)

			const contentLength = response.headers.get('content-length')
			expect(contentLength).toBeTruthy()

			// Verify content-length matches actual body length
			const body = await response.text()
			expect(parseInt(contentLength!)).toBe(
				new TextEncoder().encode(body).length,
			)
		})

		it('should include content-length header for tiles', async (t) => {
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(`${localBaseUrl}/maps/custom/0/0/0.pbf`)

			if (response.status === 200) {
				const contentLength = response.headers.get('content-length')
				expect(contentLength).toBeTruthy()

				// Verify content-length matches actual body length
				const arrayBuffer = await response.arrayBuffer()
				expect(parseInt(contentLength!)).toBe(arrayBuffer.byteLength)
			}
		})

		it('should handle gzip-encoded resources', async (t) => {
			// Glyphs are typically gzip-encoded
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(
				`${localBaseUrl}/maps/fallback/glyphs/Noto Sans Regular/0-255.pbf`,
			)

			if (response.status === 200) {
				const encoding = response.headers.get('content-encoding')
				// May be gzip, or may not be encoded - both are valid
				if (encoding) {
					expect(encoding).toBe('gzip')
				}
			}
		})
	})

	describe('Default Map Fallback Logic', () => {
		it('should follow redirect and serve custom map style', async (t) => {
			// Follow the redirect this time
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(`${localBaseUrl}/maps/default/style.json`)
			expect(response.status).toBe(200)
			const style = await response.json()
			expect(style).toHaveProperty('version')
		})

		it('should include CORS headers in redirect', async (t) => {
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(`${localBaseUrl}/maps/default/style.json`, {
				redirect: 'manual',
			})
			expect(response.headers.get('access-control-allow-origin')).toBe('*')
			expect(response.headers.get('cache-control')).toBe('no-cache')
		})
	})

	describe('Error Handling', () => {
		it('should return 404 for invalid map ID', async (t) => {
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(
				`${localBaseUrl}/maps/invalidmapid/style.json`,
			)
			expect(response.status).toBe(404)
		})

		it('should return 404 for invalid tile request', async (t) => {
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(
				`${localBaseUrl}/maps/custom/abc/def/ghi.pbf`,
			)
			expect(response.status).toBe(404)
		})

		it('should handle non-existent resources', async (t) => {
			const { localBaseUrl } = await startServer(t)
			const response = await fetch(
				`${localBaseUrl}/maps/custom/nonexistent-resource.json`,
			)
			expect(response.status).toBe(404)
		})
	})
})

describe('Online Style Fallback', () => {
	const nonExistentPath = path.join(
		os.tmpdir(),
		`nonexistent-map-${randomBytes(8).toString('hex')}.smp`,
	)

	it('should redirect to online map when custom map does not exist', async (t) => {
		const { localBaseUrl } = await startServer(t, {
			customMapPath: nonExistentPath,
		})
		// Request default map, which should redirect to online style or fallback since custom doesn't exist
		const response = await fetch(`${localBaseUrl}/maps/default/style.json`, {
			redirect: 'manual',
		})
		expect(response.status).toBe(302)
		const location = response.headers.get('location')
		expect(location).toContain(ONLINE_STYLE_URL)
	})

	it('should serve online style through default map fallback', async (t) => {
		const { localBaseUrl } = await startServer(t, {
			customMapPath: nonExistentPath,
		})
		const expected = await fetch(ONLINE_STYLE_URL).then((res) => res.json())
		// Follow the redirect to get the actual style
		const response = await fetch(`${localBaseUrl}/maps/default/style.json`)
		expect(response.status).toBe(200)
		const style = await response.json()
		// Verify it's the MapLibre demo tiles style
		expect(style).toEqual(expected)
	})

	it('should return 404 for custom map resources when map does not exist', async (t) => {
		const { localBaseUrl } = await startServer(t, {
			customMapPath: nonExistentPath,
		})
		// Directly requesting custom map that doesn't exist should return 404
		const response = await fetch(`${localBaseUrl}/maps/custom/style.json`)
		expect(response.status).toBe(404)
	})

	it('should include CORS headers in redirect to online style', async (t) => {
		const { localBaseUrl } = await startServer(t, {
			customMapPath: nonExistentPath,
		})
		const response = await fetch(`${localBaseUrl}/maps/default/style.json`, {
			redirect: 'manual',
		})
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		expect(response.headers.get('cache-control')).toBe('no-cache')
	})

	it('should still serve fallback map normally', async (t) => {
		const { localBaseUrl } = await startServer(t, {
			customMapPath: nonExistentPath,
		})
		const response = await fetch(`${localBaseUrl}/maps/fallback/style.json`)
		expect(response.status).toBe(200)
		const style = await response.json()
		expect(style).toHaveProperty('version')
		expect(style).toHaveProperty('sources')
	})
})

describe('Fallback Map Fallback', () => {
	const nonExistentPath = path.join(
		os.tmpdir(),
		`nonexistent-map-${randomBytes(8).toString('hex')}.smp`,
	)

	it('should redirect to fallback map when offline and custom map does not exist', async (t) => {
		const { localBaseUrl } = await startServer(t, {
			customMapPath: nonExistentPath,
		})
		goOffline(t)
		// Request default map, which should redirect to fallback since custom doesn't exist
		const response = await fetch(`${localBaseUrl}/maps/default/style.json`, {
			redirect: 'manual',
		})
		expect(response.status).toBe(302)
		const location = response.headers.get('location')
		expect(location).toContain('/maps/fallback/style.json')
	})

	it('should serve fallback map through default map fallback when offline and custom map does not exist', async (t) => {
		const { localBaseUrl } = await startServer(t, {
			customMapPath: nonExistentPath,
		})
		const expected = await fetch(
			`${localBaseUrl}/maps/fallback/style.json`,
		).then((res) => res.json())
		goOffline(t)
		// Follow the redirect to get the actual style
		const response = await fetch(`${localBaseUrl}/maps/default/style.json`)
		expect(response.status).toBe(200)
		const style = await response.json()
		expect(style).toEqual(expected)
	})
})

describe('Map Upload', () => {
	const nonExistentPath = path.join(
		os.tmpdir(),
		`nonexistent-map-${randomBytes(8).toString('hex')}.smp`,
	)

	it('should return 404 when custom map does not exist initially', async (t) => {
		const { localBaseUrl } = await startServer(t, {
			customMapPath: nonExistentPath,
		})
		// Custom map should not exist at start
		const response = await fetch(`${localBaseUrl}/maps/custom/style.json`)
		expect(response.status).toBe(404)
	})

	it('should upload a custom map after server initialization', async (t) => {
		const { localBaseUrl } = await startServer(t, {
			customMapPath: nonExistentPath,
			fallbackMapPath: DEMOTILES_Z2,
		})

		const initialResponse = await fetch(
			`${localBaseUrl}/maps/custom/style.json`,
		)
		expect(initialResponse.status).toBe(404)

		const reader = new Reader(fileURLToPath(OSM_BRIGHT_Z6))
		const expectedStyle = await reader.getStyle(
			new URL('/maps/custom/', localBaseUrl).toString(),
		)
		const fileBuffer = fs.readFileSync(OSM_BRIGHT_Z6)

		const uploadResponse = await fetch(`${localBaseUrl}/maps/custom`, {
			method: 'PUT',
			body: fileBuffer,
			headers: {
				'Content-Type': 'application/octet-stream',
			},
		})

		expect(uploadResponse.status).toBe(200)

		const styleResponse = await fetch(`${localBaseUrl}/maps/custom/style.json`)
		expect(styleResponse.status).toBe(200)
		const style = await styleResponse.json()
		expect(style).toEqual(expectedStyle)
	})

	it('should replace an existing custom map', async (t) => {
		const { localBaseUrl } = await startServer(t)
		// Get the current style
		const styleResponse1 = await fetch(`${localBaseUrl}/maps/custom/style.json`)
		const style1 = await styleResponse1.json()

		const reader = new Reader(fileURLToPath(DEMOTILES_Z2))
		const expectedStyle = await reader.getStyle(
			new URL('/maps/custom/', localBaseUrl).toString(),
		)

		expect(style1).not.toEqual(expectedStyle)

		// Upload a different map (osm-bright instead of demotiles)
		const fileBuffer = fs.readFileSync(DEMOTILES_Z2)

		const uploadResponse = await fetch(`${localBaseUrl}/maps/custom`, {
			method: 'PUT',
			body: fileBuffer,
			headers: {
				'Content-Type': 'application/octet-stream',
			},
		})

		expect(uploadResponse.status).toBe(200)

		// Verify the map was replaced by checking size changed
		const styleResponse2 = await fetch(`${localBaseUrl}/maps/custom/style.json`)
		const style2 = await styleResponse2.json()
		expect(style2).not.toEqual(style1)
		expect(style2).toEqual(expectedStyle)
	})

	it('should return 404 when trying to delete fallback map', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/maps/fallback`, {
			method: 'DELETE',
		})
		expect(response.status).toBe(404)
	})

	it('should return 404 when trying to delete default map', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/maps/default`, {
			method: 'DELETE',
		})
		expect(response.status).toBe(404)
	})

	it('should upload custom map again after deletion', async (t) => {
		const { localBaseUrl } = await startServer(t)

		const initialResponse = await fetch(
			`${localBaseUrl}/maps/custom/style.json`,
		)
		expect(initialResponse.status).toBe(200)

		await fetch(`${localBaseUrl}/maps/custom`, { method: 'DELETE' })

		const afterDeleteResponse = await fetch(
			`${localBaseUrl}/maps/custom/style.json`,
		)
		expect(afterDeleteResponse.status).toBe(404)

		const fileBuffer = fs.readFileSync(DEMOTILES_Z2)
		const reader = new Reader(fileURLToPath(DEMOTILES_Z2))
		const expectedStyle = await reader.getStyle(
			new URL('/maps/custom/', localBaseUrl).toString(),
		)

		const uploadResponse = await fetch(`${localBaseUrl}/maps/custom`, {
			method: 'PUT',
			body: fileBuffer,
			headers: {
				'Content-Type': 'application/octet-stream',
			},
		})

		expect(uploadResponse.status).toBe(200)

		// Verify it's accessible
		const styleResponse = await fetch(`${localBaseUrl}/maps/custom/style.json`)
		const style = await styleResponse.json()
		expect(style).toEqual(expectedStyle)
	})

	it('should handle concurrent upload attempts gracefully', async (t) => {
		const { localBaseUrl } = await startServer(t, {
			customMapPath: nonExistentPath,
		})
		// First file is the larger one, so theoretically it should take longer to
		// upload - without the line waiting for the current upload for a mapId to
		// complete, this test fails intermittently.
		const fileBuffer1 = fs.readFileSync(OSM_BRIGHT_Z6)
		const fileBuffer2 = fs.readFileSync(DEMOTILES_Z2)

		const reader = new Reader(fileURLToPath(DEMOTILES_Z2))
		const expectedStyle = await reader.getStyle(
			new URL('/maps/custom/', localBaseUrl).toString(),
		)
		// initially no custom map
		const initialResponse = await fetch(
			`${localBaseUrl}/maps/custom/style.json`,
		)
		expect(initialResponse.status).toBe(404)

		// Start two concurrent uploads
		const upload1 = fetch(`${localBaseUrl}/maps/custom`, {
			method: 'PUT',
			body: fileBuffer1,
			headers: {
				'Content-Type': 'application/octet-stream',
			},
		})

		await new Promise((resolve) => setTimeout(resolve, 10))

		const upload2 = fetch(`${localBaseUrl}/maps/custom`, {
			method: 'PUT',
			body: fileBuffer2,
			headers: {
				'Content-Type': 'application/octet-stream',
			},
		})

		const [response1, response2] = await Promise.all([upload1, upload2])

		// Both should succeed (one waits for the other)
		expect(response1.status).toBe(200)
		expect(response2.status).toBe(200)

		// Verify second upload's map is the one that exists
		const styleResponse = await fetch(`${localBaseUrl}/maps/custom/style.json`)
		const style = await styleResponse.json()
		expect(style).toEqual(expectedStyle)
	})
})

describe('Invalid Map Uploads', () => {
	it('should reject PUT with empty body', async (t) => {
		const { localBaseUrl } = await startServer(t)
		// Note: fetch() creates an empty ReadableStream for PUT with no body param
		// This is actually valid and will create an empty file
		const response = await fetch(`${localBaseUrl}/maps/custom`, {
			method: 'PUT',
		})

		expect(response.status).toBe(400)
	})
	it('should reject invalid map file upload', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const invalidBuffer = Buffer.from('this is not a valid styled map package')

		const response = await fetch(`${localBaseUrl}/maps/custom`, {
			method: 'PUT',
			body: invalidBuffer,
			headers: {
				'Content-Type': 'application/octet-stream',
			},
		})

		expect(response.status).toBe(400)
	})
})
