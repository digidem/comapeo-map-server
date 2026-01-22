import { IRequestStrict, IttyRouter, type RequestHandler } from 'itty-router'
import Mutex from 'p-mutex'
import { createServer as createSmpServer } from 'styled-map-package/server'

import type { Context } from '../context.js'
import {
	CUSTOM_MAP_ID,
	DEFAULT_MAP_ID,
	FALLBACK_MAP_ID,
} from '../lib/constants.js'
import { errors } from '../lib/errors.js'
import { addTrailingSlash, noop } from '../lib/utils.js'

type MapRequest = IRequestStrict & {
	params: {
		mapId: string
	}
}

export function MapsRouter({ base = '/' }, ctx: Context) {
	base = addTrailingSlash(base)
	const uploadMutexes = new Map<string, Mutex>()

	const smpServer = createSmpServer({
		base: `${base}:mapId/`,
	})

	const router = IttyRouter<IRequestStrict>({ base })

	router.get<MapRequest>(`/:mapId/info`, async (request) => {
		const info = await ctx.getMapInfo(request.params.mapId)
		return {
			created: info.mapCreated,
			size: info.estimatedSizeBytes,
			name: info.mapName,
		}
	})

	const uploadHandler: RequestHandler<MapRequest> = async (request) => {
		const writable = ctx.createMapWritableStream(request.params.mapId)
		if (!request.body) {
			throw new errors.INVALID_REQUEST('Request body is required')
		}
		await request.body.pipeTo(writable)
	}

	router.put<MapRequest>('/:mapId', async (request) => {
		// Only allow uploading to the custom map ID for now
		if (
			request.params.mapId === DEFAULT_MAP_ID ||
			request.params.mapId === FALLBACK_MAP_ID
		) {
			throw new errors.FORBIDDEN(
				`Uploading to map ID "${request.params.mapId}" is not allowed`,
			)
		} else if (request.params.mapId !== CUSTOM_MAP_ID) {
			throw new errors.MAP_NOT_FOUND(`Map not found: ${request.params.mapId}`)
		}
		if (!request.body) {
			throw new errors.INVALID_REQUEST('Request body is required')
		}
		// Get or create a mutex for this mapId to ensure sequential uploads
		let mutex = uploadMutexes.get(request.params.mapId)
		if (!mutex) {
			mutex = new Mutex()
			uploadMutexes.set(request.params.mapId, mutex)
		}
		await mutex.withLock(() => uploadHandler(request))
		return new Response(null, { status: 200 })
	})

	router.delete<MapRequest>('/:mapId', async (request) => {
		// Only allow deleting the custom map ID
		if (
			request.params.mapId === DEFAULT_MAP_ID ||
			request.params.mapId === FALLBACK_MAP_ID
		) {
			throw new errors.FORBIDDEN(
				`Deleting the map ID "${request.params.mapId}" is not allowed`,
			)
		} else if (request.params.mapId !== CUSTOM_MAP_ID) {
			throw new errors.MAP_NOT_FOUND(`Map not found: ${request.params.mapId}`)
		}
		// Use mutex to wait for any active uploads to complete before deleting
		let mutex = uploadMutexes.get(request.params.mapId)
		if (!mutex) {
			mutex = new Mutex()
			uploadMutexes.set(request.params.mapId, mutex)
		}
		await mutex.withLock(() => ctx.deleteMap(request.params.mapId))
		return new Response(null, { status: 204 })
	})

	router.all(`/:mapId/*`, async (request) => {
		if (request.params.mapId === DEFAULT_MAP_ID) {
			return defaultMapHandler(request)
		}
		// Get the reader first - this throws MAP_NOT_FOUND for unknown map IDs
		const reader = await ctx.getReader(request.params.mapId)
		try {
			return await smpServer.fetch(request, reader)
		} catch (err) {
			// Convert generic 404 from smpServer to RESOURCE_NOT_FOUND
			if (err instanceof Error && 'status' in err && err.status === 404) {
				throw new errors.RESOURCE_NOT_FOUND()
			}
			throw err
		}
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

		throw new errors.MAP_NOT_FOUND('No available map style found')
	}

	return router
}
