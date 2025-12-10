import { IttyRouter, StatusError } from 'itty-router'
import { Type as T, type Static } from 'typebox'

import { CUSTOM_MAP_ID } from '../lib/constants.js'
import { DownloadRequest } from '../lib/download-request.js'
import { createEventStreamResponse } from '../lib/event-stream-response.js'
import { localhostOnly } from '../middlewares/localhost-only.js'
import { parseRequest } from '../middlewares/parse-request.js'
import {
	Context,
	DownloadUrls,
	EstimatedSizeBytes,
	ShareId,
	type RouterExternal,
} from '../types.js'

const DownloadCreateRequest = T.Object({
	senderDeviceId: T.String({
		description: 'The ID of the device that is sending the map share',
	}),
	downloadUrls: DownloadUrls,
	shareId: ShareId,
	estimatedSizeBytes: EstimatedSizeBytes,
})

export type DownloadCreateRequest = Static<typeof DownloadCreateRequest>

export function createDownloadsRouter(
	{ base }: { base: string },
	ctx: Context,
): RouterExternal {
	const downloads = new Map<string, DownloadRequest>()
	const router = IttyRouter({ base })

	router.all('*', localhostOnly)

	router.post('/', parseRequest(DownloadCreateRequest), async (request) => {
		const writable = ctx.getMapWritableStream(CUSTOM_MAP_ID)
		const download = new DownloadRequest(writable, request.parsed)
		downloads.set(download.state.downloadId, download)
		return Response.json(download.state, {
			status: 201,
			headers: {
				Location: new URL(download.state.downloadId, request.url).href,
			},
		})
	})

	router.get('/:downloadId', async (request) => {
		return getDownload(request.params.downloadId).state
	})

	router.get('/:downloadId/events', async (request): Promise<Response> => {
		const download = getDownload(request.params.downloadId)
		return createEventStreamResponse(download, { signal: request.signal })
	})

	router.post('/:downloadId/cancel', async (request): Promise<Response> => {
		const download = getDownload(request.params.downloadId)
		download.cancel()
		return new Response(null, { status: 204 })
	})

	return router

	function getDownload(downloadId: string): DownloadRequest {
		const download = downloads.get(downloadId)
		if (!download) {
			throw new StatusError(404, 'Download not found')
		}
		return download
	}
}
