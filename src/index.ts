import assert from 'node:assert'
import { once } from 'node:events'
import http from 'node:http'
import { type AddressInfo } from 'node:net'

import { createServerAdapter } from '@whatwg-node/server'
import pDefer from 'p-defer'
import {
	Agent,
	createServer as createSecretStreamServer,
} from 'secret-stream-http'

import { Context } from './context.js'
import { fetchAPI } from './lib/fetch-api.js'
import { RootRouter } from './routes/root.js'
import type { FetchContext } from './types.js'

export { errors } from './lib/errors.js'

export type {
	MapInfo,
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
}

export type ListenOptions = {
	localPort?: number
	remotePort?: number
}

type ListenResult = {
	localPort: number
	remotePort: number
}

export function createServer(options: ServerOptions) {
	validateOptions(options)
	if (!options.keyPair) {
		options.keyPair = Agent.keyPair()
	}

	const deferredListen = pDefer<ListenResult>()
	const context = new Context({
		...options,
		keyPair: options.keyPair,
		getRemotePort: async () => {
			const listenOptions = await deferredListen.promise
			return listenOptions.remotePort
		},
	})
	const router = RootRouter({ base: '/' }, context)
	// Use native fetch API to avoid ponyfill bugs with stream error propagation
	const serverAdapter = createServerAdapter<FetchContext>(router.fetch, {
		fetchAPI,
	})
	const localHttpServer = http.createServer((req, res) => {
		serverAdapter(req, res, { isLocalhost: true })
	})

	const remoteHttpServer = http.createServer((req, res) => {
		serverAdapter(req, res, {
			isLocalhost: false,
			// @ts-expect-error - the types for this are too hard and making them work would not add any type safety.
			remoteDeviceId: Buffer.from(req.socket.remotePublicKey).toString('hex'),
		})
	})
	const secretStreamServer = createSecretStreamServer(remoteHttpServer, {
		keyPair: options.keyPair,
	})

	// Track connections for proper cleanup
	const connections = new Set<any>()
	const onConnection = (socket: any) => {
		connections.add(socket)
		socket.once('close', () => {
			connections.delete(socket)
		})
	}
	localHttpServer.on('connection', onConnection)
	secretStreamServer.on('connection', onConnection)

	return {
		async listen(opts: ListenOptions = {}) {
			localHttpServer.listen(opts.localPort, '127.0.0.1')
			secretStreamServer.listen(opts.remotePort, '0.0.0.0')
			await Promise.all([
				once(localHttpServer, 'listening'),
				once(secretStreamServer, 'listening'),
			])
			const localPort = (localHttpServer.address() as AddressInfo).port
			const remotePort = (secretStreamServer.address() as AddressInfo).port
			deferredListen.resolve({ localPort, remotePort })
			return { localPort, remotePort }
		},
		async close() {
			// Remove connection listeners
			localHttpServer.off('connection', onConnection)
			secretStreamServer.off('connection', onConnection)
			localHttpServer.close()
			secretStreamServer.close()
			// Destroy all active connections to ensure clean shutdown
			for (const socket of connections) {
				socket.destroy()
			}
			connections.clear()
			await Promise.all([
				once(localHttpServer, 'close'),
				once(secretStreamServer, 'close'),
			])
		},
	}
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
		URL.canParse(options.defaultOnlineStyleUrl),
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
