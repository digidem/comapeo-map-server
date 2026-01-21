import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// @ts-expect-error - No types available
import bogon from 'bogon'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { Agent as SecretStreamAgent } from 'secret-stream-http'
import type { TestContext } from 'vitest'

import type { ServerOptions } from '../src/index.js'
import { createServer } from '../src/index.js'
import { noop } from '../src/lib/utils.js'

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
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'map-server-test-'))
	const tmpCustomMapPath = path.join(
		tmpDir,
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
		// Clean up the temp dir and close the server
		await fs.unlink(tmpCustomMapPath).catch(noop)
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(noop)
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
		customMapPath: tmpCustomMapPath,
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
