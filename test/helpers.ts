import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// @ts-expect-error - No types available
import bogon from 'bogon'
import ky from 'ky'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { Agent as SecretStreamAgent } from 'secret-stream-http'
import type { TestContext } from 'vitest'
import z32 from 'z32'

import type { ServerOptions } from '../src/index.js'
import { createServer } from '../src/index.js'
import { noop } from '../src/lib/utils.js'
import { MapShareState } from '../src/types.js'

export const OSM_BRIGHT_Z6 = new URL(
	'./fixtures/osm-bright-z6.smp',
	import.meta.url,
)
export const DEMOTILES_Z2 = new URL(
	'./fixtures/demotiles-z2.smp',
	import.meta.url,
)
export const ONLINE_STYLE_URL = 'https://demotiles.maplibre.org/style.json'

let tmpCounter = 0

export async function startServer(
	t: ((listener: () => Promise<void>) => void) | TestContext,
	options?: Partial<ServerOptions>,
) {
	const onTestFinished = 'onTestFinished' in t ? t.onTestFinished.bind(t) : t
	const tmpCustomMapPath = path.join(
		os.tmpdir(),
		`custom-map-path-${tmpCounter++}.smp`,
	)
	// Copy the fixture to a temp location to avoid mutations during tests
	try {
		await fs.copyFile(options?.customMapPath ?? OSM_BRIGHT_Z6, tmpCustomMapPath)
	} catch (err) {
		// @ts-expect-error - checking error code
		if (err.code !== 'ENOENT') {
			throw err
		}
		// customMapPath can point to a path with no file (for testing non-existent maps)
	}
	const keyPair = options?.keyPair ?? SecretStreamAgent.keyPair()
	const server = createServer({
		defaultOnlineStyleUrl: ONLINE_STYLE_URL,
		fallbackMapPath: DEMOTILES_Z2,
		...options,
		customMapPath: tmpCustomMapPath,
		keyPair,
	})
	onTestFinished(async () => {
		// Clean up the temp custom map file
		await fs.unlink(tmpCustomMapPath).catch(noop)
		await server.close()
	})
	const { localPort, remotePort } = await server.listen()
	const nonLoopbackIPv4 = getNonLoopbackIPv4()

	return {
		server,
		localPort,
		remotePort,
		localBaseUrl: `http://127.0.0.1:${localPort}`,
		remoteBaseUrl: `http://${nonLoopbackIPv4}:${remotePort}`,
		keyPair,
	}
}

export async function startServers(
	t: ((listener: () => Promise<void>) => void) | TestContext,
	{
		receiverOptions,
		senderOptions,
	}: {
		receiverOptions?: Partial<ServerOptions>
		senderOptions?: Partial<ServerOptions>
	} = {},
) {
	// Deterministic key pairs for sender and receiver
	const senderKeyPair =
		senderOptions?.keyPair ?? SecretStreamAgent.keyPair(Buffer.alloc(32, 0))
	const receiverKeyPair =
		receiverOptions?.keyPair ?? SecretStreamAgent.keyPair(Buffer.alloc(32, 1))
	const [sender, receiver] = await Promise.all([
		startServer(t, { ...senderOptions, keyPair: senderKeyPair }),
		startServer(t, {
			...receiverOptions,
			keyPair: receiverKeyPair,
		}),
	])
	const receiverDeviceId = z32.encode(receiver.keyPair.publicKey)
	const senderDeviceId = z32.encode(sender.keyPair.publicKey)
	const kyDefaults = ky.create({ retry: 0, throwHttpErrors: false })
	const senderLocal = kyDefaults.extend({ prefixUrl: sender.localBaseUrl })
	const receiverLocal = kyDefaults.extend({ prefixUrl: receiver.localBaseUrl })
	const senderRemote = kyDefaults.extend({ prefixUrl: sender.remoteBaseUrl })
	const receiverRemote = kyDefaults.extend({
		prefixUrl: receiver.remoteBaseUrl,
	})
	const createShare = () =>
		senderLocal.post<MapShareState>('mapShares', {
			json: {
				mapId: 'custom',
				receiverDeviceId: z32.encode(receiver.keyPair.publicKey),
			},
		})
	return {
		sender: senderLocal,
		receiver: receiverLocal,
		createShare,
		senderRemote,
		receiverRemote,
		senderLocalBaseUrl: sender.localBaseUrl,
		senderRemotePort: sender.remotePort,
		senderKeyPair,
		senderDeviceId,
		senderRemoteBaseUrl: sender.remoteBaseUrl,
		receiverLocalBaseUrl: receiver.localBaseUrl,
		receiverLocalPort: receiver.localPort,
		receiverKeyPair,
		receiverDeviceId,
		receiverRemoteBaseUrl: receiver.remoteBaseUrl,
	}
}

/**
 * Get first non-loopback IPv4 address, or null if none found
 */
export function getNonLoopbackIPv4(): string | null {
	const interfaces = os.networkInterfaces()
	for (const iface of Object.values(interfaces)) {
		if (!iface) continue
		for (const addr of iface) {
			if (addr.family === 'IPv4' && !addr.internal) {
				return addr.address
			}
		}
	}
	throw new Error('No non-loopback IPv4 address found')
}

/**
 * Simulate going offline by intercepting network requests that are not to a
 * (local) private IP. Will go back online when the test finishes.
 */
export function goOffline(testContext: TestContext) {
	const server = setupServer(
		http.all('*', ({ request }) => {
			const url = new URL(request.url)

			// Allow localhost and private IPs
			if (url.hostname === 'localhost' || bogon(url.hostname)) {
				return // Pass through
			}

			return HttpResponse.error() // Simulate offline
		}),
	)

	server.listen({ onUnhandledRequest: 'bypass' })

	testContext.onTestFinished(() => {
		server.close()
	})
}
