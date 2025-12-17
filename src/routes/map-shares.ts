import os from 'node:os'

import {
	IRequestStrict,
	IttyRouter,
	StatusError,
	type RequestHandler,
} from 'itty-router'
import {
	fetch as secretStreamFetch,
	Agent as SecretStreamAgent,
} from 'secret-stream-http'
import { Type as T, type Static } from 'typebox'
import { Compile } from 'typebox/compile'
import z32 from 'z32'

import type { Context } from '../context.js'
import { createEventStreamResponse } from '../lib/event-stream-response.js'
import { MapShare } from '../lib/map-share.js'
import { SelfEvictingTimeoutMap } from '../lib/self-evicting-map.js'
import { addTrailingSlash, timingSafeEqual } from '../lib/utils.js'
import { localhostOnly } from '../middlewares/localhost-only.js'
import { parseRequest } from '../middlewares/parse-request.js'
import {
	DeclineUrls,
	MapShareDeclineReason,
	MapShareState,
	type FetchContext,
	type RouterExternal,
} from '../types.js'

const MapShareCreateRequest = T.Object({
	mapId: T.String(),
	receiverDeviceId: T.String(),
})

const LocalMapShareDeclineRequest = T.Object({
	reason: MapShareDeclineReason,
	declineUrls: DeclineUrls,
	senderDeviceId: T.String({
		description: 'The ID of the device that is sending the map share',
	}),
})

const RemoteMapShareDeclineRequest = T.Object({
	reason: MapShareDeclineReason,
})

const CompiledLocalMapShareDeclineRequest = Compile(LocalMapShareDeclineRequest)
const CompiledRemoteMapShareDeclineRequest = Compile(
	RemoteMapShareDeclineRequest,
)

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
					Location: new URL(mapShare.shareId, addTrailingSlash(request.url))
						.href,
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

	const validateRemoteDeviceId = async (
		request: IRequestStrict,
		{ remoteDeviceId, isLocalhost }: FetchContext,
	) => {
		if (isLocalhost) return
		if (!remoteDeviceId) {
			throw new StatusError(403, 'Forbidden')
		}
		const mapShare = getMapShare(request.params.shareId)
		if (!timingSafeEqual(remoteDeviceId, mapShare.state.receiverDeviceId)) {
			throw new StatusError(403, 'Forbidden')
		}
	}

	router.all('/:shareId', validateRemoteDeviceId)
	router.all('/:shareId/*', validateRemoteDeviceId)

	router.get('/:shareId', async (request): Promise<MapShareState> => {
		return getMapShare(request.params.shareId).state
	})

	router.get('/:shareId/download', async (request): Promise<Response> => {
		console.log('Download requested for map share', request.params.shareId)
		const mapShare = getMapShare(request.params.shareId)
		console.log('Starting download for map share', mapShare.shareId)
		const stream = ctx.createMapReadableStream(mapShare.state.mapId)
		return mapShare.downloadResponse(stream)
	})

	const localDeclineHandler: RequestHandler = async (request) => {
		let parsedBody: Static<typeof LocalMapShareDeclineRequest>
		try {
			const json = await request.json()
			parsedBody = CompiledLocalMapShareDeclineRequest.Parse(json)
		} catch (err) {
			throw new StatusError(400, 'Invalid Request')
		}
		const { senderDeviceId, declineUrls, reason } = parsedBody
		const remotePublicKey = z32.decode(senderDeviceId)
		const keyPair = ctx.getKeyPair()
		let response: Response | undefined
		// The sharer could have multiple IPs for different network interfaces, and
		// not all of them may be on the same network as us, so try each URL until
		// one works
		for (const url of declineUrls) {
			try {
				response = (await secretStreamFetch(url, {
					method: 'POST',
					body: JSON.stringify({ reason }),
					signal: request.signal,
					dispatcher: new SecretStreamAgent({ remotePublicKey, keyPair }),
				})) as unknown as Response // Subtle difference bewteen Undici fetch Response and whatwg Response
				break // Exit loop on successful fetch
			} catch (error) {
				if (error instanceof DOMException && error.name === 'AbortError') {
					throw error // Handle abort in caller
				}
				// Otherwise, try the next URL
			}
		}
		if (!response) {
			throw new StatusError(500, 'Could not connect to map share sender')
		}
		return new Response(null, { status: 204 })
	}

	const remoteDeclineHandler: RequestHandler = async (request) => {
		let parsedBody: Static<typeof RemoteMapShareDeclineRequest>
		try {
			const json = await request.json()
			parsedBody = CompiledRemoteMapShareDeclineRequest.Parse(json)
		} catch {
			throw new StatusError(400, 'Invalid Request')
		}
		const { reason } = parsedBody
		const mapShare = getMapShare(request.params.shareId)
		mapShare.decline(reason)
		return new Response(null, { status: 204 })
	}

	router.post(
		'/:shareId/decline',
		async (request, { isLocalhost }): Promise<Response> => {
			if (isLocalhost) {
				return localDeclineHandler(request)
			} else {
				return remoteDeclineHandler(request)
			}
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
	requestUrl = addTrailingSlash(requestUrl)
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
