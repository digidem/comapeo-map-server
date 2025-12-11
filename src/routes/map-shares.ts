import os from 'node:os'

import { IRequestStrict, IttyRouter, StatusError } from 'itty-router'
import { Type as T } from 'typebox'

import type { Context } from '../context.js'
import { createEventStreamResponse } from '../lib/event-stream-response.js'
import { MapShare } from '../lib/map-share.js'
import { SelfEvictingTimeoutMap } from '../lib/self-evicting-map.js'
import { timingSafeEqual } from '../lib/utils.js'
import { localhostOnly } from '../middlewares/localhost-only.js'
import { parseRequest } from '../middlewares/parse-request.js'
import {
	MapShareDeclineReason,
	MapShareState,
	type FetchContext,
	type RouterExternal,
} from '../types.js'

const MapShareCreateRequest = T.Object({
	mapId: T.String(),
	receiverDeviceId: T.String(),
})

const MapShareDeclineRequest = T.Object({
	reason: MapShareDeclineReason,
})

export function MapSharesRouter(
	{ base }: { base: string },
	ctx: Context,
): RouterExternal {
	const mapShares = new SelfEvictingTimeoutMap<string, MapShare>()

	const router = IttyRouter<IRequestStrict, [FetchContext]>({ base })

	// These routes are only accessible from localhost (local API)

	router.post(
		'/',
		localhostOnly,
		parseRequest(MapShareCreateRequest),
		async (request) => {
			const { mapId, receiverDeviceId } = request.parsed
			const mapInfo = await ctx.getMapInfo(mapId)
			const mapShare = new MapShare({
				...mapInfo,
				receiverDeviceId,
				baseUrls: getRemoteBaseUrls(request.url, await ctx.getRemotePort()),
			})
			mapShares.set(mapShare.shareId, mapShare)
			return Response.json(mapShare.state, {
				status: 201,
				headers: {
					Location: new URL(mapShare.shareId, request.url).href,
				},
			})
		},
	)

	router.get('/', localhostOnly, () => {
		return Array.from(mapShares.values()).map((ms) => ms.state)
	})

	router.get(
		'/:shareId/events',
		localhostOnly,
		async (request): Promise<Response> => {
			const mapShare = getMapShare(request.params.shareId)
			return createEventStreamResponse(mapShare, { signal: request.signal })
		},
	)

	router.post(
		'/:shareId/cancel',
		localhostOnly,
		async (request): Promise<Response> => {
			const mapShare = getMapShare(request.params.shareId)
			mapShare.cancel()
			return new Response(null, { status: 204 })
		},
	)

	// These routes can be accessed by a remote peer, but the peer deviceId must
	// match the receiverDeviceId on the map share

	router.all('/:shareId*', async (request, { remoteDeviceId, isLocalhost }) => {
		if (isLocalhost) return
		if (!remoteDeviceId) {
			throw new StatusError(403, 'Forbidden')
		}
		const mapShare = getMapShare(request.params.shareId)
		if (!timingSafeEqual(remoteDeviceId, mapShare.state.receiverDeviceId)) {
			throw new StatusError(403, 'Forbidden')
		}
	})

	router.get('/:shareId', async (request): Promise<MapShareState> => {
		return getMapShare(request.params.shareId).state
	})

	router.get('/:shareId/download', async (request): Promise<Response> => {
		const mapShare = getMapShare(request.params.shareId)
		const stream = ctx.createMapReadableStream(mapShare.state.mapId)
		return mapShare.downloadResponse(stream)
	})

	router.post(
		'/:shareId/decline',
		parseRequest(MapShareDeclineRequest),
		async (request): Promise<Response> => {
			const mapShare = getMapShare(request.params.shareId)
			mapShare.decline(request.parsed.reason)
			return new Response(null, { status: 204 })
		},
	)

	return router

	function getMapShare(shareId: string) {
		const mapShare = mapShares.get(shareId)
		if (!mapShare) {
			throw new StatusError(404, 'Map share not found')
		}
		return mapShare
	}
}

/**
 * Get the base URLs for downloads for all non-internal IPv4 addresses of the machine
 */
function getRemoteBaseUrls(requestUrl: string, remotePort: number): string[] {
	requestUrl = requestUrl.endsWith('/') ? requestUrl : requestUrl + '/'
	const interfaces = os.networkInterfaces()
	const baseUrls: string[] = []
	for (const iface of Object.values(interfaces)) {
		if (!iface) continue
		for (const addr of iface) {
			if (addr.family === 'IPv4' && !addr.internal) {
				const url = new URL(requestUrl)
				url.hostname = addr.address
				url.port = remotePort.toString()
				baseUrls.push(url.toString())
			}
		}
	}
	return baseUrls
}
