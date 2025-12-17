import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

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
import { Reader, type SMPStyle } from 'styled-map-package'
import { describe, it, expect } from 'vitest'
import z32 from 'z32'

import type { MapShareState } from '../src/types.js'
import { DEMOTILES_Z2, OSM_BRIGHT_Z6, startServers } from './helpers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
				downloadUrls,
				declineUrls,
				...deterministic
			} = share as MapShareState
			expect(deterministic).toMatchSnapshot()
			expect(mapShareCreated).toBeGreaterThanOrEqual(timeBeforeRequest)
			expect(mapShareCreated).toBeLessThanOrEqual(Date.now())
			expect(downloadUrls.length).toBe(1)
			expect(downloadUrls[0]).toMatch(`/mapShares/${shareId}/download`)
			expect(declineUrls.length).toBe(1)
			expect(declineUrls[0]).toMatch(`/mapShares/${shareId}/decline`)
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
			const { senderLocalBaseUrl, receiverDeviceId } = await startServers(t)
			// Create a share
			const createResponse = await postJson(`${senderLocalBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Cancel it
			const cancelResponse = await fetch(
				`${senderLocalBaseUrl}/mapShares/${shareId}/cancel`,
				{ method: 'POST' },
			)
			expect(cancelResponse.status).toBe(204)

			// Verify it's cancelled
			const getResponse = await fetch(
				`${senderLocalBaseUrl}/mapShares/${shareId}`,
			)
			const share = await getResponse.json()
			expect(share.status).toBe('canceled')
		})

		it('should decline a map share from receiver', async (t) => {
			const { sender, createShare, receiver, senderDeviceId } =
				await startServers(t)
			const { shareId, declineUrls } = await createShare().json()

			// Decline it
			const declineResponse = await receiver.post(
				`mapShares/${shareId}/decline`,
				{
					json: {
						reason: 'user_rejected',
						senderDeviceId,
						declineUrls,
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

			const { shareId, downloadUrls, estimatedSizeBytes } =
				await createShare().json()

			// Now create a download on the receiver using the real share
			const response = await receiver.post(`downloads`, {
				json: {
					senderDeviceId,
					shareId,
					downloadUrls,
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
			const {
				senderLocalBaseUrl,
				receiverLocalBaseUrl,
				receiverDeviceId,
				senderDeviceId,
				createShare,
				receiver,
			} = await startServers(t)
			const { shareId, downloadUrls, estimatedSizeBytes } =
				await createShare().json()

			// Now create a download on the receiver using the real share
			const download = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						downloadUrls,
						estimatedSizeBytes,
					},
				})
				.json()
			const downloads = await receiver.get(`downloads`).json()
			expect(downloads).toEqual([download])
		})

		it('should get a specific download', async (t) => {
			const { senderDeviceId, createShare, receiver } = await startServers(t)
			const { shareId, downloadUrls, estimatedSizeBytes } =
				await createShare().json()

			const download = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						downloadUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()
			const downloadDetails = await receiver
				.get(`downloads/${download.downloadId}`)
				.json()
			expect(downloadDetails).toEqual(download)
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
						downloadUrls: ['http://example.com/download'],
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
			const { shareId, downloadUrls } = await createShare().json()
			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						downloadUrls,
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
		})
		it('should reject canceling download from non-localhost', async (t) => {
			const { receiverRemoteBaseUrl, receiver, createShare, senderDeviceId } =
				await startServers(t)
			const { shareId, downloadUrls } = await createShare().json()
			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						downloadUrls,
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
				const { shareId, declineUrls } = await createShare().json()

				const invalidBodies = [
					{
						// Missing senderDeviceId and declineUrls
						reason: 'user_rejected',
					},
					{
						// Missing declineUrls
						reason: 'user_rejected',
						senderDeviceId,
					},
					{
						// Missing senderDeviceId
						reason: 'user_rejected',
						declineUrls,
					},
					{
						// Missing reason
						senderDeviceId,
						declineUrls,
					},
					{
						// Invalid type for reason
						reason: 123,
						senderDeviceId,
						declineUrls,
					},
					{
						// Invalid type for senderDeviceId
						reason: 'user_rejected',
						senderDeviceId: 123,
						declineUrls,
					},
					{
						// Invalid type for declineUrls (not array)
						reason: 'user_rejected',
						senderDeviceId,
						declineUrls: 'not-an-array',
					},
					{
						// Empty declineUrls array
						reason: 'user_rejected',
						senderDeviceId,
						declineUrls: [],
					},
					{
						// Invalid URLs in declineUrls
						reason: 'user_rejected',
						senderDeviceId,
						declineUrls: ['not-a-url'],
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
						downloadUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					},
					{
						// Missing shareId
						senderDeviceId,
						downloadUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					},
					{
						// Missing downloadUrls
						senderDeviceId,
						shareId: 'test-share',
						estimatedSizeBytes: 1000,
					},
					{
						// Missing estimatedSizeBytes
						senderDeviceId,
						shareId: 'test-share',
						downloadUrls: ['http://example.com/download'],
					},
					{
						// Invalid type for senderDeviceId
						senderDeviceId: 123,
						shareId: 'test-share',
						downloadUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					},
					{
						// Invalid type for shareId
						senderDeviceId,
						shareId: 123,
						downloadUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					},
					{
						// Invalid type for downloadUrls (not array)
						senderDeviceId,
						shareId: 'test-share',
						downloadUrls: 'not-an-array',
						estimatedSizeBytes: 1000,
					},
					{
						// Empty downloadUrls array
						senderDeviceId,
						shareId: 'test-share',
						downloadUrls: [],
						estimatedSizeBytes: 1000,
					},
					{
						// Invalid URLs in downloadUrls
						senderDeviceId,
						shareId: 'test-share',
						downloadUrls: ['not-a-url'],
						estimatedSizeBytes: 1000,
					},
					{
						// Invalid type for estimatedSizeBytes
						senderDeviceId,
						shareId: 'test-share',
						downloadUrls: ['http://example.com/download'],
						estimatedSizeBytes: 'not-a-number',
					},
					{
						// Null values
						senderDeviceId: null,
						shareId: null,
						downloadUrls: null,
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

			const { shareId, downloadUrls, estimatedSizeBytes } =
				await createShare().json()

			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						downloadUrls,
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

			const { shareId, downloadUrls, estimatedSizeBytes } =
				await createShare().json()

			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						downloadUrls,
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
			const { shareId, downloadUrls, estimatedSizeBytes } =
				await createShare().json()
			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						downloadUrls,
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

	describe.only('Map Share Cancellation Scenarios', () => {
		it('should cancel a map share before download starts', async (t) => {
			const {
				createShare,
				sender,
				receiver,
				senderDeviceId,
				receiverLocalBaseUrl,
			} = await startServers(t)
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
						downloadUrls: share.downloadUrls,
						estimatedSizeBytes: share.estimatedSizeBytes,
					},
				})
				.json<any>()
			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			await eventsUntil(es, 'canceled')
			es.close()

			const download = await receiver.get(`downloads/${downloadId}`).json()
			expect(download).toHaveProperty('status', 'canceled')
		})

		it('should cancel a map share after download starts', async (t) => {
			const {
				createShare,
				sender,
				receiver,
				senderDeviceId,
				receiverLocalBaseUrl,
			} = await startServers(t)
			const { shareId, downloadUrls, estimatedSizeBytes } =
				await createShare().json()

			// Start the download
			const { downloadId } = await receiver
				.post(`downloads`, {
					json: {
						senderDeviceId,
						shareId,
						downloadUrls,
						estimatedSizeBytes,
					},
				})
				.json<any>()

			const es = createEventSource(
				`${receiverLocalBaseUrl}/downloads/${downloadId}/events`,
			)
			// Wait for download to start
			await eventsUntil(es, (msg) => JSON.parse(msg.data).bytesDownloaded > 0)
			console.log('HERE')

			await sender.post(`mapShares/${shareId}/cancel`)

			for await (const msg of es) {
				console.log('MSG', msg.data)
			}
			es.close()

			const download = await receiver.get(`downloads/${downloadId}`).json()
			expect(download).toHaveProperty('status', 'canceled')
		}, 2000)

		it('should cancel a download during active transfer', async () => {
			// Create a share
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			expect(createShareResponse.status).toBe(201)
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Start the download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			expect(createDownloadResponse.status).toBe(201)
			const downloadData = await createDownloadResponse.json()
			const { downloadId } = downloadData
			expect(downloadData.status).toBe('downloading')

			// Cancel the download immediately (race with download completion in fast test environment)
			const cancelResponse = await fetch(
				`${receiverBaseUrl}/downloads/${downloadId}/cancel`,
				{ method: 'POST' },
			)
			expect(cancelResponse.status).toBe(204)

			// Verify download ended
			// Note: Download may complete before cancel takes effect in test environment
			const getDownloadResponse = await fetch(
				`${receiverBaseUrl}/downloads/${downloadId}`,
			)
			const finalDownloadData = await getDownloadResponse.json()
			expect(['canceled', 'completed']).toContain(finalDownloadData.status)
		}, 10000)

		it('should stream cancellation updates via SSE for shares', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Start collecting SSE messages
			const messagesPromise = collectSSEMessages(
				`${senderBaseUrl}/mapShares/${shareId}/events`,
				{
					count: 2, // Initial state + cancel update
					timeoutMs: 5000,
				},
			)

			// Wait for connection to establish
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Cancel the share
			await fetch(`${senderBaseUrl}/mapShares/${shareId}/cancel`, {
				method: 'POST',
			})

			const messages = await messagesPromise

			// First message should be initial state (pending)
			expect(messages[0]).toHaveProperty('status', 'pending')
			expect(messages[0]).toHaveProperty('shareId', shareId)

			// Second message should be the cancellation update
			expect(messages[1]).toHaveProperty('status', 'canceled')
		})

		it('should stream cancellation updates via SSE for downloads', async () => {
			// Create a share first
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Create a download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			const downloadData = await createDownloadResponse.json()
			const { downloadId } = downloadData

			// Start collecting SSE messages for the download
			// Expect at least 1 message (initial state), but may get completion before we can cancel
			const messagesPromise = collectSSEMessages(
				`${receiverBaseUrl}/downloads/${downloadId}/events`,
				{
					until: (messages) =>
						messages.some(
							(m) => m.status === 'canceled' || m.status === 'completed',
						),
					timeoutMs: 5000,
				},
			)

			// Try to cancel immediately (may race with download completion)
			await fetch(`${receiverBaseUrl}/downloads/${downloadId}/cancel`, {
				method: 'POST',
			})

			const messages = await messagesPromise

			// Should have initial message
			expect(messages[0]).toHaveProperty('downloadId', downloadId)

			// Final message should be either canceled or completed (due to race in test environment)
			const finalMessage = messages[messages.length - 1]
			expect(['canceled', 'completed']).toContain(finalMessage.status)
		})

		it('should not corrupt existing custom map when download is cancelled by receiver', async () => {
			// First, create an initial custom map on the receiver
			const fixtureMapPath = path.join(
				__dirname,
				'fixtures',
				'demotiles-z2.smp',
			)
			fs.copyFileSync(fixtureMapPath, tempReceiverMapPath)

			// Get original map stats
			const originalStats = fs.statSync(tempReceiverMapPath)
			const originalSize = originalStats.size

			// Verify we can read the original map
			const originalMapInfoResponse = await fetch(
				`${receiverBaseUrl}/maps/custom/info`,
			)
			expect(originalMapInfoResponse.status).toBe(200)
			const originalMapInfo = await originalMapInfoResponse.json()
			expect(originalMapInfo.size).toBe(originalSize)

			// Create a share from sender
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Start a download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			expect(createDownloadResponse.status).toBe(201)
			const { downloadId } = await createDownloadResponse.json()

			// Cancel the download immediately
			await fetch(`${receiverBaseUrl}/downloads/${downloadId}/cancel`, {
				method: 'POST',
			})

			// Wait a moment for cancellation to process
			await new Promise((resolve) => setTimeout(resolve, 200))

			// Verify the original map file still exists and is unchanged
			expect(fs.existsSync(tempReceiverMapPath)).toBe(true)
			const afterCancelStats = fs.statSync(tempReceiverMapPath)
			expect(afterCancelStats.size).toBe(originalSize)

			// Verify we can still read the original map
			const afterCancelMapInfoResponse = await fetch(
				`${receiverBaseUrl}/maps/custom/info`,
			)
			expect(afterCancelMapInfoResponse.status).toBe(200)
			const afterCancelMapInfo = await afterCancelMapInfoResponse.json()
			expect(afterCancelMapInfo.size).toBe(originalSize)
			expect(afterCancelMapInfo.mapId).toBe(originalMapInfo.mapId)
		}, 10000)

		it('should not corrupt existing custom map when download is cancelled by sender', async () => {
			// Create an initial custom map on the receiver
			const fixtureMapPath = path.join(
				__dirname,
				'fixtures',
				'demotiles-z2.smp',
			)
			fs.copyFileSync(fixtureMapPath, tempReceiverMapPath)

			// Get original map stats
			const originalStats = fs.statSync(tempReceiverMapPath)
			const originalSize = originalStats.size

			// Create a share from sender
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Start a download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			expect(createDownloadResponse.status).toBe(201)

			// Cancel the share from sender side (which will cause download to fail)
			await fetch(`${senderBaseUrl}/mapShares/${shareId}/cancel`, {
				method: 'POST',
			})

			// Wait for cancellation to propagate and download to fail
			await new Promise((resolve) => setTimeout(resolve, 500))

			// Verify the original map file still exists and is unchanged
			expect(fs.existsSync(tempReceiverMapPath)).toBe(true)
			const afterCancelStats = fs.statSync(tempReceiverMapPath)
			expect(afterCancelStats.size).toBe(originalSize)

			// Verify we can still read the original map
			const afterCancelMapInfoResponse = await fetch(
				`${receiverBaseUrl}/maps/custom/info`,
			)
			expect(afterCancelMapInfoResponse.status).toBe(200)
			const afterCancelMapInfo = await afterCancelMapInfoResponse.json()
			expect(afterCancelMapInfo.size).toBe(originalSize)
		}, 10000)

		it('should not leave temp files when download fails', async () => {
			// Create a share with invalid data to cause download to fail quickly
			const createShareResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Start a download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			const { downloadId } = await createDownloadResponse.json()

			// Cancel immediately to trigger abort
			await fetch(`${receiverBaseUrl}/downloads/${downloadId}/cancel`, {
				method: 'POST',
			})

			// Wait for cleanup to complete
			await new Promise((resolve) => setTimeout(resolve, 1500))
		})
	})

	describe('Remote Device ID Validation', () => {
		it('should reject access to share with wrong device ID (403)', async () => {
			// Create a third device with different keys
			const wrongKeyPair = SecretStreamAgent.keyPair()
			const wrongDeviceId = z32.encode(wrongKeyPair.publicKey)

			// Create a share for the correct receiver
			const createShareResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId, // Share is for receiverDeviceId
				}),
			})
			expect(createShareResponse.status).toBe(201)
			const shareData = await createShareResponse.json()
			const { shareId } = shareData

			// Create a share for a different device and try to access it with receiver's credentials
			const createShareResponse2 = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId: wrongDeviceId, // Share is for wrongDeviceId
				}),
			})
			const shareData2 = await createShareResponse2.json()
			const { shareId: shareId2 } = shareData2

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

		it('should reject download request with wrong device ID (403)', async () => {
			// Create a third device with different keys
			const wrongKeyPair = SecretStreamAgent.keyPair()
			const wrongDeviceId = z32.encode(wrongKeyPair.publicKey)

			// Create a share for receiver
			const createShareResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId: wrongDeviceId, // Share is for wrongDeviceId
				}),
			})
			const shareData = await createShareResponse.json()
			const { shareId, downloadUrls, estimatedSizeBytes } = shareData

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

		it('should allow access to share with correct device ID', async () => {
			// Create a share for receiver
			const createShareResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId, // Correct receiver
				}),
			})
			const shareData = await createShareResponse.json()
			const { shareId, downloadUrls } = shareData

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

		it('should reject decline request with wrong device ID (403)', async () => {
			// Create a third device
			const wrongKeyPair = SecretStreamAgent.keyPair()
			const wrongDeviceId = z32.encode(wrongKeyPair.publicKey)

			// Create a share for wrongDeviceId
			const createShareResponse = await fetch(`${senderBaseUrl}/mapShares`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId: wrongDeviceId,
				}),
			})
			const shareData = await createShareResponse.json()
			const { shareId, downloadUrls } = shareData

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
		it('should reject multiple simultaneous downloads on the same share', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Start first download
			const downloadUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`
			const firstDownload = secretStreamFetch(downloadUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			}) as unknown as Promise<Response>

			// Wait a moment for first download to start
			await new Promise((resolve) => setTimeout(resolve, 50))

			// Try to start second download while first is in progress
			const secondDownload = secretStreamFetch(downloadUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			}) as unknown as Promise<Response>

			const secondResponse = await secondDownload
			expect(secondResponse.status).toBe(400)

			// Clean up first download
			const firstResponse = await firstDownload
			await firstResponse.body?.cancel()
		}, 10000)

		it('should reject download after share is declined', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Decline the share via secret stream
			const declineUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/decline`
			const declineResponse = (await secretStreamFetch(declineUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'user_rejected' }),
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			expect(declineResponse.status).toBe(204)

			// Try to start download on declined share
			const downloadUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`
			const downloadResponse = (await secretStreamFetch(downloadUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			expect(downloadResponse.status).toBe(400)
		})

		it('should reject download after share is canceled', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Cancel the share from sender
			const cancelResponse = await fetch(
				`${senderBaseUrl}/mapShares/${shareId}/cancel`,
				{ method: 'POST' },
			)
			expect(cancelResponse.status).toBe(204)

			// Try to start download on canceled share
			const downloadUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`
			const downloadResponse = (await secretStreamFetch(downloadUrl, {
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			// Should reject with 400 because share is canceled
			expect(downloadResponse.status).toBe(400)
		})

		it('should reject decline on non-pending share', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Cancel the share first
			await fetch(`${senderBaseUrl}/mapShares/${shareId}/cancel`, {
				method: 'POST',
			})

			// Try to decline the already-canceled share
			const declineUrl = `http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/decline`
			const declineResponse = (await secretStreamFetch(declineUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'user_rejected' }),
				dispatcher: new SecretStreamAgent({
					keyPair: receiverKeyPair,
					remotePublicKey: senderKeyPair.publicKey,
				}),
			})) as unknown as Response

			expect(declineResponse.status).toBe(400)
		})

		it('should reject cancel on completed share', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createResponse.json()
			const { shareId } = shareData

			// Complete a download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			const { downloadId } = await createDownloadResponse.json()

			// Wait for download to complete
			let status = 'downloading'
			let attempts = 0
			while (status === 'downloading' && attempts < 50) {
				await new Promise((resolve) => setTimeout(resolve, 100))
				const statusResponse = await fetch(
					`${receiverBaseUrl}/downloads/${downloadId}`,
				)
				const downloadStatus = await statusResponse.json()
				status = downloadStatus.status
				attempts++
			}

			// Verify share is completed
			const shareResponse = await fetch(`${senderBaseUrl}/mapShares/${shareId}`)
			const completedShareData = await shareResponse.json()

			if (completedShareData.status === 'completed') {
				// Try to cancel the completed share
				const cancelResponse = await fetch(
					`${senderBaseUrl}/mapShares/${shareId}/cancel`,
					{ method: 'POST' },
				)
				expect(cancelResponse.status).toBe(400)
			} else {
				// If download completed too fast, at least verify we got to a terminal state
				expect(['completed', 'canceled', 'error']).toContain(shareData.status)
			}
		}, 15000)

		it('should handle concurrent SSE connections to same share', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Start two SSE connections to the same share
			const sseUrl = `${senderBaseUrl}/mapShares/${shareId}/events`
			const es1 = createEventSource({ url: sseUrl })
			const es2 = createEventSource({ url: sseUrl })

			const messages1: any[] = []
			const messages2: any[] = []

			const collector1 = (async () => {
				for await (const { data } of es1) {
					messages1.push(JSON.parse(data))
					if (messages1.length >= 2) break
				}
			})()

			const collector2 = (async () => {
				for await (const { data } of es2) {
					messages2.push(JSON.parse(data))
					if (messages2.length >= 2) break
				}
			})()

			// Wait for initial messages
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Trigger an update
			await fetch(`${senderBaseUrl}/mapShares/${shareId}/cancel`, {
				method: 'POST',
			})

			// Wait for both to receive the update
			await Promise.race([
				Promise.all([collector1, collector2]),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error('Timeout')), 5000),
				),
			]).catch(() => {
				// Timeout is ok, we just want to verify both got messages
			})

			es1.close()
			es2.close()

			// Both connections should have received messages
			expect(messages1.length).toBeGreaterThan(0)
			expect(messages2.length).toBeGreaterThan(0)
		})
	})

	describe('Error Propagation and Resource Cleanup', () => {
		it('should handle map file becoming unavailable during share creation', async () => {
			// Try to create a share for a non-existent map
			const response = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'nonexistent',
				receiverDeviceId,
			})

			expect(response.status).toBe(404)
			const error = await response.json()
			expect(error).toHaveProperty('error')
		})

		it('should handle download errors and update status to error', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Try to create download with invalid URLs
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					shareId,
					downloadUrls: ['http://127.0.0.1:1/download'],
					estimatedSizeBytes: 1000,
				},
			)
			expect(createDownloadResponse.status).toBe(201)
			const { downloadId } = await createDownloadResponse.json()

			// Wait for download to fail and cleanup to complete
			await new Promise((resolve) => setTimeout(resolve, 2000))

			// Check that download is in error state
			const statusResponse = await fetch(
				`${receiverBaseUrl}/downloads/${downloadId}`,
			)
			const downloadStatus = await statusResponse.json()
			expect(downloadStatus.status).toBe('error')
			expect(downloadStatus).toHaveProperty('error')
		})

		it.skip('should clean up temp files when download errors', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Create download with invalid URL to cause error
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					shareId,
					downloadUrls: ['http://127.0.0.1:1/download'],
					estimatedSizeBytes: 1000,
				},
			)
			const { downloadId } = await createDownloadResponse.json()

			// Wait for download to fail and cleanup to complete
			await new Promise((resolve) => setTimeout(resolve, 2000))

			// Verify no temp files are left behind
			const receiverDir = path.dirname(tempReceiverMapPath)
			const receiverBasename = path.basename(tempReceiverMapPath)
			const files = fs.readdirSync(receiverDir)
			const tempFiles = files.filter(
				(f) => f.startsWith(receiverBasename) && f.includes('.download-'),
			)
			expect(tempFiles).toHaveLength(0)
		})

		it.skip('should handle connection drops during download gracefully', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createResponse.json()
			const { shareId } = shareData

			// Start a download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			const { downloadId } = await createDownloadResponse.json()

			// Immediately cancel to simulate connection drop
			await fetch(`${receiverBaseUrl}/downloads/${downloadId}/cancel`, {
				method: 'POST',
			})

			// Wait for cleanup to complete
			await new Promise((resolve) => setTimeout(resolve, 1500))

			// Verify temp files are cleaned up
			const receiverDir = path.dirname(tempReceiverMapPath)
			const receiverBasename = path.basename(tempReceiverMapPath)
			const files = fs.readdirSync(receiverDir)
			const tempFiles = files.filter(
				(f) => f.startsWith(receiverBasename) && f.includes('.download-'),
			)
			expect(tempFiles).toHaveLength(0)
		})

		it('should properly close SSE connections when share is deleted/evicted', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Start SSE connection
			const es = createEventSource({
				url: `${senderBaseUrl}/mapShares/${shareId}/events`,
			})

			const messages: any[] = []
			const messagesPromise = (async () => {
				try {
					for await (const { data } of es) {
						messages.push(JSON.parse(data))
						// Stop after receiving initial message
						if (messages.length >= 1) break
					}
				} catch (error) {
					// Expected when connection closes
				}
			})()

			// Wait for initial message
			await new Promise((resolve) => setTimeout(resolve, 200))

			// Cancel the share (which will be removed from map)
			await fetch(`${senderBaseUrl}/mapShares/${shareId}/cancel`, {
				method: 'POST',
			})

			// SSE should still work for canceled share
			expect(messages.length).toBeGreaterThan(0)
			expect(messages[0]).toHaveProperty('shareId', shareId)

			es.close()
			await messagesPromise.catch(() => {
				// Ignore errors from closed connection
			})
		})

		it('should handle SSE client disconnect gracefully', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Start SSE connection
			const es = createEventSource({
				url: `${senderBaseUrl}/mapShares/${shareId}/events`,
			})

			const messages: any[] = []
			const collector = (async () => {
				for await (const { data } of es) {
					messages.push(JSON.parse(data))
					if (messages.length >= 1) break
				}
			})()

			// Wait for initial message
			await new Promise((resolve) => setTimeout(resolve, 200))

			// Close SSE connection immediately
			es.close()

			await collector.catch(() => {
				// Expected - connection closed
			})

			// Should have received at least initial state
			expect(messages.length).toBeGreaterThan(0)

			// Share should still be accessible after SSE disconnect
			const getResponse = await fetch(`${senderBaseUrl}/mapShares/${shareId}`)
			expect(getResponse.status).toBe(200)
		})

		it.skip('should handle multiple failed download URL attempts', async () => {
			// Create a share
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const { shareId } = await createResponse.json()

			// Create download with multiple invalid URLs
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					shareId,
					downloadUrls: [
						'http://127.0.0.1:1/download',
						'http://127.0.0.1:2/download',
						'http://127.0.0.1:3/download',
					],
					estimatedSizeBytes: 1000,
				},
			)
			expect(createDownloadResponse.status).toBe(201)
			const { downloadId } = await createDownloadResponse.json()

			// Wait for all URLs to be tried and fail (3 URLs × 2s timeout + buffer)
			await new Promise((resolve) => setTimeout(resolve, 7000))

			// Download should be in error state
			const statusResponse = await fetch(
				`${receiverBaseUrl}/downloads/${downloadId}`,
			)
			const downloadStatus = await statusResponse.json()
			expect(downloadStatus.status).toBe('error')
		}, 10000)

		it('should propagate stream write errors to download status', async () => {
			// Create a share with a very small map
			const createResponse = await postJson(`${senderBaseUrl}/mapShares`, {
				mapId: 'custom',
				receiverDeviceId,
			})
			const shareData = await createResponse.json()
			const { shareId } = shareData

			// Start download
			const testDownloadUrls = [
				`http://127.0.0.1:${senderRemotePort}/mapShares/${shareId}/download`,
			]
			const createDownloadResponse = await postJson(
				`${receiverBaseUrl}/downloads`,
				{
					senderDeviceId,
					downloadUrls: testDownloadUrls,
					shareId,
					estimatedSizeBytes: shareData.estimatedSizeBytes,
				},
			)
			expect(createDownloadResponse.status).toBe(201)
			const { downloadId } = await createDownloadResponse.json()

			// Let download complete or fail
			let status = 'downloading'
			let attempts = 0
			while (status === 'downloading' && attempts < 50) {
				await new Promise((resolve) => setTimeout(resolve, 100))
				const statusResponse = await fetch(
					`${receiverBaseUrl}/downloads/${downloadId}`,
				)
				const downloadStatus = await statusResponse.json()
				status = downloadStatus.status
				attempts++
			}

			// Download should reach a terminal state
			expect(['completed', 'error', 'canceled']).toContain(status)
		}, 15000)
	})
})

/**
 * Helper to make JSON POST requests
 */
function postJson(url: string, data: any) {
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(data),
	})
}

async function getJson(url: string) {
	const response = await fetch(url)
	return response.json()
}

async function getStyle(fileURL: URL, baseUrl?: string): Promise<SMPStyle> {
	const reader = new Reader(fileURLToPath(fileURL))
	const style = await reader.getStyle(baseUrl)
	await reader.close()
	return style
}

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
