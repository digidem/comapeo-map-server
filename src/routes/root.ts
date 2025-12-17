import { error, json, Router, type IRequestStrict } from 'itty-router'

import type { Context } from '../context.js'
import { localhostOnly } from '../middlewares/localhost-only.js'
import type { FetchContext, RouterExternal } from '../types.js'
import { DownloadsRouter } from './downloads.js'
import { MapSharesRouter } from './map-shares.js'
import { MapsRouter } from './maps.js'

const MAPS_BASE = '/maps/'
const MAP_SHARES_BASE = '/mapShares/'
const DOWNLOADS_BASE = '/downloads/'

export function RootRouter({ base = '/' }, ctx: Context): RouterExternal {
	const router = Router<IRequestStrict, [FetchContext]>({
		base,
		// The `error` handler will send a response with the status code from any
		// thrown StatusError, or a 500 for any other errors.
		catch: (err) => {
			// console.error(err)
			return error(err)
		},
		// Sends a 404 response for any requests that don't match a route, and for
		// any request handlers that return JSON will send a JSON response.
		finally: [(response) => response ?? error(404), json],
	})

	const mapsRouter = MapsRouter({ base: MAPS_BASE }, ctx)
	const downloadsRouter = DownloadsRouter({ base: DOWNLOADS_BASE }, ctx)
	const mapSharesRouter = MapSharesRouter({ base: MAP_SHARES_BASE }, ctx)

	router.all(`${MAPS_BASE}*`, localhostOnly, mapsRouter.fetch)
	router.all(`${DOWNLOADS_BASE}*`, localhostOnly, downloadsRouter.fetch)
	// Some map share routes are remote-accessible - localhostOnly is applied in
	// the map shares router where needed
	router.all(`${MAP_SHARES_BASE}*`, mapSharesRouter.fetch)

	return router
}
