import { Readable } from 'node:stream'

import { IttyRouter } from 'itty-router/IttyRouter'
import { StatusError } from 'itty-router/StatusError'
import { createResponse } from 'itty-router/createResponse'

/** @import { Reader } from 'styled-map-package' */
/** @import {IRequestStrict, RequestLike} from 'itty-router' */

/** @typedef {Awaited<ReturnType<Reader['getResource']>>} Resource */
/** @typedef {Pick<Reader, keyof Reader>} ReaderLike */
/** @typedef {typeof IttyRouter<IRequestStrict, [ReaderLike], Response>} RouterType */

/**
 * @param {Resource} resource
 * @param {ResponseInit} [options]
 * @returns {Response} reply
 */
function resourceResponse(resource, options = {}) {
	const response = new Response(Readable.toWeb(resource.stream), options)
	response.headers.set('Content-Type', resource.contentType)
	response.headers.set('Content-Length', resource.contentLength.toString())
	if (resource.contentEncoding) {
		response.headers.set('Content-Encoding', resource.contentEncoding)
	}
	return response
}

const jsonRaw = createResponse('application/json; charset=utf-8')
const encoder = new TextEncoder()

/** @param {object} obj */
function json(obj) {
	const data = encoder.encode(JSON.stringify(obj))
	return jsonRaw(data, {
		headers: { 'Content-Length': data.length.toString() },
	})
}

/**
 * Create a server for serving styled map packages (SMP) over http. The server
 * is a `fetch` handler that must be provided a WHATWG `Request` and a SMP
 * `Reader` instance. Use `@whatwg-node/server` to use with Node.js HTTP server.
 *
 * To handle errors, catch errors from `fetch` and return appropriate HTTP responses.
 * You can use `itty-router/error` for this.
 *
 * @example
 * ```js
 * import { createServer } from 'node:http'
 * import { error } from 'itty-router/error'
 * import { createServerAdapter } from '@whatwg-node/server'
 * import { createServer as createSMPServer } from 'styled-map-package/server'
 * import { Reader } from 'styled-map-package/reader'
 *
 * const reader = new Reader('path/to/your-style.smp')
 * const smpServer = createSMPServer()
 * const httpServer = createServer(createServerAdapter((request) => {
 *   return smpServer.fetch(request, reader).catch(error)
 * }))
 * ```
 *
 * @param {object} [options]
 * @param {string} [options.base='/'] Base path for the server routes
 * @returns {{ fetch: (request: RequestLike, reader: ReaderLike) => Promise<Response> }} server instance
 */
export function createSmpServer({ base = '/' } = {}) {
	base = base.endsWith('/') ? base : base + '/'
	const router = IttyRouter({
		base,
	})
		.get('/style.json', async (request, reader) => {
			const baseUrl = new URL(base, request.url)
			const style = await reader.getStyle(baseUrl.href)
			return json(style)
		})
		.get('*', async (request, reader) => {
			const url = new URL(request.url)
			const path = decodeURIComponent(url.pathname.slice(base.length - 1))
			const resource = await reader.getResource(path)
			return resourceResponse(resource)
		})
	return {
		fetch: (request, reader) => {
			return router.fetch(request, reader).catch((err) => {
				if (isFileNotThereError(err)) {
					throw new StatusError(404, 'Not Found')
				} else {
					throw err
				}
			})
		},
	}
}

/**
 * Returns true if the error if because a file is not found. On Windows, some
 * operations like fs.watch() throw an EPERM error rather than ENOENT.
 *
 * @param {unknown} error
 * @returns {error is Error & { code: 'ENOENT' | 'EPERM' }}
 */
function isFileNotThereError(error) {
	return (
		error instanceof Error &&
		'code' in error &&
		(error.code === 'ENOENT' || error.code === 'EPERM')
	)
}
