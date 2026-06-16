import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Agent as SecretStreamAgent } from 'secret-stream-http'
import { describe, it, expect } from 'vitest'

import { createServer, errors } from '../src/index.js'
import { DEMOTILES_Z2, OSM_BRIGHT_Z6 } from './helpers.js'

/**
 * Create a server backed by a throwaway copy of the custom map fixture. The
 * server is closed and the temp dir removed when the test finishes.
 */
async function createTestServer(t: {
	onTestFinished: (fn: () => Promise<void> | void) => void
}) {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'map-server-test-'))
	const tmpCustomMapPath = path.join(tmpDir, 'custom-map.smp')
	await fs.copyFile(OSM_BRIGHT_Z6, tmpCustomMapPath)

	const server = createServer({
		defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',
		customMapPath: tmpCustomMapPath,
		fallbackMapPath: DEMOTILES_Z2,
		keyPair: SecretStreamAgent.keyPair(),
	})

	t.onTestFinished(async () => {
		await server.close().catch(() => {})
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	return server
}

describe('Server lifecycle', () => {
	it('listen() is idempotent', async (t) => {
		const server = await createTestServer(t)

		const first = await server.listen({ localPort: 0, remotePort: 0 })
		// A second listen() without a close() in between must not throw. The old
		// code called net.Server.listen() a second time, which throws
		// ERR_SERVER_ALREADY_LISTEN ("Listen method has been called more than
		// once without closing"). It should instead resolve to the same ports.
		const second = await server.listen({ localPort: 0, remotePort: 0 })

		expect(second).toEqual(first)

		const response = await fetch(
			`http://127.0.0.1:${first.localPort}/maps/custom/style.json`,
		)
		expect(response.status).toBe(200)
	})

	it('concurrent listen() calls resolve to the same ports', async (t) => {
		const server = await createTestServer(t)

		const [a, b] = await Promise.all([
			server.listen({ localPort: 0, remotePort: 0 }),
			server.listen({ localPort: 0, remotePort: 0 }),
		])

		expect(a).toEqual(b)

		const response = await fetch(
			`http://127.0.0.1:${a.localPort}/maps/custom/style.json`,
		)
		expect(response.status).toBe(200)
	})

	it('listen() with different ports while already listening throws', async (t) => {
		const server = await createTestServer(t)

		const { localPort } = await server.listen({ localPort: 0, remotePort: 0 })

		// Requesting a different explicit port without closing first is a
		// programming error and must reject rather than silently keep the old port.
		await expect(
			server.listen({ localPort: localPort + 1 }),
		).rejects.toThrow(/already listening/)

		// The original listener is untouched.
		const response = await fetch(
			`http://127.0.0.1:${localPort}/maps/custom/style.json`,
		)
		expect(response.status).toBe(200)
	})

	it('close() is idempotent', async (t) => {
		const server = await createTestServer(t)

		await server.listen({ localPort: 0, remotePort: 0 })

		await server.close()
		// A second close() must resolve cleanly rather than calling
		// net.Server.close() on an already-closed server.
		await expect(server.close()).resolves.toBeUndefined()
	})

	it('a close() racing a listen() on a started server leaves it working (last call wins)', async (t) => {
		const server = await createTestServer(t)

		await server.listen({ localPort: 0, remotePort: 0 })

		// Fire close() then listen() without awaiting close() in between. The
		// state machine serialises them so the last call (listen) wins.
		const closePromise = server.close()
		const listenPromise = server.listen({ localPort: 0, remotePort: 0 })

		await closePromise
		const result = await listenPromise

		const response = await fetch(
			`http://127.0.0.1:${result.localPort}/maps/custom/style.json`,
		)
		expect(response.status).toBe(200)
	})

	it('close() called while listen() is in flight settles cleanly and the server can restart', async (t) => {
		const server = await createTestServer(t)

		// Start listening but request a close before listen() has resolved. The
		// old code raced net.Server.close() against an in-progress listen() and
		// hung forever waiting on a 'close' event that never fired. The state
		// machine serialises the two so both promises settle (last call wins:
		// the server ends up stopped).
		const listenPromise = server.listen({ localPort: 0, remotePort: 0 })
		const closePromise = server.close()

		await Promise.all([listenPromise, closePromise])

		// The server must be restartable and functional after the race.
		const result = await server.listen({ localPort: 0, remotePort: 0 })
		const response = await fetch(
			`http://127.0.0.1:${result.localPort}/maps/custom/style.json`,
		)
		expect(response.status).toBe(200)
	}, 15_000)

	it('exposes a typed SERVER_CLOSED error', () => {
		const err = new errors.SERVER_CLOSED()
		expect(err.code).toBe('SERVER_CLOSED')
		expect(err.status).toBe(503)
		expect(err.message).toBe('Server is closed')
	})
})
