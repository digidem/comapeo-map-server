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
import {
	DEMOTILES_Z2,
	OSM_BRIGHT_Z6,
	startServers,
	type ServerInstance,
} from './helpers.js'

describe('Map Shares and Downloads', () => {
	describe('Map Shares', () => {
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
			const body = await response.json()
			expect(body).toHaveProperty('code', 'MAP_SHARE_NOT_FOUND')
			expect(body).toHaveProperty('error')
		})

		it('should return 404 for events on non-existent share', async (t) => {
			const { sender } = await startServers(t)
			const response = await sender.get(`mapShares/nonexistent-share-id/events`)
			expect(response.status).toBe(404)
			const body = await response.json()
			expect(body).toHaveProperty('code', 'MAP_SHARE_NOT_FOUND')
		})

		it('should return 404 when creating share for non-existent map', async (t) => {
			const { sender, receiver } = await startServers(t)

			const response = await sender.post('mapShares', {
				json: {
					mapId: 'nonexistent',
					receiverDeviceId: receiver.deviceId,
				},
			})

			expect(response.status).toBe(404)
			const body = await response.json()
			expect(body).toHaveProperty('code', 'MAP_NOT_FOUND')
			expect(body).toHaveProperty('error')
		})

		it('should allow creating multiple shares for the same receiver', async (t) => {
			const { sender, receiver, createShare } = await startServers(t)

			// Create first share
			const share1 = await createShare().json()
			expect(share1).toHaveProperty('shareId')

			// Create second share for the same receiver
			const response2 = await sender.post('mapShares', {
				json: {
					mapId: 'custom',
					receiverDeviceId: receiver.deviceId,
				},
			})
			expect(response2.status).toBe(201)
			const share2 = await response2.json<any>()
			expect(share2).toHaveProperty('shareId')

			// Shares should have different IDs
			expect(share1.shareId).not.toBe(share2.shareId)

			// Both shares should be listed
			const shares = await sender.get('mapShares').json<any[]>()
			expect(shares).toHaveLength(2)
			expect(shares.map((s: any) => s.shareId)).toContain(share1.shareId)
			expect(shares.map((s: any) => s.shareId)).toContain(share2.shareId)
		})
	})

	describe('Downloads', () => {
		it('should create a download and transfer map successfully', async (t) => {
			const { sender, receiver, createShare, createDownload } =
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

			const share = await createShare().json()

			// Now create a download on the receiver using the real share
			const response = await createDownload(share)
			expect(response.status).toBe(201)

			const download = await response.json<any>()
			expect(download).toHaveProperty('downloadId')
			expect(download).toHaveProperty('status', 'downloading')
			expect(download).toHaveProperty('bytesDownloaded', 0)
			expect(download).toHaveProperty('senderDeviceId', sender.deviceId)

			// Check Location header
			const location = response.headers.get('location')
			const downloadFromLocation = await ky.get(location!).json()
			expect(downloadFromLocation).toEqual(download)

			const [receiverEvents, senderEvents] = await Promise.all([
				eventsUntil(receiver, download.downloadId, 'completed'),
				eventsUntil(sender, share.shareId, 'completed'),
			])

			expect(receiverEvents.at(-2)).toHaveProperty(
				'bytesDownloaded',
				share.estimatedSizeBytes,
			)
			expect(senderEvents.at(-2)).toHaveProperty(
				'bytesDownloaded',
				share.estimatedSizeBytes,
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
			const { receiver, createShare, createDownload } = await startServers(t)
			const share = await createShare().json()

			// Now create a download on the receiver using the real share
			const download = await createDownload(share).json<any>()
			const downloads = await receiver.get(`downloads`).json()
			expect(downloads).toEqual([download])
			// Wait for download to complete to clean up background connections
			await eventsUntil(receiver, download.downloadId, 'completed')
		})

		it('should get a specific download', async (t) => {
			const { receiver, createShare, createDownload } = await startServers(t)
			const share = await createShare().json()

			const download = await createDownload(share).json<any>()
			const downloadDetails = await receiver
				.get(`downloads/${download.downloadId}`)
				.json()
			expect(downloadDetails).toEqual(download)
			// Wait for download to complete to clean up background connections
			await eventsUntil(receiver, download.downloadId, 'completed')
		})

		it('should return 404 for non-existent download', async (t) => {
			const { receiver } = await startServers(t.onTestFinished)
			const response = await receiver.get(`downloads/nonexistent-download-id`)
			expect(response.status).toBe(404)
			const body = await response.json()
			expect(body).toHaveProperty('code', 'DOWNLOAD_NOT_FOUND')
			expect(body).toHaveProperty('error')
		})

		it('should return 404 for events on non-existent download', async (t) => {
			const { receiver } = await startServers(t.onTestFinished)
			const response = await receiver.get(
				`downloads/nonexistent-download-id/events`,
			)
			expect(response.status).toBe(404)
			const body = await response.json()
			expect(body).toHaveProperty('code', 'DOWNLOAD_NOT_FOUND')
		})

		it('should return 404 when aborting non-existent download', async (t) => {
			const { receiver } = await startServers(t.onTestFinished)
			const response = await receiver.post(
				`downloads/nonexistent-download-id/abort`,
			)
			expect(response.status).toBe(404)
			const body = await response.json()
			expect(body).toHaveProperty('code', 'DOWNLOAD_NOT_FOUND')
		})

		it('should reject multiple simultaneous downloads of the same share', async (t) => {
			const { createShare, createDownload, receiver } = await startServers(t)

			const share = await createShare().json()

			// Start first download
			const download1 = await createDownload(share).json<any>()
			const completedPromise = eventsUntil(
				receiver,
				download1.downloadId,
				'completed',
			)
			// Wait for first download to start
			await eventsUntil(receiver, download1.downloadId, downloadStarted)

			// Try to start second download while first is in progress
			const download2 = await createDownload(share).json<any>()

			const events = await eventsUntil(receiver, download2.downloadId, 'error')
			// Verify that no bytes were downloaded in the second download
			expect(events.some((e: any) => e.bytesDownloaded > 0)).toBe(false)
			expect(events.at(-1)).toHaveProperty('status', 'error')
			expect(events.at(-1)).toHaveProperty(
				'error.code',
				'DOWNLOAD_SHARE_NOT_PENDING',
			)

			await completedPromise
		}, 2000)

		it('should reject re-downloading a share after previous download completed', async (t) => {
			const { createShare, createDownload, receiver } = await startServers(t)

			const share = await createShare().json()

			// Complete first download
			const download1 = await createDownload(share).json<any>()
			await eventsUntil(receiver, download1.downloadId, 'completed')

			// Start second download of the same share
			const download2 = await createDownload(share).json<any>()
			const events = await eventsUntil(receiver, download2.downloadId, 'error')

			// Second download should fail because share is no longer pending
			// (uses ALREADY_DOWNLOADING error for any non-pending status)
			expect(events.at(-1)).toHaveProperty('status', 'error')
			expect(events.at(-1)).toHaveProperty(
				'error.code',
				'DOWNLOAD_SHARE_NOT_PENDING',
			)
		})
	})

	describe('Cancellation and Abort', () => {
		describe('Sender Cancel', () => {
			it('should allow sender to cancel share before download starts', async (t) => {
				const { createShare, createDownload, sender, receiver } =
					await startServers(t)
				const share = await createShare().json()

				// Cancel the share
				await sender.post(`mapShares/${share.shareId}/cancel`)
				const canceledShare = await sender
					.get(`mapShares/${share.shareId}`)
					.json<any>()
				expect(canceledShare.status).toBe('canceled')

				// Attempt to start download
				const { downloadId } = await createDownload(share).json<any>()
				await delay(10) // Wait a bit for cancellation to propagate

				const download = await receiver.get(`downloads/${downloadId}`).json()
				expect(download).toHaveProperty('status', 'canceled')
			})

			it('should allow sender to cancel share after download starts', async (t) => {
				const { createShare, createDownload, sender, receiver } =
					await startServers(t)
				const share = await createShare().json()

				// Start the download
				const { downloadId } = await createDownload(share).json<any>()
				expect(downloadId).toBeDefined()

				// Wait for download to start
				await eventsUntil(receiver, downloadId, downloadStarted)

				const canceledPromise = eventsUntil(receiver, downloadId, 'canceled')
				// Cancel the share
				await sender.post(`mapShares/${share.shareId}/cancel`)
				// Wait for canceled event
				await canceledPromise

				const download = await receiver.get(`downloads/${downloadId}`).json()
				expect(download).toHaveProperty('status', 'canceled')
			})

			it('should reject cancel on completed share', async (t) => {
				const { createShare, createDownload, sender, receiver } =
					await startServers(t)

				const share = await createShare().json()

				// Start download
				const { downloadId } = await createDownload(share).json<any>()

				// Wait for download to complete using SSE
				await eventsUntil(receiver, downloadId, 'completed')

				// Verify share is completed
				const completedShareData = await sender
					.get(`mapShares/${share.shareId}`)
					.json<any>()
				expect(completedShareData.status).toBe('completed')

				// Try to cancel the completed share
				const cancelResponse = await sender.post(
					`mapShares/${share.shareId}/cancel`,
				)
				expect(cancelResponse.status).toBe(409)
				const cancelError = await cancelResponse.json()
				expect(cancelError).toHaveProperty(
					'code',
					'CANCEL_SHARE_NOT_CANCELABLE',
				)
			})

			it('should return 404 when canceling non-existent share', async (t) => {
				const { sender } = await startServers(t)
				const response = await sender.post(`mapShares/nonexistent-share-id/cancel`)
				expect(response.status).toBe(404)
				const body = await response.json()
				expect(body).toHaveProperty('code', 'MAP_SHARE_NOT_FOUND')
			})

			it('should reject cancel on already canceled share', async (t) => {
				const { createShare, sender } = await startServers(t)
				const share = await createShare().json()

				// Cancel the share
				const firstCancelResponse = await sender.post(
					`mapShares/${share.shareId}/cancel`,
				)
				expect(firstCancelResponse.status).toBe(204)

				// Try to cancel again
				const secondCancelResponse = await sender.post(
					`mapShares/${share.shareId}/cancel`,
				)
				expect(secondCancelResponse.status).toBe(409)
				const cancelError = await secondCancelResponse.json()
				expect(cancelError).toHaveProperty(
					'code',
					'CANCEL_SHARE_NOT_CANCELABLE',
				)
			})

			it('should preserve existing map when sender cancels download', async (t) => {
				const { createShare, createDownload, sender, receiver } =
					await startServers(t)

				// Get original map info
				const originalMapInfo = await receiver
					.get('maps/custom/info')
					.json<any>()
				expect(originalMapInfo.size).toBeGreaterThan(0)

				// Create a share from sender
				const share = await createShare().json()

				// Start the download
				const { downloadId } = await createDownload(share).json<any>()
				expect(downloadId).toBeDefined()

				// Wait for download to start
				await eventsUntil(receiver, downloadId, downloadStarted)

				const canceledPromise = eventsUntil(receiver, downloadId, 'canceled')
				// Cancel the share from sender side
				await sender.post(`mapShares/${share.shareId}/cancel`)
				// Wait for canceled event
				await canceledPromise

				// Verify the original map is still accessible and unchanged
				const afterCancelMapInfo = await receiver
					.get('maps/custom/info')
					.json<any>()
				expect(afterCancelMapInfo.size).toBe(originalMapInfo.size)
				expect(afterCancelMapInfo.mapId).toBe(originalMapInfo.mapId)
			})
		})

		describe('Receiver Decline', () => {
			it('should allow receiver to decline a share', async (t) => {
				const { sender, createShare, receiver } = await startServers(t)
				const { shareId, mapShareUrls } = await createShare().json()

				// Decline it
				const declineResponse = await receiver.post(
					`mapShares/${shareId}/decline`,
					{
						json: {
							reason: 'user_rejected',
							senderDeviceId: sender.deviceId,
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

			it('should reject download after share is declined', async (t) => {
				const { createShare, createDownload, sender, receiver } =
					await startServers(t)

				const share = await createShare().json()

				// Decline the share
				const declineResponse = await receiver.post(
					`mapShares/${share.shareId}/decline`,
					{
						json: {
							reason: 'user_rejected',
							senderDeviceId: sender.deviceId,
							mapShareUrls: share.mapShareUrls,
						},
					},
				)
				expect(declineResponse.status).toBe(204)

				// Try to start download on declined share
				const { downloadId } = await createDownload(share).json<any>()

				// Wait for download events
				const events = await eventsUntil(receiver, downloadId, 'error')
				expect(events.at(-1)).toHaveProperty('status', 'error')
				expect(events.at(-1)).toHaveProperty(
					'error.code',
					'DOWNLOAD_SHARE_DECLINED',
				)
			})

			it('should reject decline on non-pending share', async (t) => {
				const { createShare, sender, receiver } = await startServers(t)

				const share = await createShare().json()

				// Cancel the share first
				await sender.post(`mapShares/${share.shareId}/cancel`)

				const declineResponse = await receiver.post(
					`mapShares/${share.shareId}/decline`,
					{
						json: {
							reason: 'user_rejected',
							senderDeviceId: sender.deviceId,
							mapShareUrls: share.mapShareUrls,
						},
					},
				)
				expect(declineResponse.status).toBe(409)
				const declineError = await declineResponse.json()
				expect(declineError).toHaveProperty('code', 'DECLINE_SHARE_NOT_PENDING')
			})

			it('should return 404 when declining non-existent share', async (t) => {
				const { sender, receiver } = await startServers(t)

				const declineResponse = await receiver.post(
					`mapShares/nonexistent-share-id/decline`,
					{
						json: {
							reason: 'user_rejected',
							senderDeviceId: sender.deviceId,
							mapShareUrls: [`http://127.0.0.1:${sender.remotePort}/mapShares/nonexistent-share-id`],
						},
					},
				)
				expect(declineResponse.status).toBe(404)
				const body = await declineResponse.json()
				expect(body).toHaveProperty('code', 'MAP_SHARE_NOT_FOUND')
			})

			it('should return 502 when local decline cannot connect to sender', async (t) => {
				const { sender, receiver } = await startServers(t)

				// Use an invalid port that won't have anything listening
				const declineResponse = await receiver.post(
					`mapShares/some-share-id/decline`,
					{
						json: {
							reason: 'user_rejected',
							senderDeviceId: sender.deviceId,
							mapShareUrls: ['http://127.0.0.1:1/mapShares/some-share-id'],
						},
					},
				)
				expect(declineResponse.status).toBe(502)
				const body = await declineResponse.json()
				expect(body).toHaveProperty('code', 'DECLINE_CANNOT_CONNECT')
				expect(body).toHaveProperty('error')
			})
		})

		describe('Receiver Abort', () => {
			it('should allow receiver to abort download immediately', async (t) => {
				const { createShare, createDownload, receiver, sender } =
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

				const share = await createShare().json()
				const { downloadId } = await createDownload(share).json<any>()

				// Abort the download immediately
				const cancelResponse = await receiver.post(
					`downloads/${downloadId}/abort`,
				)
				expect(cancelResponse.status).toBe(204)

				await delay(10) // Wait a bit for cancellation to propagate

				const mapShare = await sender.get(`mapShares/${share.shareId}`).json()
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

			it('should allow receiver to abort download after progress', async (t) => {
				const { createShare, createDownload, receiver, sender } =
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

				const share = await createShare().json()
				const { downloadId } = await createDownload(share).json<any>()

				await eventsUntil(receiver, downloadId, downloadStarted)

				const cancelResponse = await receiver.post(
					`downloads/${downloadId}/abort`,
				)
				expect(cancelResponse.status).toBe(204)

				await delay(10) // Wait a bit for cancellation to propagate

				const mapShare = await sender.get(`mapShares/${share.shareId}`).json()
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

			it('should reject abort on completed download', async (t) => {
				const { createShare, createDownload, receiver } = await startServers(t)
				const share = await createShare().json()
				const { downloadId } = await createDownload(share).json<any>()
				// Wait for download to complete
				await eventsUntil(receiver, downloadId, 'completed')
				// Attempt to abort
				const cancelResponse = await receiver.post(
					`downloads/${downloadId}/abort`,
				)
				expect(cancelResponse.status).toBe(409)
				const body = await cancelResponse.json()
				expect(body).toHaveProperty('code', 'ABORT_NOT_DOWNLOADING')
				expect(body).toHaveProperty('error')
			})

			it('should preserve existing map when receiver aborts download', async (t) => {
				const { createShare, createDownload, receiver } = await startServers(t)

				// Get original map info
				const originalMapInfo = await receiver
					.get('maps/custom/info')
					.json<any>()
				expect(originalMapInfo.size).toBeGreaterThan(0)

				// Create a share from sender
				const share = await createShare().json()

				// Start the download
				const { downloadId } = await createDownload(share).json<any>()
				expect(downloadId).toBeDefined()

				const es = createEventSource(
					`${receiver.localBaseUrl}${receiver.eventsPath(downloadId)}`,
				)
				// Wait for download to start
				await eventsUntil(receiver, downloadId, downloadStarted)

				const abortedPromise = eventsUntil(receiver, downloadId, 'aborted')
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

			it('should clean up temp files when download is aborted', async (t) => {
				const { createShare, createDownload, receiver } = await startServers(t)
				const receiverDir = path.dirname(receiver.customMapPath)
				const receiverBasename = path.basename(receiver.customMapPath)

				const share = await createShare().json()
				const { downloadId } = await createDownload(share).json<any>()

				// Wait for download to start
				await eventsUntil(receiver, downloadId, downloadStarted)

				// check temp file exists
				{
					const files = fs.readdirSync(receiverDir)
					const hasTempFile = files.find(
						(f) => f.startsWith(receiverBasename) && f.includes('.download-'),
					)
					expect(hasTempFile).toBeDefined()
				}

				const abortedPromise = eventsUntil(receiver, downloadId, 'aborted')
				// Abort the download to trigger cleanup
				await receiver.post(`downloads/${downloadId}/abort`)
				// Wait for aborted event
				await abortedPromise

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
	})

	describe('SSE Events', () => {
		it('should stream abort updates to sender when receiver aborts', async (t) => {
			const { createShare, createDownload, sender, receiver } =
				await startServers(t)
			const share = await createShare().json()

			const eventsPromise = eventsUntil(sender, share.shareId, 'aborted')
			// Start the download
			const { downloadId } = await createDownload(share).json<any>()
			expect(downloadId).toBeDefined()

			// Wait for download to start
			await eventsUntil(receiver, downloadId, downloadStarted)

			// Receiver aborts the download
			await receiver.post(`downloads/${downloadId}/abort`)

			const events = await eventsPromise

			// First message should be initial state (pending)
			expect(events[0]).toHaveProperty('status', 'pending')
			expect(events[0]).toHaveProperty('shareId', share.shareId)

			// At least one progress message
			expect(
				events.some((e) => e.status === 'downloading' && e.bytesDownloaded > 0),
			).toBe(true)

			// Final message should be aborted
			expect(events.at(-1)).toHaveProperty('status', 'aborted')
		})

		it('should stream cancel updates to receiver when sender cancels', async (t) => {
			const { createShare, createDownload, sender, receiver } =
				await startServers(t)
			const share = await createShare().json()

			// Start the download
			const { downloadId } = await createDownload(share).json<any>()
			expect(downloadId).toBeDefined()

			const eventsPromise = eventsUntil(receiver, downloadId, 'canceled')
			// Wait for download to start
			await eventsUntil(receiver, downloadId, downloadStarted)

			// Cancel the share
			await sender.post(`mapShares/${share.shareId}/cancel`)
			const events = await eventsPromise

			// First message should have shareId
			expect(events[0]).toHaveProperty('shareId', share.shareId)

			// At least one progress message
			expect(
				events.some((e) => e.status === 'downloading' && e.bytesDownloaded > 0),
			).toBe(true)

			// Final message should be canceled
			expect(events.at(-1)).toHaveProperty('status', 'canceled')
		})

		it('should handle concurrent SSE connections to same share', async (t) => {
			const { createShare, sender } = await startServers(t)

			const share = await createShare().json()

			// Start two SSE connections to the same share
			const messages1Promise = eventsUntil(sender, share.shareId, 'canceled')
			const messages2Promise = eventsUntil(sender, share.shareId, 'canceled')
			// Trigger an update
			await sender.post(`mapShares/${share.shareId}/cancel`)

			const [messages1, messages2] = await Promise.all([
				messages1Promise,
				messages2Promise,
			])

			// Both connections should have received messages
			expect(messages1.at(-1)).toHaveProperty('status', 'canceled')
			expect(messages2.at(-1)).toHaveProperty('status', 'canceled')
		})

		it('should send current state when SSE client reconnects', async (t) => {
			const { createShare, createDownload, sender, receiver } =
				await startServers(t)
			const share = await createShare().json()

			// Start first SSE connection
			const es1 = createEventSource(
				`${sender.localBaseUrl}${sender.eventsPath(share.shareId)}`,
			)

			// Wait for initial state
			const initialEvents = await eventsUntilEs(es1, 'pending')
			expect(initialEvents[0]).toHaveProperty('status', 'pending')
			es1.close()

			// Start download to change state
			const { downloadId } = await createDownload(share).json<any>()
			await eventsUntil(receiver, downloadId, 'completed')

			// Reconnect - should receive current (completed) state
			const es2 = createEventSource(
				`${sender.localBaseUrl}${sender.eventsPath(share.shareId)}`,
			)
			const reconnectEvents = await eventsUntilEs(es2, 'completed')
			es2.close()

			// First message after reconnect should be current state (completed)
			expect(reconnectEvents[0]).toHaveProperty('status', 'completed')
		})
	})

	describe('Access Control', () => {
		describe('Localhost-Only Protection', () => {
			it('should reject map share creation from non-localhost', async (t) => {
				const { sender, receiver } = await startServers(t)
				const response = await secretStreamFetch(
					`${sender.remoteBaseUrl}/mapShares`,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							mapId: 'custom',
							receiverDeviceId: receiver.deviceId,
						}),
					},
				)
				expect(response.status).toBe(403)
			})

			it('should reject download creation from non-localhost', async (t) => {
				const { sender, receiver } = await startServers(t)

				const response = await secretStreamFetch(
					`${receiver.remoteBaseUrl}/downloads`,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							senderDeviceId: sender.deviceId,
							shareId: 'test-share',
							mapShareUrls: ['http://example.com/download'],
							estimatedSizeBytes: 1000,
						}),
					},
				)

				expect(response.status).toBe(403)
			})

			it('should reject map share cancel from non-localhost', async (t) => {
				const { sender, createShare } = await startServers(t)
				const { shareId } = await createShare().json()
				const response = await secretStreamFetch(
					`${sender.remoteBaseUrl}/mapShares/${shareId}/cancel`,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
						},
					},
				)

				expect(response.status).toBe(403)
			})

			it('should reject map share list from non-localhost', async (t) => {
				const { sender } = await startServers(t)
				const response = await secretStreamFetch(
					`${sender.remoteBaseUrl}/mapShares`,
					{
						method: 'GET',
						headers: {
							'Content-Type': 'application/json',
						},
					},
				)

				expect(response.status).toBe(403)
			})

			it('should reject map share events from non-localhost', async (t) => {
				const { sender, createShare } = await startServers(t)
				const { shareId } = await createShare().json()
				const response = await secretStreamFetch(
					`${sender.remoteBaseUrl}/mapShares/${shareId}/events`,
				)
				expect(response.status).toBe(403)
			})

			it('should reject download routes from non-localhost', async (t) => {
				const { receiver, createShare, createDownload } = await startServers(t)
				const share = await createShare().json()
				const { downloadId } = await createDownload(share).json<any>()

				const responsePromises = []
				for (const route of [
					`downloads`,
					`downloads/${downloadId}`,
					`downloads/${downloadId}/events`,
				]) {
					responsePromises.push(
						secretStreamFetch(`${receiver.remoteBaseUrl}/${route}`),
					)
				}
				const responses = await Promise.all(responsePromises)
				for (const response of responses) {
					expect(response.status).toBe(403)
				}

				// Abort download to clean up background connections
				await receiver.post(`downloads/${downloadId}/abort`)
			})

			it('should reject download cancel from non-localhost', async (t) => {
				const { receiver, createShare, createDownload } = await startServers(t)
				const share = await createShare().json()
				const { downloadId } = await createDownload(share).json<any>()
				const response = await secretStreamFetch(
					`${receiver.remoteBaseUrl}/downloads/${downloadId}/cancel`,
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

		describe('Device ID Validation', () => {
			it('should return 404 when downloading non-existent share', async (t) => {
				const { sender, receiver } = await startServers(t)

				const downloadUrl = `http://127.0.0.1:${sender.remotePort}/mapShares/nonexistent-share-id/download`
				const response = (await secretStreamFetch(downloadUrl, {
					dispatcher: new SecretStreamAgent({
						keyPair: receiver.keyPair,
						remotePublicKey: sender.keyPair.publicKey,
					}),
				})) as unknown as Response

				expect(response.status).toBe(404)
			})

			it('should reject share access with wrong device ID', async (t) => {
				const { sender, receiver } = await startServers(t)

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
				const shareInfoUrl2 = `http://127.0.0.1:${sender.remotePort}/mapShares/${shareId2}`
				const response2 = (await secretStreamFetch(shareInfoUrl2, {
					dispatcher: new SecretStreamAgent({
						keyPair: receiver.keyPair, // Using receiver's keypair
						remotePublicKey: sender.keyPair.publicKey,
					}),
				})) as unknown as Response

				// Should get 403 Forbidden because receiver is not the intended recipient
				expect(response2.status).toBe(403)
			})

			it('should reject download with wrong device ID', async (t) => {
				const { sender, receiver } = await startServers(t)

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
				const downloadUrl = `http://127.0.0.1:${sender.remotePort}/mapShares/${shareId}/download`

				const response = (await secretStreamFetch(downloadUrl, {
					dispatcher: new SecretStreamAgent({
						keyPair: receiver.keyPair, // Using receiver's keypair
						remotePublicKey: sender.keyPair.publicKey,
					}),
				})) as unknown as Response

				// Should get 403 Forbidden
				expect(response.status).toBe(403)
			})

			it('should allow share access with correct device ID', async (t) => {
				const { createShare, sender, receiver } = await startServers(t)

				// Create a share for receiver
				const { shareId } = await createShare().json()

				// Access with correct credentials (receiver's device)
				const shareInfoUrl = `http://127.0.0.1:${sender.remotePort}/mapShares/${shareId}`
				const response = (await secretStreamFetch(shareInfoUrl, {
					dispatcher: new SecretStreamAgent({
						keyPair: receiver.keyPair, // Using receiver's keypair
						remotePublicKey: sender.keyPair.publicKey,
					}),
				})) as unknown as Response

				// Should succeed
				expect(response.status).toBe(200)
				const shareInfo = await response.json()
				expect(shareInfo.shareId).toBe(shareId)
				expect(shareInfo.receiverDeviceId).toBe(receiver.deviceId)
			})

			it('should reject decline with wrong device ID', async (t) => {
				const { sender, receiver } = await startServers(t)

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
				const declineUrl = `http://127.0.0.1:${sender.remotePort}/mapShares/${shareId}/decline`
				const response = (await secretStreamFetch(declineUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ reason: 'no-space' }),
					dispatcher: new SecretStreamAgent({
						keyPair: receiver.keyPair, // Using receiver's keypair
						remotePublicKey: sender.keyPair.publicKey,
					}),
				})) as unknown as Response

				// Should get 403 Forbidden
				expect(response.status).toBe(403)
			})

			it('should reject remote decline with invalid body', async (t) => {
				const { createShare, sender, receiver } = await startServers(t)
				const { shareId } = await createShare().json()

				const invalidBodies = [
					{}, // Missing reason
					{ reason: 123 }, // Invalid type for reason
					{ reason: '' }, // Empty reason
				]

				for (const body of invalidBodies) {
					const declineUrl = `http://127.0.0.1:${sender.remotePort}/mapShares/${shareId}/decline`
					const response = (await secretStreamFetch(declineUrl, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(body),
						dispatcher: new SecretStreamAgent({
							keyPair: receiver.keyPair,
							remotePublicKey: sender.keyPair.publicKey,
						}),
					})) as unknown as Response

					expect(response.status).toBe(400)
				}
			})

			it('should reject remote decline with malformed JSON', async (t) => {
				const { createShare, sender, receiver } = await startServers(t)
				const { shareId } = await createShare().json()

				const declineUrl = `http://127.0.0.1:${sender.remotePort}/mapShares/${shareId}/decline`
				const response = (await secretStreamFetch(declineUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: 'not valid json',
					dispatcher: new SecretStreamAgent({
						keyPair: receiver.keyPair,
						remotePublicKey: sender.keyPair.publicKey,
					}),
				})) as unknown as Response

				expect(response.status).toBe(400)
			})

			it('should pass through error from sender when remote decline fails', async (t) => {
				const { createShare, sender, receiver } = await startServers(t)
				const share = await createShare().json()

				// First, cancel the share so decline will fail with DECLINE_SHARE_NOT_PENDING
				await sender.post(`mapShares/${share.shareId}/cancel`)

				// Now try to decline remotely - should get the error passed through
				const declineUrl = `http://127.0.0.1:${sender.remotePort}/mapShares/${share.shareId}/decline`
				const response = (await secretStreamFetch(declineUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ reason: 'user_rejected' }),
					dispatcher: new SecretStreamAgent({
						keyPair: receiver.keyPair,
						remotePublicKey: sender.keyPair.publicKey,
					}),
				})) as unknown as Response

				expect(response.status).toBe(409)
				const error = await response.json()
				expect(error).toHaveProperty('code', 'DECLINE_SHARE_NOT_PENDING')
			})
		})
	})

	describe('Validation', () => {
		describe('Map Share Validation', () => {
			it('should reject map share with invalid body', async (t) => {
				const { sender, receiver } = await startServers(t)
				const invalidBodies = [
					{
						// Missing receiverDeviceId
						mapId: 'custom',
					},
					{
						// Missing mapId
						receiverDeviceId: receiver.deviceId,
					},
					{
						// Invalid type for mapId
						mapId: 123,
						receiverDeviceId: receiver.deviceId,
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
					const body = await response.json()
					expect(body).toHaveProperty('code', 'INVALID_REQUEST')
					expect(body).toHaveProperty('error')
				}
			})

			it('should reject decline with invalid body', async (t) => {
				const { sender, receiver, createShare } = await startServers(t)
				const { shareId, mapShareUrls } = await createShare().json()

				const invalidBodies = [
					{
						// Missing senderDeviceId and mapShareUrls
						reason: 'user_rejected',
					},
					{
						// Missing mapShareUrls
						reason: 'user_rejected',
						senderDeviceId: sender.deviceId,
					},
					{
						// Missing senderDeviceId
						reason: 'user_rejected',
						mapShareUrls,
					},
					{
						// Missing reason
						senderDeviceId: sender.deviceId,
						mapShareUrls,
					},
					{
						// Invalid type for reason
						reason: 123,
						senderDeviceId: sender.deviceId,
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
						senderDeviceId: sender.deviceId,
						mapShareUrls: 'not-an-array',
					},
					{
						// Empty mapShareUrls array
						reason: 'user_rejected',
						senderDeviceId: sender.deviceId,
						mapShareUrls: [],
					},
					{
						// Invalid URLs in mapShareUrls
						reason: 'user_rejected',
						senderDeviceId: sender.deviceId,
						mapShareUrls: ['not-a-url'],
					},
				]

				for (const json of invalidBodies) {
					const response = await receiver.post(`mapShares/${shareId}/decline`, {
						json,
					})

					expect(response.status).toBe(400)
					const body = await response.json()
					expect(body).toHaveProperty('code', 'INVALID_REQUEST')
					expect(body).toHaveProperty('error')
				}
			})
		})

		describe('Download Validation', () => {
			it('should reject download with invalid body', async (t) => {
				const { sender, receiver } = await startServers(t)
				const invalidBodies = [
					{
						// Missing senderDeviceId
						shareId: 'test-share',
						mapShareUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					},
					{
						// Missing shareId
						senderDeviceId: sender.deviceId,
						mapShareUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					},
					{
						// Missing mapShareUrls
						senderDeviceId: sender.deviceId,
						shareId: 'test-share',
						estimatedSizeBytes: 1000,
					},
					{
						// Missing estimatedSizeBytes
						senderDeviceId: sender.deviceId,
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
						senderDeviceId: sender.deviceId,
						shareId: 123,
						mapShareUrls: ['http://example.com/download'],
						estimatedSizeBytes: 1000,
					},
					{
						// Invalid type for mapShareUrls (not array)
						senderDeviceId: sender.deviceId,
						shareId: 'test-share',
						mapShareUrls: 'not-an-array',
						estimatedSizeBytes: 1000,
					},
					{
						// Empty mapShareUrls array
						senderDeviceId: sender.deviceId,
						shareId: 'test-share',
						mapShareUrls: [],
						estimatedSizeBytes: 1000,
					},
					{
						// Invalid URLs in mapShareUrls
						senderDeviceId: sender.deviceId,
						shareId: 'test-share',
						mapShareUrls: ['not-a-url'],
						estimatedSizeBytes: 1000,
					},
					{
						// Invalid type for estimatedSizeBytes
						senderDeviceId: sender.deviceId,
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
					const body = await response.json()
					expect(body).toHaveProperty('code', 'INVALID_REQUEST')
					expect(body).toHaveProperty('error')
				}
			})

			it('should reject download with invalid sender device ID format', async (t) => {
				const { receiver } = await startServers(t)

				const response = await receiver.post('downloads', {
					json: {
						senderDeviceId: 'not-a-valid-z32-encoded-public-key',
						shareId: 'test-share',
						mapShareUrls: ['http://127.0.0.1:1/mapShares/test-share'],
						estimatedSizeBytes: 1000,
					},
				})

				expect(response.status).toBe(400)
				const error = await response.json()
				expect(error).toHaveProperty('code', 'INVALID_SENDER_DEVICE_ID')
			})

			it('should reject download with sender device ID of wrong length', async (t) => {
				const { receiver } = await startServers(t)

				// Valid z32 encoding but only 16 bytes instead of 32
				const shortKey = z32.encode(new Uint8Array(16))

				const response = await receiver.post('downloads', {
					json: {
						senderDeviceId: shortKey,
						shareId: 'test-share',
						mapShareUrls: ['http://127.0.0.1:1/mapShares/test-share'],
						estimatedSizeBytes: 1000,
					},
				})

				expect(response.status).toBe(400)
				const error = await response.json()
				expect(error).toHaveProperty('code', 'INVALID_SENDER_DEVICE_ID')
			})
		})

		describe('Map Upload/Delete Validation', () => {
			it('should reject PUT to non-custom map', async (t) => {
				const { sender } = await startServers(t)
				const response = await sender.put('maps/someotherid', {
					body: 'some data',
				})

				expect(response.status).toBe(404)
				const body = await response.json()
				expect(body).toHaveProperty('code', 'MAP_NOT_FOUND')
				expect(body).toHaveProperty('error')
			})

			it('should reject PUT with empty body', async (t) => {
				const { sender } = await startServers(t)
				const response = await sender.put('maps/custom', {
					body: '',
				})

				expect(response.status).toBe(400)
				const body = await response.json()
				// Empty body reaches map validation which returns INVALID_MAP_FILE
				expect(body).toHaveProperty('code', 'INVALID_MAP_FILE')
				expect(body).toHaveProperty('error')
			})

			it('should reject DELETE of non-custom map', async (t) => {
				const { sender } = await startServers(t)
				const response = await sender.delete('maps/default')

				expect(response.status).toBe(404)
				const body = await response.json()
				expect(body).toHaveProperty('code', 'MAP_NOT_FOUND')
			})
		})
	})

	describe('Error Handling', () => {
		it('should update status to error on download failure', async (t) => {
			const { createShare, sender, receiver } = await startServers(t)

			const { shareId } = await createShare().json()

			// Try to create download with invalid URLs
			const createDownloadResponse = await receiver.post('downloads', {
				json: {
					senderDeviceId: sender.deviceId,
					shareId,
					mapShareUrls: ['http://127.0.0.1:1/download'],
					estimatedSizeBytes: 1000,
				},
			})
			expect(createDownloadResponse.status).toBe(201)
			const { downloadId } = await createDownloadResponse.json<any>()

			// Wait for download to fail and cleanup to complete
			await eventsUntil(receiver, downloadId, 'error')

			// Check that download is in error state
			const downloadStatus = await receiver
				.get(`downloads/${downloadId}`)
				.json<any>()
			expect(downloadStatus.status).toBe('error')
			expect(downloadStatus).toHaveProperty('error.code', 'DOWNLOAD_ERROR')
		})

		it('should clean up temp files on download error', async (t) => {
			const { createShare, sender, receiver } = await startServers(t)
			const receiverDir = path.dirname(receiver.customMapPath)
			const receiverBasename = path.basename(receiver.customMapPath)

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
						senderDeviceId: sender.deviceId,
						shareId,
						mapShareUrls: [`http://0.0.0.0:9999/invalid-download-path`],
						estimatedSizeBytes: 1000,
					},
				})
				.json<any>()

			// Wait for download to fail and cleanup to complete
			await eventsUntil(receiver, downloadId, 'error')

			// Verify no temp files are left behind
			const files = fs.readdirSync(receiverDir)
			const tempFiles = files.filter(
				(f) => f.startsWith(receiverBasename) && f.includes('.download-'),
			)
			expect(tempFiles).toHaveLength(0)
		})

		it('should try next URL when first mapShareUrl fails during download', async (t) => {
			const { createShare, sender, receiver } = await startServers(t)

			const share = await createShare().json()

			// Create download with first URL invalid, second URL valid
			const createDownloadResponse = await receiver.post('downloads', {
				json: {
					senderDeviceId: sender.deviceId,
					shareId: share.shareId,
					// First URL is invalid (port 1), second is the real one
					mapShareUrls: [
						'http://127.0.0.1:1/mapShares/' + share.shareId,
						...share.mapShareUrls,
					],
					estimatedSizeBytes: share.estimatedSizeBytes,
				},
			})
			expect(createDownloadResponse.status).toBe(201)
			const { downloadId } = await createDownloadResponse.json<any>()

			// Download should complete successfully using the second URL
			const events = await eventsUntil(receiver, downloadId, 'completed')
			expect(events.at(-1)).toHaveProperty('status', 'completed')
		})

		it('should try next URL when first mapShareUrl fails during local decline', async (t) => {
			const { createShare, sender, receiver } = await startServers(t)

			const share = await createShare().json()

			// Decline with first URL invalid, second URL valid
			const declineResponse = await receiver.post(
				`mapShares/${share.shareId}/decline`,
				{
					json: {
						reason: 'user_rejected',
						senderDeviceId: sender.deviceId,
						// First URL is invalid (port 1), second is the real one
						mapShareUrls: [
							'http://127.0.0.1:1/mapShares/' + share.shareId,
							...share.mapShareUrls,
						],
					},
				},
			)
			expect(declineResponse.status).toBe(204)

			// Verify share was declined on sender
			const shareStatus = await sender
				.get(`mapShares/${share.shareId}`)
				.json<any>()
			expect(shareStatus.status).toBe('declined')
			expect(shareStatus.reason).toBe('user_rejected')
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

/**
 * Condition to check if a download has started (bytesDownloaded > 0).
 * Use with eventsUntil to wait for download progress to begin.
 */
function downloadStarted(msg: EventSourceMessage): boolean {
	return JSON.parse(msg.data).bytesDownloaded > 0
}

/**
 * Wait for events on an existing EventSourceClient until a condition is met.
 * Does NOT close the event source - caller is responsible for closing it.
 */
async function eventsUntilEs(
	es: EventSourceClient,
	statusOrCondition: string | ((msg: EventSourceMessage) => boolean),
): Promise<any[]> {
	const events: any[] = []
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

/**
 * Wait for events until a condition is met, automatically creating and closing the EventSourceClient.
 */
async function eventsUntil(
	instance: ServerInstance,
	id: string,
	statusOrCondition: string | ((msg: EventSourceMessage) => boolean),
): Promise<any[]> {
	const es = createEventSource(
		`${instance.localBaseUrl}${instance.eventsPath(id)}`,
	)
	try {
		return await eventsUntilEs(es, statusOrCondition)
	} finally {
		es.close()
	}
}
