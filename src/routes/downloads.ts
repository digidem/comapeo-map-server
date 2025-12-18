import { IttyRouter } from 'itty-router'
import { Type as T, type Static } from 'typebox'

import type { Context } from '../context.js'
import { CUSTOM_MAP_ID } from '../lib/constants.js'
import { DownloadRequest } from '../lib/download-request.js'
import { errors } from '../lib/errors.js'
import { createEventStreamResponse } from '../lib/event-stream-response.js'
import { SelfEvictingTimeoutMap } from '../lib/self-evicting-map.js'
import { addTrailingSlash } from '../lib/utils.js'
import { parseRequest } from '../middlewares/parse-request.js'
import {
	MapShareUrls,
	EstimatedSizeBytes,
	ShareId,
	type RouterExternal,
} from '../types.js'

const DownloadCreateRequest = T.Object({
	senderDeviceId: T.String({
		minLength: 1,
		description: 'The ID of the device that is sending the map share',
	}),
	mapShareUrls: MapShareUrls,
	shareId: ShareId,
	estimatedSizeBytes: EstimatedSizeBytes,
})

export type DownloadCreateRequest = Static<typeof DownloadCreateRequest>

export function DownloadsRouter(
	{ base }: { base: string },
	ctx: Context,
): RouterExternal {
	const downloads = new SelfEvictingTimeoutMap<string, DownloadRequest>()
	const router = IttyRouter({ base })

	router.post('/', parseRequest(DownloadCreateRequest), async (request) => {
		const writable = ctx.createMapWritableStream(CUSTOM_MAP_ID)
		const download = new DownloadRequest(
			writable,
			request.parsed,
			ctx.getKeyPair(),
		)
		downloads.set(download.state.downloadId, download)
		return Response.json(download.state, {
			status: 201,
			headers: {
				Location: new URL(
					download.state.downloadId,
					addTrailingSlash(request.url),
				).href,
			},
		})
	})

	router.get('/', () => {
		return Array.from(downloads.values()).map((d) => d.state)
	})

	router.get('/:downloadId', async (request) => {
		return getDownload(request.params.downloadId).state
	})

	router.get('/:downloadId/events', async (request): Promise<Response> => {
		const download = getDownload(request.params.downloadId)
		return createEventStreamResponse(download, { signal: request.signal })
	})

	router.post('/:downloadId/abort', async (request): Promise<Response> => {
		const download = getDownload(request.params.downloadId)
		if (download.state.status !== 'downloading') {
			throw new errors.ABORT_NOT_DOWNLOADING(
				`Cannot abort download in status '${download.state.status}'`,
			)
		}
		download.cancel()
		return new Response(null, { status: 204 })
	})

	return router

	function getDownload(downloadId: string): DownloadRequest {
		const download = downloads.get(downloadId)
		if (!download) {
			throw new errors.DOWNLOAD_NOT_FOUND(
				`Download ID not found: ${downloadId}`,
			)
		}
		return download
	}
}
