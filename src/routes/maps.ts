import { type Stats } from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

import { IttyRouter, StatusError, type RequestHandler } from 'itty-router'
import { Reader } from 'styled-map-package'

import {
	CUSTOM_MAP_ID,
	DEFAULT_MAP_ID,
	FALLBACK_MAP_ID,
} from '../lib/constants.js'
import { getErrorCode, noop } from '../lib/utils.js'
import { createSmpServer } from './smp-server.js'

type MapsRouterOptions = {
	base?: string
	customMapPath: string
	fallbackMapPath: string
	defaultOnlineStyleUrl: string | URL
}

export function createMapsRouter({
	base = '/',
	customMapPath,
	fallbackMapPath,
	defaultOnlineStyleUrl,
}: MapsRouterOptions) {
	base = base.endsWith('/') ? base : base + '/'
	const fallbackMapReader = new Reader(fallbackMapPath)
	let customMapReader = new Reader(customMapPath)

	const customMapRouter = createSmpServer({
		base: `${base}${CUSTOM_MAP_ID}/`,
	})
	const fallbackMapRouter = createSmpServer({
		base: `${base}${FALLBACK_MAP_ID}/`,
	})

	const router = IttyRouter({ base })

	router.get(`/${CUSTOM_MAP_ID}/info`, async (request) => {
		let stats: Stats
		try {
			stats = await fsPromises.stat(customMapPath)
		} catch (err) {
			if (getErrorCode(err) === 'ENOENT') {
				throw new StatusError(404, 'Custom map not found')
			}
			throw err
		}
		const url = new URL(`style.json`, request.url)
		const response = await router.fetch(new Request(url))
		if (!response.ok) {
			// The custom map style not existing should have been caught earlier,
			// so if we get here, something else is wrong with the custom map.
			throw new StatusError(500, 'Custom map style is not valid')
		}
		const style = (await response.json()) as unknown
		const name =
			typeof style === 'object' &&
			style !== null &&
			'name' in style &&
			typeof style.name === 'string'
				? style.name
				: path.parse(customMapPath).name
		return {
			created: stats.ctime,
			size: stats.size,
			name,
		}
	})

	router.all(`/${CUSTOM_MAP_ID}/*`, async (request) => {
		return customMapRouter.fetch(request, customMapReader)
	})

	router.all(`/${FALLBACK_MAP_ID}/*`, async (request) => {
		return fallbackMapRouter.fetch(request, fallbackMapReader)
	})

	router.get(`/${DEFAULT_MAP_ID}/style.json`, async (request) => {
		// The default map is:
		// 1. If a custom map is provided, use that.
		// 2. Otherwise, if online, use the default online style.
		// 3. Otherwise, use the offline fallback map that is bundled.
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
				const redirectResponse = Response.redirect(url, 302)
				redirectResponse.headers.set('access-control-allow-origin', '*')
				redirectResponse.headers.set('cache-control', 'no-cache')
				return redirectResponse
			}
		}

		throw new StatusError(404, 'No available map style found')
	})

	return router
}
