import assert from 'node:assert'
import { once } from 'node:events'
import http from 'node:http'
import { type AddressInfo, type Server, type Socket } from 'node:net'

import { createAdapter } from '@comapeo/node-server'
import pDefer from 'p-defer'
import Mutex from 'p-mutex'
import {
	Agent,
	createServer as createSecretStreamServer,
} from 'secret-stream-http'

import { Context } from './context.js'
import { errors } from './lib/errors.js'
import { getErrorCode, noop } from './lib/utils.js'
import { RootRouter } from './routes/root.js'
import type { FetchContext } from './types.js'

export { errors } from './lib/errors.js'
export { CUSTOM_MAP_ID, DEFAULT_MAP_ID } from './lib/constants.js'

export type {
	MapInfo,
	MapInfoResponse,
	MapShareState,
	MapShareStateUpdate,
	DownloadStateUpdate,
} from './types.js'
export type { DownloadState } from './lib/download-request.js'
export type {
	MapShareCreateParams,
	MapShareDeclineParams,
} from './routes/map-shares.js'
export type { DownloadCreateParams } from './routes/downloads.js'

export type ServerOptions = {
	defaultOnlineStyleUrl: string | URL
	customMapPath: string | URL
	fallbackMapPath: string | URL
	keyPair?: {
		publicKey: Uint8Array
		secretKey: Uint8Array
	}
	/**
	 * Abort a map upload (with a 408 response) if no request body data arrives
	 * for this many milliseconds. Defaults to 30000.
	 */
	uploadIdleTimeoutMs?: number
}

export type ListenOptions = {
	localPort?: number
	remotePort?: number
}

type ListenResult = {
	localPort: number
	remotePort: number
}

/**
 * Socket read/write buffer for the local HTTP server. The Node default (16 KiB
 * on Node 20, 64 KiB from Node 22) is no larger than a single socket read, so
 * the socket pauses after almost every chunk while the map is written to disk.
 * 512 KiB lets reads run ahead of the disk and measures ~1.3x faster map
 * uploads; see `bench/`. Connections to the remote server are SecretStream
 * duplexes created by secret-stream-http, so this does not reach them.
 */
const SOCKET_HIGH_WATER_MARK = 512 * 1024

export type MapServer = ReturnType<typeof createServer>

export function createServer(options: ServerOptions) {
	validateOptions(options)
	if (!options.keyPair) {
		options.keyPair = Agent.keyPair()
	}

	let deferredListen = createDeferredListen()
	const context = new Context({
		...options,
		keyPair: options.keyPair,
		getRemotePort: async () => {
			const listenOptions = await deferredListen.promise
			return listenOptions.remotePort
		},
	})
	const router = RootRouter(
		{ base: '/', uploadIdleTimeoutMs: options.uploadIdleTimeoutMs },
		context,
	)
	const handler = (request: Request, fetchContext: FetchContext) =>
		router.fetch(request, fetchContext)
	const localHttpServer = http.createServer(
		{ highWaterMark: SOCKET_HIGH_WATER_MARK },
		createAdapter(handler, { getContext: () => ({ isLocalhost: true }) }),
	)

	const remoteHttpServer = http.createServer(
		createAdapter(handler, {
			getContext: (req) => ({
				isLocalhost: false,
				// @ts-expect-error - secret-stream-http adds remotePublicKey to the socket
				remoteDeviceId: Buffer.from(req.socket.remotePublicKey).toString('hex'),
			}),
		}),
	)
	const secretStreamServer = createSecretStreamServer(remoteHttpServer, {
		keyPair: options.keyPair,
	})

	// Track connections for proper cleanup
	const connections = new Set<Socket>()
	const onConnection = (socket: Socket) => {
		connections.add(socket)
		socket.once('close', () => {
			connections.delete(socket)
		})
	}
	localHttpServer.on('connection', onConnection)
	secretStreamServer.on('connection', onConnection)

	// Every public method runs under this lock, so none can observe another
	// half-done; nothing below touches `state` outside it. The servers are never
	// closed while a bind is in flight: in Node 22 a close() that lands between
	// listen() and its 'listening' event cancels the listen silently, and
	// whatever awaits 'listening' hangs forever.
	const lifecycle = new Mutex()
	let state:
		| { status: 'closed' }
		| { status: 'listening' | 'paused'; ports: ListenResult } = {
		status: 'closed',
	}

	/**
	 * Bind both servers, one after the other so that if the second fails the
	 * first can be closed without racing its own bind. With `fallback`, a port
	 * that is already in use is swapped for a random one rather than failing.
	 */
	async function bind(
		ports: ListenOptions,
		fallback: boolean,
	): Promise<ListenResult> {
		const localPort = await listenOn(
			localHttpServer,
			ports.localPort,
			'127.0.0.1',
			fallback,
		)
		try {
			const remotePort = await listenOn(
				secretStreamServer,
				ports.remotePort,
				'0.0.0.0',
				fallback,
			)
			return { localPort, remotePort }
		} catch (err) {
			localHttpServer.close()
			throw err
		}
	}

	/**
	 * Stop accepting connections on both servers. This releases the ports
	 * synchronously but leaves open connections alone (apart from idle
	 * keep-alive connections, which http.Server.close() ends), so it must not
	 * wait for the servers' 'close' events: those only fire once every open
	 * connection has ended.
	 */
	function unbind() {
		localHttpServer.close()
		secretStreamServer.close()
	}

	function createDeferredListen() {
		const deferred = pDefer<ListenResult>()
		// close() rejects this to unblock getRemotePort(); swallow the rejection
		// so it isn't reported as unhandled when nothing is awaiting it.
		deferred.promise.catch(noop)
		return deferred
	}

	return {
		/**
		 * Start listening. Resolves with the ports in use. Idempotent while
		 * listening, but rejects if different explicit ports are requested
		 * (close() first) or with `SERVER_PAUSED` while paused: only
		 * `resumeListening()` undoes a pause.
		 */
		listen(opts: ListenOptions = {}) {
			return lifecycle.withLock(async () => {
				// Only resumeListening() undoes a pause: a listen() from elsewhere in
				// the app must not quietly reopen the sockets while it is in the
				// background.
				if (state.status === 'paused') throw new errors.SERVER_PAUSED()
				// When already listening, listen() is idempotent — but only for
				// compatible ports. Requesting different explicit ports is a
				// programming error: close() first to listen on new ports.
				if (state.status === 'listening') {
					assertCompatiblePorts(opts, state.ports)
					return state.ports
				}
				const ports = await bind(opts, false)
				state = { status: 'listening', ports }
				deferredListen.resolve(ports)
				return ports
			})
		},
		/**
		 * Stop listening, destroy all open connections and release resources. The
		 * server can listen() again afterwards. A no-op if already closed.
		 */
		close() {
			return lifecycle.withLock(async () => {
				if (state.status === 'closed') return
				state = { status: 'closed' }
				// Throw away any pending listen promises since the server is closing
				deferredListen.reject(new errors.SERVER_CLOSED())
				unbind()
				// Destroy all active connections to ensure clean shutdown
				for (const socket of connections) {
					socket.destroy()
				}
				connections.clear()
				await Promise.all([
					once(localHttpServer, 'close'),
					once(secretStreamServer, 'close'),
				])
				await context.close()
				// Reset deferred listen for potential restart with different ports
				deferredListen = createDeferredListen()
			})
		},
		/**
		 * Stop accepting new connections on both ports, without clearing any state
		 * (map shares, downloads). Requests and transfers already in progress
		 * carry on; idle keep-alive connections to the local port are closed, as
		 * `http.Server.close()` does. Use this when the process is about to be
		 * suspended, e.g. an iOS app moving to the background: iOS can reclaim a
		 * suspended app's listening sockets, which leaves the server unreachable
		 * after the app resumes. Only `resumeListening()` undoes this; `listen()`
		 * rejects with `SERVER_PAUSED` while paused.
		 *
		 * A no-op unless the server is listening.
		 */
		pauseListening(): Promise<void> {
			return lifecycle.withLock(async () => {
				if (state.status !== 'listening') return
				unbind()
				state = { status: 'paused', ports: state.ports }
			})
		},
		/**
		 * Start accepting connections again after `pauseListening()`, on the same
		 * ports. If a port has been taken in the meantime, a random port is used
		 * instead, and map share URLs created before the pause will no longer
		 * work. Resolves with the ports now in use; compare them with the previous
		 * ones to detect a change.
		 *
		 * Rejects with `SERVER_CLOSED` if the server is closed or was never
		 * started. If binding fails, the server stays paused and the call can be
		 * retried.
		 */
		resumeListening(): Promise<ListenResult> {
			return lifecycle.withLock(async () => {
				if (state.status === 'closed') throw new errors.SERVER_CLOSED()
				if (state.status === 'listening') return state.ports
				// If bind() fails the server stays paused, so resume can be retried.
				const ports = await bind(state.ports, true)
				state = { status: 'listening', ports }
				// The ports may differ from the ones before the pause, and a settled
				// deferred cannot be re-resolved, so start a fresh one for
				// getRemotePort().
				deferredListen = createDeferredListen()
				deferredListen.resolve(ports)
				return ports
			})
		},
	}
}

async function listenOn(
	server: Server,
	port: number | undefined,
	host: string,
	fallback: boolean,
): Promise<number> {
	try {
		server.listen(port, host)
		await once(server, 'listening')
	} catch (err) {
		if (!fallback || !port || getErrorCode(err) !== 'EADDRINUSE') throw err
		server.listen(0, host)
		await once(server, 'listening')
	}
	return (server.address() as AddressInfo).port
}

function assertCompatiblePorts(opts: ListenOptions, current: ListenResult) {
	// A falsy requested port (undefined or 0) means "any port", so it never
	// conflicts with the port already in use.
	assert(
		!opts.localPort || opts.localPort === current.localPort,
		new Error(
			`Server is already listening on local port ${current.localPort}; call close() before listening on port ${opts.localPort}`,
		),
	)
	assert(
		!opts.remotePort || opts.remotePort === current.remotePort,
		new Error(
			`Server is already listening on remote port ${current.remotePort}; call close() before listening on port ${opts.remotePort}`,
		),
	)
}

function validateOptions(options: unknown): asserts options is ServerOptions {
	assert(
		typeof options === 'object' && options !== null,
		new TypeError('options must be an object'),
	)
	assert(
		'defaultOnlineStyleUrl' in options,
		new TypeError('missing defaultOnlineStyleUrl'),
	)
	assert('customMapPath' in options, new TypeError('missing customMapPath'))
	assert('fallbackMapPath' in options, new TypeError('missing fallbackMapPath'))

	assert(
		typeof options.defaultOnlineStyleUrl === 'string' ||
			options.defaultOnlineStyleUrl instanceof URL,
		new TypeError('defaultOnlineStyleUrl must be a string or URL'),
	)
	assert(
		URL.canParse(String(options.defaultOnlineStyleUrl)),
		new TypeError('defaultOnlineStyleUrl must be a valid URL'),
	)
	assert(
		(typeof options.customMapPath === 'string' && options.customMapPath) ||
			options.customMapPath instanceof URL,
		new TypeError('customMapPath must be a string or URL'),
	)
	assert(
		(typeof options.fallbackMapPath === 'string' && options.fallbackMapPath) ||
			options.fallbackMapPath instanceof URL,
		new TypeError('fallbackMapPath must be a string or URL'),
	)
	const parsedOptions: ServerOptions = {
		defaultOnlineStyleUrl: options.defaultOnlineStyleUrl,
		customMapPath: options.customMapPath,
		fallbackMapPath: options.fallbackMapPath,
	}

	if (
		'uploadIdleTimeoutMs' in options &&
		options.uploadIdleTimeoutMs !== undefined
	) {
		assert(
			typeof options.uploadIdleTimeoutMs === 'number' &&
				options.uploadIdleTimeoutMs > 0,
			new TypeError('uploadIdleTimeoutMs must be a positive number'),
		)
		parsedOptions.uploadIdleTimeoutMs = options.uploadIdleTimeoutMs
	}

	if ('keyPair' in options && options.keyPair !== undefined) {
		assert(
			typeof options.keyPair === 'object' && options.keyPair !== null,
			new TypeError('keyPair must be an object'),
		)
		assert(
			'publicKey' in options.keyPair,
			new TypeError('keyPair must have a publicKey'),
		)
		assert(
			options.keyPair.publicKey instanceof Uint8Array,
			new TypeError('keyPair.publicKey must be a Uint8Array'),
		)
		assert(
			'secretKey' in options.keyPair,
			new TypeError('keyPair must have a secretKey'),
		)
		assert(
			options.keyPair.secretKey instanceof Uint8Array,
			new TypeError('keyPair.secretKey must be a Uint8Array'),
		)
		parsedOptions.keyPair = {
			publicKey: options.keyPair.publicKey,
			secretKey: options.keyPair.secretKey,
		}
	}
}
