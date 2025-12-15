import {
	IRequestStrict,
	IttyRouter,
	StatusError,
	type RequestHandler,
} from 'itty-router'
import { createServer as createSmpServer } from 'styled-map-package/server'

import type { Context } from '../context.js'
import {
	CUSTOM_MAP_ID,
	DEFAULT_MAP_ID,
	FALLBACK_MAP_ID,
} from '../lib/constants.js'
import { SelfEvictingPromiseMap } from '../lib/self-evicting-map.js'
import { noop } from '../lib/utils.js'

type MapRequest = IRequestStrict & {
	params: {
		mapId: string
	}
}

export function MapsRouter({ base = '/' }, ctx: Context) {
	base = base.endsWith('/') ? base : base + '/'
	const activeUploads = new SelfEvictingPromiseMap<string, Promise<void>>()

	const smpServer = createSmpServer({
		base: `${base}:mapId/`,
	})

	const router = IttyRouter<IRequestStrict>({ base })

	router.get<MapRequest>(`/:mapId/info`, async (request) => {
		const info = await ctx.getMapInfo(request.params.mapId)
		return {
			created: info.created,
			size: info.estimatedSizeBytes,
			name: info.mapName,
		}
	})

	const uploadHandler: RequestHandler<MapRequest> = async (request) => {
		const writable = ctx.createMapWritableStream(request.params.mapId)
		if (!request.body) {
			throw new StatusError(400, 'Invalid Request')
		}
		await request.body.pipeTo(writable)
	}

	router.put<MapRequest>('/:mapId', async (request) => {
		// Only allow uploading to the custom map ID for now
		if (request.params.mapId !== CUSTOM_MAP_ID) {
			throw new StatusError(404, 'Map not found')
		}
		if (!request.body) {
			throw new StatusError(400, 'Invalid Request')
		}
		await activeUploads.get(request.params.mapId)?.catch(noop)
		const uploadPromise = uploadHandler(request)
		activeUploads.set(request.params.mapId, uploadPromise)
		await uploadPromise
		return new Response(null, { status: 200 })
	})

	router.delete<MapRequest>('/:mapId', async (request) => {
		// Only allow deleting the custom map ID
		if (request.params.mapId !== CUSTOM_MAP_ID) {
			throw new StatusError(404, 'Map not found')
		}
		// Wait for any active uploads to complete before deleting
		await activeUploads.get(request.params.mapId)?.catch(noop)
		await ctx.deleteMap(request.params.mapId)
		return new Response(null, { status: 204 })
	})

	router.all(`/:mapId/*`, async (request) => {
		if (request.params.mapId === DEFAULT_MAP_ID) {
			return defaultMapHandler(request)
		}
		return smpServer.fetch(request, await ctx.getReader(request.params.mapId))
	})

	// Special handler for the default map ID that tries to serve a custom map
	// if available, otherwise falls back to the online style or bundled fallback
	const defaultMapHandler: RequestHandler = async (request) => {
		const defaultOnlineStyleUrl = ctx.getDefaultOnlineStyleUrl()
		const styleUrls = [
			new URL(`../${CUSTOM_MAP_ID}/style.json`, request.url),
			defaultOnlineStyleUrl,
			new URL(`../${FALLBACK_MAP_ID}/style.json`, request.url),
		]

		for (const url of styleUrls) {
			let response: Response | void
			if (url === defaultOnlineStyleUrl) {
				response = await fetch(url).catch(noop)
			} else {
				// No need to go through the networking stack for local requests
				response = await router.fetch(new Request(url)).catch(noop)
			}
			response?.body?.cancel() // Close the connection
			if (response && response.ok) {
				return new Response(null, {
					status: 302,
					headers: {
						location: url.toString(),
						'access-control-allow-origin': '*',
						'cache-control': 'no-cache',
					},
				})
			}
		}

		throw new StatusError(404, 'No available map style found')
	}

	return router
}
