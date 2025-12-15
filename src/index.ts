import { once } from 'node:events'
import http from 'node:http'
import { type AddressInfo } from 'node:net'

import { createServerAdapter } from '@whatwg-node/server'
import pDefer from 'p-defer'
import { createServer as createSecretStreamServer } from 'secret-stream-http'

import { Context } from './context.js'
import { RootRouter } from './routes/root.js'
import type { FetchContext } from './types.js'

export type ServerOptions = {
	defaultOnlineStyleUrl: string
	customMapPath: string
	fallbackMapPath: string
	keyPair: {
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

export function createServer({ keyPair, ...contextOptions }: ServerOptions) {
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
		serverAdapter.handleNodeRequestAndResponse(req, res, {
			isLocalhost: true,
		})
	})
	const remoteHttpServer = http.createServer((req, res) => {
		serverAdapter.handleNodeRequestAndResponse(req, res, {
			isLocalhost: false,
			// @ts-expect-error - the types for this are too hard and making them work would not add any type safety.
			remoteDeviceId: req.socket.remotePublicKey,
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
