// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest'

import { createMapSharesRouter } from '../src/routes/map-shares.js'
import type { Context, MapInfo } from '../src/types.js'

describe('map-shares routes', () => {
	let mockContext: Context
	let router: ReturnType<typeof createMapSharesRouter>
	const baseUrl = 'http://localhost:3000/map-shares'

	const mockMapInfo: MapInfo = {
		mapId: 'test-map-id',
		mapName: 'Test Map',
		estimatedSizeBytes: 1024000,
		bounds: [-122.5, 37.5, -122.0, 38.0],
		minzoom: 0,
		maxzoom: 14,
	}

	beforeEach(() => {
		mockContext = {
			getMapInfo: vi.fn().mockResolvedValue(mockMapInfo),
			getMapReadableStream: vi.fn().mockReturnValue(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array([1, 2, 3, 4]))
						controller.close()
					},
				}),
			),
		}
		router = createMapSharesRouter({ base: '/map-shares' }, mockContext)
	})

	describe('POST /', () => {
		it('should create a new map share', async () => {
			const request = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const response = await router.fetch(request)
			expect(response.status).toBe(200)

			const data = await response.json()
			expect(data).toMatchObject({
				mapId: 'test-map-id',
				mapName: 'Test Map',
				receiverDeviceId: 'receiver-123',
				status: 'pending',
				estimatedSizeBytes: 1024000,
				bounds: [-122.5, 37.5, -122.0, 38.0],
				minzoom: 0,
				maxzoom: 14,
			})
			expect(data.shareId).toBeDefined()
			expect(typeof data.downloadUrl).toBe('string')
			expect(data.downloadUrl).toBeTruthy()
			expect(mockContext.getMapInfo).toHaveBeenCalledWith('test-map-id')
		})

		it('should return 400 for invalid request body', async () => {
			const request = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					// Missing required fields
					mapId: 'test-map-id',
				}),
			})

			const response = await router.fetch(request)
			expect(response.status).toBe(400)
		})

		it('should return 400 for malformed JSON', async () => {
			const request = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: 'invalid json',
			})

			const response = await router.fetch(request)
			expect(response.status).toBe(400)
		})
	})

	describe('GET /:shareId', () => {
		it('should return the state of an existing map share', async () => {
			// Create a map share first
			const createRequest = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const createResponse = await router.fetch(createRequest)
			const createdShare = await createResponse.json()

			// Get the map share state
			const getRequest = new Request(`${baseUrl}/${createdShare.shareId}`)
			const getResponse = await router.fetch(getRequest)

			expect(getResponse.status).toBe(200)
			const data = await getResponse.json()
			expect(data).toEqual(createdShare)
		})

		it('should return 404 for non-existent share ID', async () => {
			const request = new Request(`${baseUrl}/non-existent-id`)
			const response = await router.fetch(request)

			expect(response.status).toBe(404)
		})
	})

	describe('GET /:shareId/events', () => {
		it('should return an event stream with initial state', async () => {
			// Create a map share first
			const createRequest = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const createResponse = await router.fetch(createRequest)
			const createdShare = await createResponse.json()

			// Get the event stream
			const eventsRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/events`,
			)
			const eventsResponse = await router.fetch(eventsRequest)

			expect(eventsResponse.status).toBe(200)
			expect(eventsResponse.headers.get('Content-Type')).toBe(
				'text/event-stream',
			)
			expect(eventsResponse.headers.get('Cache-Control')).toBe('no-cache')
			expect(eventsResponse.headers.get('Connection')).toBe('keep-alive')

			// Read the first chunk of the stream
			const reader = eventsResponse.body!.getReader()
			const { value } = await reader.read()
			const text = new TextDecoder().decode(value)

			expect(text).toContain('data:')
			const jsonMatch = text.match(/data: ({.*})\n\n/)
			expect(jsonMatch).toBeTruthy()
			const data = JSON.parse(jsonMatch![1])
			expect(data.status).toBe('pending')

			reader.cancel()
		})

		it('should return 404 for non-existent share ID', async () => {
			const request = new Request(`${baseUrl}/non-existent-id/events`)
			const response = await router.fetch(request)

			expect(response.status).toBe(404)
		})
	})

	describe('GET /:shareId/download', () => {
		it('should start downloading and return a response with correct headers', async () => {
			// Create a map share first
			const createRequest = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const createResponse = await router.fetch(createRequest)
			const createdShare = await createResponse.json()

			// Start download
			const downloadRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/download`,
			)
			const downloadResponse = await router.fetch(downloadRequest)

			expect(downloadResponse.status).toBe(200)
			expect(downloadResponse.headers.get('Content-Disposition')).toBe(
				'attachment; filename="Test Map.smp"',
			)
			expect(downloadResponse.headers.get('Content-Type')).toBe(
				'application/zip',
			)
			expect(downloadResponse.body).toBeDefined()
			expect(mockContext.getMapReadableStream).toHaveBeenCalledWith(
				'test-map-id',
			)
		})

		it('should return 400 if download already in progress', async () => {
			// Create a map share first
			const createRequest = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const createResponse = await router.fetch(createRequest)
			const createdShare = await createResponse.json()

			// Start first download
			const downloadRequest1 = new Request(
				`${baseUrl}/${createdShare.shareId}/download`,
			)
			await router.fetch(downloadRequest1)

			// Try to start second download
			const downloadRequest2 = new Request(
				`${baseUrl}/${createdShare.shareId}/download`,
			)
			const downloadResponse2 = await router.fetch(downloadRequest2)

			expect(downloadResponse2.status).toBe(400)
		})

		it('should return 400 if map share has been declined', async () => {
			// Create a map share first
			const createRequest = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const createResponse = await router.fetch(createRequest)
			const createdShare = await createResponse.json()

			// Decline the map share
			const declineRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/decline`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ reason: 'user_rejected' }),
				},
			)
			await router.fetch(declineRequest)

			// Try to download
			const downloadRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/download`,
			)
			const downloadResponse = await router.fetch(downloadRequest)

			expect(downloadResponse.status).toBe(400)
		})

		it('should return 404 for non-existent share ID', async () => {
			const request = new Request(`${baseUrl}/non-existent-id/download`)
			const response = await router.fetch(request)

			expect(response.status).toBe(404)
		})
	})

	describe('POST /:shareId/cancel', () => {
		it('should cancel a pending map share', async () => {
			// Create a map share first
			const createRequest = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const createResponse = await router.fetch(createRequest)
			const createdShare = await createResponse.json()

			// Cancel the map share
			const cancelRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/cancel`,
				{
					method: 'POST',
				},
			)
			const cancelResponse = await router.fetch(cancelRequest)

			expect(cancelResponse.status).toBe(204)

			// Verify state is canceled
			const getRequest = new Request(`${baseUrl}/${createdShare.shareId}`)
			const getResponse = await router.fetch(getRequest)
			const data = await getResponse.json()
			expect(data.status).toBe('canceled')
		})

		it('should return 400 when cancelling a completed download', async () => {
			// Create a map share and complete download
			const createRequest = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const createResponse = await router.fetch(createRequest)
			const createdShare = await createResponse.json()

			// Start and complete download
			const downloadRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/download`,
			)
			const downloadResponse = await router.fetch(downloadRequest)
			const reader = downloadResponse.body!.getReader()
			// eslint-disable-next-line no-empty
			while (!(await reader.read()).done) {}

			// Wait a bit for the download to complete
			await new Promise((resolve) => setTimeout(resolve, 10))

			// Try to cancel
			const cancelRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/cancel`,
				{
					method: 'POST',
				},
			)
			const cancelResponse = await router.fetch(cancelRequest)

			expect(cancelResponse.status).toBe(400)
		})

		it('should return 404 for non-existent share ID', async () => {
			const request = new Request(`${baseUrl}/non-existent-id/cancel`, {
				method: 'POST',
			})
			const response = await router.fetch(request)

			expect(response.status).toBe(404)
		})
	})

	describe('POST /:shareId/decline', () => {
		it('should decline a pending map share with user_rejected reason', async () => {
			// Create a map share first
			const createRequest = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const createResponse = await router.fetch(createRequest)
			const createdShare = await createResponse.json()

			// Decline the map share
			const declineRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/decline`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ reason: 'user_rejected' }),
				},
			)
			const declineResponse = await router.fetch(declineRequest)

			expect(declineResponse.status).toBe(204)

			// Verify state is declined
			const getRequest = new Request(`${baseUrl}/${createdShare.shareId}`)
			const getResponse = await router.fetch(getRequest)
			const data = await getResponse.json()
			expect(data.status).toBe('declined')
			expect(data.reason).toBe('user_rejected')
		})

		it('should decline a pending map share with disk_full reason', async () => {
			// Create a map share first
			const createRequest = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const createResponse = await router.fetch(createRequest)
			const createdShare = await createResponse.json()

			// Decline the map share
			const declineRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/decline`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ reason: 'disk_full' }),
				},
			)
			const declineResponse = await router.fetch(declineRequest)

			expect(declineResponse.status).toBe(204)

			// Verify state is declined with correct reason
			const getRequest = new Request(`${baseUrl}/${createdShare.shareId}`)
			const getResponse = await router.fetch(getRequest)
			const data = await getResponse.json()
			expect(data.status).toBe('declined')
			expect(data.reason).toBe('disk_full')
		})

		it('should decline a pending map share with custom reason', async () => {
			// Create a map share first
			const createRequest = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const createResponse = await router.fetch(createRequest)
			const createdShare = await createResponse.json()

			// Decline the map share with custom reason
			const declineRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/decline`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ reason: 'custom reason for declining' }),
				},
			)
			const declineResponse = await router.fetch(declineRequest)

			expect(declineResponse.status).toBe(204)

			// Verify state is declined with custom reason
			const getRequest = new Request(`${baseUrl}/${createdShare.shareId}`)
			const getResponse = await router.fetch(getRequest)
			const data = await getResponse.json()
			expect(data.status).toBe('declined')
			expect(data.reason).toBe('custom reason for declining')
		})

		it('should return 400 when declining a non-pending map share', async () => {
			// Create a map share first
			const createRequest = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const createResponse = await router.fetch(createRequest)
			const createdShare = await createResponse.json()

			// Cancel to change status from pending
			const cancelRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/cancel`,
				{
					method: 'POST',
				},
			)
			await router.fetch(cancelRequest)

			// Try to decline
			const declineRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/decline`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ reason: 'user_rejected' }),
				},
			)
			const declineResponse = await router.fetch(declineRequest)

			expect(declineResponse.status).toBe(400)
		})

		it('should return 400 for invalid request body', async () => {
			// Create a map share first
			const createRequest = new Request(`${baseUrl}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'test-map-id',
					receiverDeviceId: 'receiver-123',
				}),
			})

			const createResponse = await router.fetch(createRequest)
			const createdShare = await createResponse.json()

			// Try to decline without reason
			const declineRequest = new Request(
				`${baseUrl}/${createdShare.shareId}/decline`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({}),
				},
			)
			const declineResponse = await router.fetch(declineRequest)

			expect(declineResponse.status).toBe(400)
		})

		it('should return 404 for non-existent share ID', async () => {
			const request = new Request(`${baseUrl}/non-existent-id/decline`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'user_rejected' }),
			})
			const response = await router.fetch(request)

			expect(response.status).toBe(404)
		})
	})
})
