import assert from 'node:assert'
import { once } from 'node:events'
import http from 'node:http'
import { type AddressInfo } from 'node:net'

import { createServerAdapter } from '@whatwg-node/server'
import pDefer from 'p-defer'
import { createServer as createSecretStreamServer } from 'secret-stream-http'
import z32 from 'z32'

import { Context } from './context.js'
import { RootRouter } from './routes/root.js'
import type { FetchContext } from './types.js'

export type ServerOptions = {
	defaultOnlineStyleUrl: string
	customMapPath: string
	fallbackMapPath: string
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
	const { keyPair, ...contextOptions } = parseOptions(options)

	const deferredListen = pDefer<ListenResult>()
	const context = new Context({
		...contextOptions,
		getRemotePort: async () => {
			const listenOptions = await deferredListen.promise
			return listenOptions.remotePort
		},
	})
	const router = RootRouter({ base: '/' }, context)
	const serverAdapter = createServerAdapter<FetchContext>(router.fetch)
	const localHttpServer = http.createServer((req, res) => {
		serverAdapter.handleNodeRequestAndResponse(req, res, { isLocalhost: true })
	})
	const remoteHttpServer = http.createServer((req, res) => {
		serverAdapter.handleNodeRequestAndResponse(req, res, {
			isLocalhost: false,
			// @ts-expect-error - the types for this are too hard and making them work would not add any type safety.
			remoteDeviceId: z32.encode(req.socket.remotePublicKey),
		})
	})
	const secretStreamServer = createSecretStreamServer(remoteHttpServer, {
		keyPair,
	})

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
	}
}

function parseOptions(options: unknown): ServerOptions {
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
		typeof options.defaultOnlineStyleUrl === 'string',
		new TypeError('defaultOnlineStyleUrl must be a string'),
	)
	assert(
		URL.canParse(options.defaultOnlineStyleUrl),
		new TypeError('defaultOnlineStyleUrl must be a valid URL'),
	)
	assert(
		typeof options.customMapPath === 'string',
		new TypeError('customMapPath must be a string'),
	)
	assert(
		typeof options.fallbackMapPath === 'string',
		new TypeError('fallbackMapPath must be a string'),
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
		assert.equal(
			options.keyPair.publicKey.length,
			32,
			new TypeError('keyPair.publicKey must be 32 bytes'),
		)
		assert.equal(
			options.keyPair.secretKey.length,
			32,
			new TypeError('keyPair.secretKey must be 32 bytes'),
		)
		parsedOptions.keyPair = {
			publicKey: options.keyPair.publicKey,
			secretKey: options.keyPair.secretKey,
		}
	}
	return parsedOptions
}
