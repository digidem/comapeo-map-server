import { error, json, Router, type IRequestStrict } from 'itty-router'

import type { Context } from '../context.js'
import { localhostOnly } from '../middlewares/localhost-only.js'
import type { FetchContext, RouterExternal } from '../types.js'
import { MapsRouter } from './maps.js'

const MAPS_BASE = '/maps/'

export function RootRouter({ base = '/' }, ctx: Context): RouterExternal {
	const router = Router<IRequestStrict, [FetchContext]>({
		base,
		// The `error` handler will send a response with the status code from any
		// thrown StatusError, or a 500 for any other errors.
		catch: (e) => {
			const errorResponse = error(e)
			if (errorResponse.status === 500) {
				console.error('Internal Server Error:', e)
			}
			return errorResponse
		},
		// Sends a 404 response for any requests that don't match a route, and for
		// any request handlers that return JSON will send a JSON response.
		finally: [(response) => response ?? error(404), json],
	})

	const mapsRouter = MapsRouter({ base: MAPS_BASE }, ctx)

	router.all(`${MAPS_BASE}*`, localhostOnly, mapsRouter.fetch)

	return router
}
