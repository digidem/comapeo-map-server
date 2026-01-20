import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
	createEventSource,
	type EventSourceClient,
	type EventSourceMessage,
} from 'eventsource-client'
import ky from 'ky'
import {
	fetch as secretStreamFetch,
	Agent as SecretStreamAgent,
} from 'secret-stream-http'
import { describe, it, expect } from 'vitest'
import z32 from 'z32'

import type { MapShareState } from '../src/types.js'
import { DEMOTILES_Z2, OSM_BRIGHT_Z6, startServers } from './helpers.js'

describe('Map Shares and Downloads', () => {
	describe('Map Shares (Sender)', () => {
		it('should create a map share', async (t) => {
			const { createShare } = await startServers(t)
			const response = await createShare()
			expect(response.status).toBe(201)

			const timeBeforeRequest = Date.now() - 10
			const share = await response.json()
			const {
				shareId,
				mapShareCreated,
				mapCreated,
				mapShareUrls,
				...deterministic
			} = share as MapShareState
			expect(deterministic).toMatchSnapshot()
			expect(mapShareCreated).toBeGreaterThanOrEqual(timeBeforeRequest)
			expect(mapShareCreated).toBeLessThanOrEqual(Date.now())
			expect(mapShareUrls.length).toBeGreaterThanOrEqual(1)
			expect(mapShareUrls[0]).toMatch(`/mapShares/${shareId}`)
			expect(share).toHaveProperty('status', 'pending')

			// Check Location header points to the new share
			const location = response.headers.get('location')
			const response2 = await fetch(location!)
			const shareFromLocationHeader = await response2.json()
			expect(shareFromLocationHeader).toEqual(share)
		})

		it('should list all map shares', async (t) => {
			const { sender, createShare } = await startServers(t)
			const share = await createShare().json()
			const shares = await sender.get('mapShares').json()
			expect(shares).toEqual([share])
		})

		it('should get a specific map share', async (t) => {
			const { sender, createShare } = await startServers(t)
			const expectedShare = await createShare().json()
			const share = await sender
				.get(`mapShares/${expectedShare.shareId}`)
				.json()
			expect(share).toEqual(expectedShare)
		})

		it('should return 404 for non-existent share', async (t) => {
			const { sender } = await startServers(t)
			const response = await sender.get(`mapShares/nonexistent-share-id`)
			expect(response.status).toBe(404)
		})

		it('should cancel a map share before download', async (t) => {
			const { sender, createShare } = await startServers(t)
			const { shareId } = await createShare().json()

			// Cancel it
			const cancelResponse = await sender.post(`mapShares/${shareId}/cancel`)
			expect(cancelResponse.status).toBe(204)

			// Verify it's cancelled
			const share = await sender.get(`mapShares/${shareId}`).json<any>()
			expect(share.status).toBe('canceled')
		})

		it('should decline a map share from receiver', async (t) => {
			const { sender, createShare, receiver, senderDeviceId } =
				await startServers(t)
			const { shareId, mapShareUrls } = await createShare().json()

			// Decline it
			const declineResponse = await receiver.post(
				`mapShares/${shareId}/decline`,
				{
					json: {
						reason: 'user_rejected',
						senderDeviceId,
						mapShareUrls,
					},
				},
			)
			expect(declineResponse.status).toBe(204)

			// Verify it's declined
			const share = await sender.get(`mapShares/${shareId}`).json<any>()
			expect(share.status).toBe('declined')
			expect(share.reason).toBe('user_rejected')
		})
	})

	describe('Downloads (Receiver)', () => {
		it('can download map share and get events on sender and receiver', async (t) => {
			const {
				sender,
				receiver,
				createShare,
				senderDeviceId,
				receiverLocalBaseUrl,
				senderLocalBaseUrl,
			} = await startServers(t, {
				senderOptions: { customMapPath: OSM_BRIGHT_Z6 },
				receiverOptions: { customMapPath: DEMOTILES_Z2 },
			})

			const initialSenderStyle = await sender
				.get(`maps/custom/style.json`)
				.json()
			const initialReceiverStyle = await receiver
				.get(`maps/custom/style.json`)
				.json()
			expect(comparableStyle(initialSenderStyle)).not.toEqual(
				comparableStyle(initialReceiverStyle),
			)

			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			// Now create a download on the receiver using the real share
			const response = await receiver.post(`downloads`, {
				json: {
					senderDeviceId,
					shareId,
					mapShareUrls,
					estimatedSizeBytes,
				},
			})
			expect(response.status).toBe(201)

			const download = await response.json<any>()
			expect(download).toHaveProperty('downloadId')
			expect(download).toHaveProperty('status', 'downloading')
			expect(download).toHaveProperty('bytesDownloaded', 0)
			expect(download).toHaveProperty('senderDeviceId', senderDeviceId)

			// Check Location header
			const location = response.headers.get('location')
			const downloadFromLocation = await ky.get(location!).json()
			expect(downloadFromLocation).toEqual(download)

			const receiverEs = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${download.downloadId}/events`,
			)
			const senderEs = createEventSource(
				`${senderLocalBaseUrl}/mapShares/${shareId}/events`,
			)
			const [receiverEvents, senderEvents] = await Promise.all([
				eventsUntil(receiverEs, 'completed'),
				eventsUntil(senderEs, 'completed'),
			])
			receiverEs.close()
			senderEs.close()

			expect(receiverEvents.at(-2)).toHaveProperty(
				'bytesDownloaded',
				estimatedSizeBytes,
			)
			expect(senderEvents.at(-2)).toHaveProperty(
				'bytesDownloaded',
				estimatedSizeBytes,
			)
			expect(receiverEvents.length).toBeGreaterThan(3) // At least some progress events
			const finalReceiverStyle = await receiver
				.get(`maps/custom/style.json`)
				.json()
			// receiver should not have the same style as sender
			expect(comparableStyle(finalReceiverStyle)).toEqual(
				comparableStyle(initialSenderStyle),
			)
		})

		it('should list all downloads', async (t) => {
			const { senderDeviceId, createShare, receiver, receiverLocalBaseUrl } =
				await startServers(t)
			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			// Now create a download on the receiver using the real share
			const download = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()
			const downloads = await receiver.get(`downloads`).json()
			expect(downloads).toEqual([download])
			// Wait for download to complete to clean up background connections
			const ee = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${download.downloadId}/events`,
			)
			await eventsUntil(ee, 'completed')
		})

		it('should get a specific download', async (t) => {
			const { senderDeviceId, createShare, receiver, receiverLocalBaseUrl } =
				await startServers(t)
			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			const download = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()
			const downloadDetails = await receiver
				.get(`downloads/${download.downloadId}`)
				.json()
			expect(downloadDetails).toEqual(download)
			// Wait for download to complete to clean up background connections
			const ee = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${download.downloadId}/events`,
			)
			await eventsUntil(ee, 'completed')
		})

		it('should return 404 for non-existent download', async (t) => {
			const { receiver } = await startServers(t.onTestFinished)
			const response = await receiver.get(`downloads/nonexistent-download-id`)
			expect(response.status).toBe(404)
		})
	})

	describe('Localhost-Only Protection', () => {
		it('should reject map share creation from non-localhost', async (t) => {
			const { senderRemoteBaseUrl, receiverDeviceId } = await startServers(t)
			const response = await secretStreamFetch(
				`${senderRemoteBaseUrl}/mapShares`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						mapId: 'custom',
						receiverDeviceId,
					}),
				},
			)
			expect(response.status).toBe(403)
		})

		it('should reject download creation from non-localhost', async (t) => {
			const { receiverRemoteBaseUrl, senderDeviceId } = await startServers(t)

			const response = await secretStreamFetch(
				`${receiverRemoteBaseUrl}/downloads`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						senderDeviceId,
						shareId: 'test-share',
						mapShareUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					}),
				},
			)

			expect(response.status).toBe(403)
		})

		it('should reject canceling map share from non-localhost', async (t) => {
			const { senderRemoteBaseUrl, createShare } = await startServers(t)
			const { shareId } = await createShare().json()
			const response = await secretStreamFetch(
				`${senderRemoteBaseUrl}/mapShares/${shareId}/cancel`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
				},
			)

			expect(response.status).toBe(403)
		})

		it('should reject listing map shares from non-localhost', async (t) => {
			const { senderRemoteBaseUrl } = await startServers(t)
			const response = await secretStreamFetch(
				`${senderRemoteBaseUrl}/mapShares`,
				{
					method: 'GET',
					headers: {
						'Content-Type': 'application/json',
					},
				},
			)

			expect(response.status).toBe(403)
		})

		it('should reject getting map share events from non-localhost', async (t) => {
			const { senderRemoteBaseUrl, createShare } = await startServers(t)
			const { shareId } = await createShare().json()
			const response = await secretStreamFetch(
				`${senderRemoteBaseUrl}/mapShares/${shareId}/events`,
			)
			expect(response.status).toBe(403)
		})

		it('should reject downloads GET routes from non-localhost', async (t) => {
			const { receiverRemoteBaseUrl, receiver, createShare, senderDeviceId } =
				await startServers(t)
			const { shareId, mapShareUrls } = await createShare().json()
			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes: 1000,
					},
				})
				.json<any>()

			const responsePromises = []
			for (const route of [
				`downloads`,
				`downloads/${downloadId}`,
				`downloads/${downloadId}/events`,
			]) {
				responsePromises.push(
					secretStreamFetch(`${receiverRemoteBaseUrl}/${route}`),
				)
			}
			const responses = await Promise.all(responsePromises)
			for (const response of responses) {
				expect(response.status).toBe(403)
			}

			// Abort download to clean up background connections
			await receiver.post(`downloads/${downloadId}/abort`)
		})
		it('should reject canceling download from non-localhost', async (t) => {
			const { receiverRemoteBaseUrl, receiver, createShare, senderDeviceId } =
				await startServers(t)
			const { shareId, mapShareUrls } = await createShare().json()
			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes: 1000,
					},
				})
				.json<any>()
			const response = await secretStreamFetch(
				`${receiverRemoteBaseUrl}/downloads/${downloadId}/cancel`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
				},
			)
			expect(response.status).toBe(403)

			// Abort download to clean up background connections
			await receiver.post(`downloads/${downloadId}/abort`)
		})
	})

	describe('Validation', () => {
		describe('Map Share Validation', () => {
			it('should reject map share with invalid body', async (t) => {
				const { sender, receiverDeviceId } = await startServers(t)
				const invalidBodies = [
					{
						// Missing receiverDeviceId
						mapId: 'custom',
					},
					{
						// Missing mapId
						receiverDeviceId,
					},
					{
						// Invalid type for mapId
						mapId: 123,
						receiverDeviceId,
					},
					{
						// Invalid type for receiverDeviceId
						mapId: 'custom',
						receiverDeviceId: 123,
					},
					{
						// Empty strings
						mapId: '',
						receiverDeviceId: '',
					},
					{
						// Null values
						mapId: null,
						receiverDeviceId: null,
					},
				]
				for (const json of invalidBodies) {
					const response = await sender.post('mapShares', {
						json,
					})

					expect(response.status).toBe(400)
				}
			})

			it('should reject map share for non-existent map', async (t) => {
				const { sender, receiverDeviceId } = await startServers(t)
				const response = await sender.post('mapShares', {
					json: {
						mapId: 'nonexistent-map',
						receiverDeviceId,
					},
				})

				expect(response.status).toBe(404)
			})

			it('should reject decline with invalid body (localhost)', async (t) => {
				const { receiver, createShare, senderDeviceId } = await startServers(t)
				const { shareId, mapShareUrls } = await createShare().json()

				const invalidBodies = [
					{
						// Missing senderDeviceId and mapShareUrls
						reason: 'user_rejected',
					},
					{
						// Missing mapShareUrls
						reason: 'user_rejected',
						senderDeviceId,
					},
					{
						// Missing senderDeviceId
						reason: 'user_rejected',
						mapShareUrls,
					},
					{
						// Missing reason
						senderDeviceId,
						mapShareUrls,
					},
					{
						// Invalid type for reason
						reason: 123,
						senderDeviceId,
						mapShareUrls,
					},
					{
						// Invalid type for senderDeviceId
						reason: 'user_rejected',
						senderDeviceId: 123,
						mapShareUrls,
					},
					{
						// Invalid type for mapShareUrls (not array)
						reason: 'user_rejected',
						senderDeviceId,
						mapShareUrls: 'not-an-array',
					},
					{
						// Empty mapShareUrls array
						reason: 'user_rejected',
						senderDeviceId,
						mapShareUrls: [],
					},
					{
						// Invalid URLs in mapShareUrls
						reason: 'user_rejected',
						senderDeviceId,
						mapShareUrls: ['not-a-url'],
					},
				]

				for (const json of invalidBodies) {
					const response = await receiver.post(`mapShares/${shareId}/decline`, {
						json,
					})

					expect(response.status).toBe(400)
				}
			})
		})

		describe('Download Validation', () => {
			it('should reject download with invalid body', async (t) => {
				const { receiver, senderDeviceId } = await startServers(t)
				const invalidBodies = [
					{
						// Missing senderDeviceId
						shareId: 'test-share',
						mapShareUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					},
					{
						// Missing shareId
						senderDeviceId,
						mapShareUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					},
					{
						// Missing mapShareUrls
						senderDeviceId,
						shareId: 'test-share',
						estimatedSizeBytes: 1000,
					},
					{
						// Missing estimatedSizeBytes
						senderDeviceId,
						shareId: 'test-share',
						mapShareUrls: ['http://example.com/download'],
					},
					{
						// Invalid type for senderDeviceId
						senderDeviceId: 123,
						shareId: 'test-share',
						mapShareUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					},
					{
						// Invalid type for shareId
						senderDeviceId,
						shareId: 123,
						mapShareUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					},
					{
						// Invalid type for mapShareUrls (not array)
						senderDeviceId,
						shareId: 'test-share',
						mapShareUrls: 'not-an-array',
						estimatedSizeBytes: 1000,
					},
					{
						// Empty mapShareUrls array
						senderDeviceId,
						shareId: 'test-share',
						mapShareUrls: [],
						estimatedSizeBytes: 1000,
					},
					{
						// Invalid URLs in mapShareUrls
						senderDeviceId,
						shareId: 'test-share',
						mapShareUrls: ['not-a-url'],
						estimatedSizeBytes: 1000,
					},
					{
						// Invalid type for estimatedSizeBytes
						senderDeviceId,
						shareId: 'test-share',
						mapShareUrls: ['http://example.com/download'],
						estimatedSizeBytes: 'not-a-number',
					},
					{
						// Null values
						senderDeviceId: null,
						shareId: null,
						mapShareUrls: null,
						estimatedSizeBytes: null,
					},
				]

				for (const json of invalidBodies) {
					const response = await receiver.post('downloads', {
						json,
					})

					expect(response.status).toBe(400)
				}
			})
		})

		describe('Map Upload/Delete Validation', () => {
			it('should reject PUT to non-custom map', async (t) => {
				const { sender } = await startServers(t)
				const response = await sender.put('maps/default', {
					body: 'some data',
				})

				expect(response.status).toBe(404)
			})

			it('should reject PUT without body', async (t) => {
				const { sender } = await startServers(t)
				const response = await sender.put('maps/custom')

				expect(response.status).toBe(400)
			})

			it('should reject DELETE of non-custom map', async (t) => {
				const { sender } = await startServers(t)
				const response = await sender.delete('maps/default')

				expect(response.status).toBe(404)
			})
		})
	})

	describe('Download abort scenarios', () => {
		it('should abort a download immediately', async (t) => {
			const { senderDeviceId, createShare, receiver, sender } =
				await startServers(t, {
					senderOptions: { customMapPath: OSM_BRIGHT_Z6 },
					receiverOptions: { customMapPath: DEMOTILES_Z2 },
				})

			const initialSenderStyle = await sender
				.get(`maps/custom/style.json`)
				.json()
			const initialReceiverStyle = await receiver
				.get(`maps/custom/style.json`)
				.json()
			expect(comparableStyle(initialSenderStyle)).not.toEqual(
				comparableStyle(initialReceiverStyle),
			)

			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()

			// Abort the download immediately
			const cancelResponse = await receiver.post(
				`downloads/${downloadId}/abort`,
			)
			expect(cancelResponse.status).toBe(204)

			await delay(10) // Wait a bit for cancellation to propagate

			const mapShare = await sender.get(`mapShares/${shareId}`).json()
			expect(mapShare).toHaveProperty('status', 'aborted')

			const download = await receiver.get(`downloads/${downloadId}`).json()
			expect(download).toHaveProperty('status', 'aborted')

			const finalReceiverStyle = await receiver
				.get(`maps/custom/style.json`)
				.json()

			// check that the receiver's style is still unchanged
			expect(comparableStyle(finalReceiverStyle)).toEqual(
				comparableStyle(initialReceiverStyle),
			)
		})

		it('should abort a download after some progress', async (t) => {
			const {
				senderDeviceId,
				createShare,
				receiver,
				sender,
				receiverLocalBaseUrl,
			} = await startServers(t, {
				senderOptions: { customMapPath: OSM_BRIGHT_Z6 },
				receiverOptions: { customMapPath: DEMOTILES_Z2 },
			})

			const initialSenderStyle = await sender
				.get(`maps/custom/style.json`)
				.json()
			const initialReceiverStyle = await receiver
				.get(`maps/custom/style.json`)
				.json()
			expect(comparableStyle(initialSenderStyle)).not.toEqual(
				comparableStyle(initialReceiverStyle),
			)

			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()

			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			await eventsUntil(es, (msg) => JSON.parse(msg.data).bytesDownloaded > 0)
			es.close()

			const cancelResponse = await receiver.post(
				`downloads/${downloadId}/abort`,
			)
			expect(cancelResponse.status).toBe(204)

			await delay(10) // Wait a bit for cancellation to propagate

			const mapShare = await sender.get(`mapShares/${shareId}`).json()
			expect(mapShare).toHaveProperty('status', 'aborted')

			const download = await receiver.get(`downloads/${downloadId}`).json()
			expect(download).toHaveProperty('status', 'aborted')

			const finalReceiverStyle = await receiver
				.get(`maps/custom/style.json`)
				.json()

			// check that the receiver's style is still unchanged
			expect(comparableStyle(finalReceiverStyle)).toEqual(
				comparableStyle(initialReceiverStyle),
			)
		})

		it('should not allow abort of completed download', async (t) => {
			const { senderDeviceId, createShare, receiver, receiverLocalBaseUrl } =
				await startServers(t)
			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()
			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()
			// Wait for download to complete
			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			await eventsUntil(es, 'completed')
			es.close()
			// Attempt to abort
			const cancelResponse = await receiver.post(
				`downloads/${downloadId}/abort`,
			)
			expect(cancelResponse.status).toBe(409)
		})
	})

	describe('Map Share Cancellation Scenarios', () => {
		it('sender can cancel a map share before download starts', async (t) => {
			const { createShare, sender, receiver, senderDeviceId } =
				await startServers(t)
			const { shareId } = await createShare().json()

			// Cancel the share
			await sender.post(`mapShares/${shareId}/cancel`)
			const share = await sender.get(`mapShares/${shareId}`).json<any>()
			expect(share.status).toBe('canceled')

			// Attempt to start download
			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls: share.mapShareUrls,
						estimatedSizeBytes: share.estimatedSizeBytes,
					},
				})
				.json<any>()
			await delay(10) // Wait a bit for cancellation to propagate

			const download = await receiver.get(`downloads/${downloadId}`).json()
			expect(download).toHaveProperty('status', 'canceled')
		})

		it('sender can cancel a map share after download starts', async (t) => {
			const {
				createShare,
				sender,
				receiver,
				senderDeviceId,
				receiverLocalBaseUrl,
			} = await startServers(t)
			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			// Start the download
			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()
			expect(downloadId).toBeDefined()

			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			// Wait for download to start
			await eventsUntil(es, (msg) => JSON.parse(msg.data).bytesDownloaded > 0)

			const canceledPromise = eventsUntil(es, 'canceled')
			// Cancel the share
			await sender.post(`mapShares/${shareId}/cancel`)
			// Wait for canceled event
			await canceledPromise
			es.close()

			const download = await receiver.get(`downloads/${downloadId}`).json()
			expect(download).toHaveProperty('status', 'canceled')
		})

		it('receiver can abort a download after download starts', async (t) => {
			const { createShare, receiver, senderDeviceId, receiverLocalBaseUrl } =
				await startServers(t)
			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			// Start the download
			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()
			expect(downloadId).toBeDefined()

			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			// Wait for download to start
			await eventsUntil(es, (msg) => JSON.parse(msg.data).bytesDownloaded > 0)

			await receiver.post(`downloads/${downloadId}/abort`)
			await delay(10) // Wait a bit for cancellation to propagate
			const download = await receiver.get(`downloads/${downloadId}`).json()
			expect(download).toHaveProperty('status', 'aborted')
		})

		it('should stream download and abort updates via SSE for shares', async (t) => {
			const {
				createShare,
				receiver,
				senderDeviceId,
				receiverLocalBaseUrl,
				senderLocalBaseUrl,
			} = await startServers(t)
			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			const serverEs = createEventSource(
				`${senderLocalBaseUrl}/mapShares/${shareId}/events`,
			)
			const eventsPromise = eventsUntil(serverEs, 'aborted')
			// Start the download
			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()
			expect(downloadId).toBeDefined()

			// Wait for download to start
			const receiverEs = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			await eventsUntil(
				receiverEs,
				(msg) => JSON.parse(msg.data).bytesDownloaded > 0,
			)

			// Receiver aborts the download
			await receiver.post(`downloads/${downloadId}/abort`)

			const events = await eventsPromise
			serverEs.close()
			receiverEs.close()

			// First message should be initial state (pending)
			expect(events[0]).toHaveProperty('status', 'pending')
			expect(events[0]).toHaveProperty('shareId', shareId)

			// At least one progress message
			expect(
				events.some((e) => e.status === 'downloading' && e.bytesDownloaded > 0),
			).toBe(true)

			// Final message should be aborted
			expect(events.at(-1)).toHaveProperty('status', 'aborted')
		})

		it('should stream download and cancellation updates via SSE for downloads', async (t) => {
			const {
				createShare,
				receiver,
				senderDeviceId,
				receiverLocalBaseUrl,
				sender,
			} = await startServers(t)
			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			// Start the download
			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()
			expect(downloadId).toBeDefined()
			const receiverEs = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			const eventsPromise = eventsUntil(receiverEs, 'canceled')

			// Wait for download to start
			await eventsUntil(
				receiverEs,
				(msg) => JSON.parse(msg.data).bytesDownloaded > 0,
			)

			// Cancel the share
			await sender.post(`mapShares/${shareId}/cancel`)

			const events = await eventsPromise
			receiverEs.close()

			// First message should have shareId
			expect(events[0]).toHaveProperty('shareId', shareId)

			// At least one progress message
			expect(
				events.some((e) => e.status === 'downloading' && e.bytesDownloaded > 0),
			).toBe(true)

			// Final message should be canceled
			expect(events.at(-1)).toHaveProperty('status', 'canceled')
		})

		it('should not corrupt existing custom map when download is aborted by receiver', async (t) => {
			const { createShare, receiver, senderDeviceId, receiverLocalBaseUrl } =
				await startServers(t)

			// Get original map info
			const originalMapInfo = await receiver.get('maps/custom/info').json<any>()
			expect(originalMapInfo.size).toBeGreaterThan(0)

			// Create a share from sender
			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			// Start the download
			const { downloadId } = await receiver
				.post('downloads', {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()
			expect(downloadId).toBeDefined()

			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			// Wait for download to start
			await eventsUntil(es, (msg) => JSON.parse(msg.data).bytesDownloaded > 0)

			const abortedPromise = eventsUntil(es, 'aborted')
			// Abort the download
			await receiver.post(`downloads/${downloadId}/abort`)
			// Wait for aborted event
			await abortedPromise
			es.close()

			// Verify the original map is still accessible and unchanged
			const afterAbortMapInfo = await receiver
				.get('maps/custom/info')
				.json<any>()
			expect(afterAbortMapInfo.size).toBe(originalMapInfo.size)
			expect(afterAbortMapInfo.mapId).toBe(originalMapInfo.mapId)
		})

		it('should not corrupt existing custom map when download is canceled by sender', async (t) => {
			const {
				createShare,
				sender,
				receiver,
				senderDeviceId,
				receiverLocalBaseUrl,
			} = await startServers(t)

			// Get original map info
			const originalMapInfo = await receiver.get('maps/custom/info').json<any>()
			expect(originalMapInfo.size).toBeGreaterThan(0)

			// Create a share from sender
			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			// Start the download
			const { downloadId } = await receiver
				.post('downloads', {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()
			expect(downloadId).toBeDefined()

			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			// Wait for download to start
			await eventsUntil(es, (msg) => JSON.parse(msg.data).bytesDownloaded > 0)

			const canceledPromise = eventsUntil(es, 'canceled')
			// Cancel the share from sender side
			await sender.post(`mapShares/${shareId}/cancel`)
			// Wait for canceled event
			await canceledPromise
			es.close()

			// Verify the original map is still accessible and unchanged
			const afterCancelMapInfo = await receiver
				.get('maps/custom/info')
				.json<any>()
			expect(afterCancelMapInfo.size).toBe(originalMapInfo.size)
			expect(afterCancelMapInfo.mapId).toBe(originalMapInfo.mapId)
		})

		it('should not leave temp files when download fails', async (t) => {
			const {
				senderDeviceId,
				createShare,
				receiver,
				receiverLocalBaseUrl,
				receiverCustomMapPath,
			} = await startServers(t)
			const receiverDir = path.dirname(receiverCustomMapPath)
			const receiverBasename = path.basename(receiverCustomMapPath)

			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()

			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			// Wait for download to start
			await eventsUntil(es, (msg) => JSON.parse(msg.data).bytesDownloaded > 0)

			// check temp file exists
			{
				const files = fs.readdirSync(receiverDir)
				const hasTempFile = files.find(
					(f) => f.startsWith(receiverBasename) && f.includes('.download-'),
				)
				expect(hasTempFile).toBeDefined()
			}

			const abortedPromise = eventsUntil(es, 'aborted')
			// Abort the download to trigger cleanup
			await receiver.post(`downloads/${downloadId}/abort`)
			// Wait for aborted event
			await abortedPromise
			es.close()

			// Check temp file is removed
			{
				const files = fs.readdirSync(receiverDir)
				const hasTempFile = files.find(
					(f) => f.startsWith(receiverBasename) && f.includes('.download-'),
				)
				expect(hasTempFile).toBeUndefined()
			}
		})
	})

	describe('Remote Device ID Validation', () => {
		it('should reject access to share with wrong device ID (403)', async (t) => {
			const { sender, senderRemotePort, senderKeyPair, receiverKeyPair } =
				await startServers(t)

			// Create a third device with different keys
			const wrongKeyPair = SecretStreamAgent.keyPair()
			const wrongDeviceId = z32.encode(wrongKeyPair.publicKey)

			// Create a share for a different device
			const { shareId: shareId2 } = await sender
				.post('mapShares', {
					json: {
						mapId: 'custom',
						receiverDeviceId: wrongDeviceId, // Share is for wrongDeviceId
					},
				})
				.json<any>()

			// Try to access with receiver's credentials (should fail)
			const shareInfoUrl2 = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId2}`
			const response2 = (await secretStreamFetch(shareInfoUrl2, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair, // Using receiver's keypair
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			// Should get 403 Forbidden because receiver is not the intended recipient
			expect(response2.status).toBe(403)
		})

		it('should reject download request with wrong device ID (403)', async (t) => {
			const { sender, senderRemotePort, senderKeyPair, receiverKeyPair } =
				await startServers(t)

			// Create a third device with different keys
			const wrongKeyPair = SecretStreamAgent.keyPair()
			const wrongDeviceId = z32.encode(wrongKeyPair.publicKey)

			// Create a share for wrongDeviceId
			const { shareId } = await sender
				.post('mapShares', {
					json: {
						mapId: 'custom',
						receiverDeviceId: wrongDeviceId, // Share is for wrongDeviceId
					},
				})
				.json<any>()

			// Try to download with receiver's credentials (wrong device)
			const downloadUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`

			const response = (await secretStreamFetch(downloadUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair, // Using receiver's keypair
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			// Should get 403 Forbidden
			expect(response.status).toBe(403)
		})

		it('should allow access to share with correct device ID', async (t) => {
			const {
				createShare,
				senderRemotePort,
				senderKeyPair,
				receiverKeyPair,
				receiverDeviceId,
			} = await startServers(t)

			// Create a share for receiver
			const { shareId } = await createShare().json()

			// Access with correct credentials (receiver's device)
			const shareInfoUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}`
			const response = (await secretStreamFetch(shareInfoUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair, // Using receiver's keypair
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			// Should succeed
			expect(response.status).toBe(200)
			const shareInfo = await response.json()
			expect(shareInfo.shareId).toBe(shareId)
			expect(shareInfo.receiverDeviceId).toBe(receiverDeviceId)
		})

		it('should reject decline request with wrong device ID (403)', async (t) => {
			const { sender, senderRemotePort, senderKeyPair, receiverKeyPair } =
				await startServers(t)

			// Create a third device
			const wrongKeyPair = SecretStreamAgent.keyPair()
			const wrongDeviceId = z32.encode(wrongKeyPair.publicKey)

			// Create a share for wrongDeviceId
			const { shareId } = await sender
				.post('mapShares', {
					json: {
						mapId: 'custom',
						receiverDeviceId: wrongDeviceId,
					},
				})
				.json<any>()

			// Try to decline with receiver's credentials (wrong device)
			const declineUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/decline`
			const response = (await secretStreamFetch(declineUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'no-space' }),
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair, // Using receiver's keypair
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			// Should get 403 Forbidden
			expect(response.status).toBe(403)
		})
	})

	describe('Edge Cases and State Transitions', () => {
		it('should not allow multiple simultaneous downloads on the same share', async (t) => {
			const { createShare, senderDeviceId, receiver, receiverLocalBaseUrl } =
				await startServers(t)

			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			// Start first download
			const download1 = await receiver
				.post('downloads', {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()
			// Wait for first download to start
			const es1 = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${download1.downloadId}/events`,
			)
			const completedPromise = eventsUntil(es1, 'completed')
			await eventsUntil(es1, (msg) => JSON.parse(msg.data).bytesDownloaded > 0)

			// Try to start second download while first is in progress
			const download2 = await receiver
				.post('downloads', {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()

			const es2 = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${download2.downloadId}/events`,
			)
			const events = await eventsUntil(es2, 'error')
			// Verify that no bytes were downloaded in the second download
			expect(events.some((e) => e.bytesDownloaded > 0)).toBe(false)
			expect(events.at(-1)).toHaveProperty('status', 'error')
			expect(events.at(-1)).toHaveProperty(
				'error.code',
				'DOWNLOAD_MAP_SHARE_ALREADY_DOWNLOADING',
			)

			await completedPromise
			es1.close()
			es2.close()
		}, 2000)

		it('should reject download after share is declined', async (t) => {
			const { createShare, receiver, senderDeviceId, receiverLocalBaseUrl } =
				await startServers(t)

			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			// Decline the share
			const declineResponse = await receiver.post(
				`mapShares/${shareId}/decline`,
				{
					json: {
						reason: 'user_rejected',
						senderDeviceId,
						mapShareUrls,
					},
				},
			)
			expect(declineResponse.status).toBe(204)

			// Try to start download on declined share
			const { downloadId } = await receiver
				.post('downloads', {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()

			// Wait for download events
			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			const events = await eventsUntil(es, 'error')
			es.close()
			expect(events.at(-1)).toHaveProperty('status', 'error')
			expect(events.at(-1)).toHaveProperty(
				'error.code',
				'DOWNLOAD_MAP_SHARE_DECLINED',
			)
		})

		it('should reject decline on non-pending share', async (t) => {
			const {
				createShare,
				sender,
				senderRemotePort,
				receiver,
				senderDeviceId,
			} = await startServers(t)

			const { shareId, mapShareUrls } = await createShare().json()

			// Cancel the share first
			await sender.post(`mapShares/${shareId}/cancel`)

			const declineResponse = await receiver.post(
				`mapShares/${shareId}/decline`,
				{
					json: {
						reason: 'user_rejected',
						senderDeviceId,
						mapShareUrls,
					},
				},
			)
			expect(declineResponse.status).toBe(409)
			const declineError = await declineResponse.json()
			expect(declineError).toHaveProperty('code', 'DECLINE_NOT_PENDING')
		})

		it('should reject cancel on completed share', async (t) => {
			const {
				createShare,
				sender,
				receiver,
				senderDeviceId,
				receiverLocalBaseUrl,
			} = await startServers(t)

			const { shareId, mapShareUrls, estimatedSizeBytes } =
				await createShare().json()

			// Start download
			const { downloadId } = await receiver
				.post('downloads', {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()

			// Wait for download to complete using SSE
			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			await eventsUntil(es, 'completed')
			es.close()

			// Verify share is completed
			const completedShareData = await sender
				.get(`mapShares/${shareId}`)
				.json<any>()
			expect(completedShareData.status).toBe('completed')

			// Try to cancel the completed share
			const cancelResponse = await sender.post(`mapShares/${shareId}/cancel`)
			expect(cancelResponse.status).toBe(409)
			const cancelError = await cancelResponse.json()
			expect(cancelError).toHaveProperty(
				'code',
				'CANCEL_NOT_PENDING_OR_DOWNLOADING',
			)
		})

		it('should handle concurrent SSE connections to same share', async (t) => {
			const { createShare, sender, senderLocalBaseUrl } = await startServers(t)

			const { shareId } = await createShare().json()

			// Start two SSE connections to the same share
			const sseUrl = `${senderLocalBaseUrl}/mapShares/${shareId}/events`
			const es1 = createEventSource(sseUrl)
			const es2 = createEventSource(sseUrl)

			const messages1Promise = eventsUntil(es1, 'canceled')
			const messages2Promise = eventsUntil(es2, 'canceled')
			// Trigger an update
			await sender.post(`mapShares/${shareId}/cancel`)

			const [messages1, messages2] = await Promise.all([
				messages1Promise,
				messages2Promise,
			])

			es1.close()
			es2.close()

			// Both connections should have received messages
			expect(messages1.at(-1)).toHaveProperty('status', 'canceled')
			expect(messages2.at(-1)).toHaveProperty('status', 'canceled')
		})
	})

	describe('Error Propagation and Resource Cleanup', () => {
		it('should respond 404 when creating a share for a non-existent map', async (t) => {
			const { sender, receiverDeviceId } = await startServers(t)

			// Try to create a share for a non-existent map
			const response = await sender.post('mapShares', {
				json: {
					mapId: 'nonexistent',
					receiverDeviceId,
				},
			})

			expect(response.status).toBe(404)
			const error = await response.json()
			expect(error).toHaveProperty('error')
		})

		it('should handle download errors and update status to error', async (t) => {
			const { createShare, receiver, senderDeviceId, receiverLocalBaseUrl } =
				await startServers(t)

			const { shareId } = await createShare().json()

			// Try to create download with invalid URLs
			const createDownloadResponse = await receiver.post('downloads', {
				json: {
					senderDeviceId,
					shareId,
					mapShareUrls: ['http://127.0.0.1:1/download'],
					estimatedSizeBytes: 1000,
				},
			})
			expect(createDownloadResponse.status).toBe(201)
			const { downloadId } = await createDownloadResponse.json<any>()

			// Wait for download to fail and cleanup to complete
			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			await eventsUntil(es, 'error')
			es.close()

			// Check that download is in error state
			const downloadStatus = await receiver
				.get(`downloads/${downloadId}`)
				.json<any>()
			expect(downloadStatus.status).toBe('error')
			expect(downloadStatus).toHaveProperty('error.code', 'DOWNLOAD_ERROR')
		})

		it('should clean up temp files when download errors', async (t) => {
			const {
				createShare,
				receiver,
				senderDeviceId,
				receiverCustomMapPath,
				receiverLocalBaseUrl,
			} = await startServers(t)
			const receiverDir = path.dirname(receiverCustomMapPath)
			const receiverBasename = path.basename(receiverCustomMapPath)

			const { shareId } = await createShare().json()

			// check no temp file exists yet
			{
				const files = fs.readdirSync(receiverDir)
				const hasTempFile = files.find(
					(f) => f.startsWith(receiverBasename) && f.includes('.download-'),
				)
				expect(hasTempFile).toBeUndefined()
			}

			// Create download with invalid URL to cause error
			const { downloadId } = await receiver
				.post('downloads', {
					json: {
						senderDeviceId,
						shareId,
						mapShareUrls: [`http://0.0.0.0:9999/invalid-download-path`],
						estimatedSizeBytes: 1000,
					},
				})
				.json<any>()

			// Wait for download to fail and cleanup to complete
			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			await eventsUntil(es, 'error')
			es.close()

			// Verify no temp files are left behind
			const files = fs.readdirSync(receiverDir)
			const tempFiles = files.filter(
				(f) => f.startsWith(receiverBasename) && f.includes('.download-'),
			)
			expect(tempFiles).toHaveLength(0)
		})
	})
})

/**
 * Styles include the tiles, sprite, and glyph URLs which may differ
 * between sender and receiver due to different ports or paths. This
 * function removes those keys for comparison purposes.
 */
function comparableStyle(style: any) {
	const s = {
		...style,
		sources: {},
	}
	if (s.glyphs) {
		s.glyphs = new URL(s.glyphs).pathname
	}
	if (s.sprite) {
		s.sprite = new URL(s.sprite).pathname
	}
	for (const [sourceId, source] of Object.entries(s.sources || {})) {
		// @ts-expect-error
		s.sources[sourceId] = { ...source }
		if (Array.isArray((source as any).tiles)) {
			s.sources[sourceId].tiles = (source as any).tiles.map(
				(tileUrl: string) => {
					return new URL(tileUrl).pathname
				},
			)
		}
	}
	return s
}

async function eventsUntil(
	es: EventSourceClient,
	statusOrCondition: string | ((msg: EventSourceMessage) => boolean),
): Promise<any[]> {
	const events = []
	const condition =
		typeof statusOrCondition === 'string'
			? (msg: EventSourceMessage) =>
					JSON.parse(msg.data).status === statusOrCondition
			: statusOrCondition
	for await (const msg of es) {
		const event = JSON.parse(msg.data)
		events.push(event)
		if (condition(msg)) {
			break
		}
	}
	return events
}
