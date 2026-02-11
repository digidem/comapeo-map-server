import { describe, it, expect } from 'vitest'

import { startServer } from './helpers.js'

describe('CORS Headers', () => {
	it('should include CORS headers on GET requests', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/maps/custom/style.json`)
		expect(response.status).toBe(200)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
	})

	it('should include CORS headers on 404 responses', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/unknown-route`)
		expect(response.status).toBe(404)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
	})

	it('should include CORS headers on error responses', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/maps/custom`, {
			method: 'PUT',
			body: Buffer.from('invalid'),
			headers: { 'Content-Type': 'application/octet-stream' },
		})
		expect(response.status).toBe(400)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
	})

	it('should handle OPTIONS preflight requests', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/maps/custom/style.json`, {
			method: 'OPTIONS',
		})
		expect(response.status).toBe(204)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		expect(response.headers.get('access-control-allow-methods')).toBe(
			'GET,POST,DELETE,OPTIONS',
		)
		expect(response.headers.get('access-control-allow-headers')).toBe(
			'Content-Type',
		)
	})

	it('should handle OPTIONS preflight for POST endpoints', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/mapShares`, {
			method: 'OPTIONS',
		})
		expect(response.status).toBe(204)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		expect(response.headers.get('access-control-allow-methods')).toBe(
			'GET,POST,DELETE,OPTIONS',
		)
	})

	it('should handle OPTIONS preflight for DELETE endpoints', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/maps/custom`, {
			method: 'OPTIONS',
		})
		expect(response.status).toBe(204)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		expect(response.headers.get('access-control-allow-methods')).toBe(
			'GET,POST,DELETE,OPTIONS',
		)
	})

	it('should include CORS headers on POST responses', async (t) => {
		const { localBaseUrl } = await startServer(t)
		// This will fail validation, but should still have CORS headers
		const response = await fetch(`${localBaseUrl}/mapShares`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		})
		// 400 due to missing required fields
		expect(response.status).toBe(400)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
	})

	it('should include CORS headers on DELETE responses', async (t) => {
		const { localBaseUrl } = await startServer(t)
		const response = await fetch(`${localBaseUrl}/maps/custom`, {
			method: 'DELETE',
		})
		expect(response.status).toBe(204)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
	})
})
