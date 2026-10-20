import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, it, expect, vi } from 'vitest'

import { errors } from '../src/index.js'
import type { MapShareState } from '../src/types.js'
import {
	DEMOTILES_Z2,
	OSM_BRIGHT_Z6,
	startServer,
	startServers,
} from './helpers.js'

function connect(port: number): Promise<'connected' | string> {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1')
		socket.once('connect', () => {
			socket.destroy()
			resolve('connected')
		})
		socket.once('error', (err: NodeJS.ErrnoException) =>
			resolve(err.code ?? err.message),
		)
	})
}

async function occupy(port: number, host: string) {
	const blocker = net.createServer()
	blocker.listen(port, host)
	await once(blocker, 'listening')
	return blocker
}

/** Start a map upload and send the first half of the body. */
function startUpload(localPort: number) {
	const body = fs.readFileSync(OSM_BRIGHT_Z6)
	const req = http.request({
		host: '127.0.0.1',
		port: localPort,
		path: '/maps/custom',
		method: 'PUT',
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Length': body.length,
		},
	})
	const response = new Promise<http.IncomingMessage>((resolve, reject) => {
		req.once('response', resolve)
		req.once('error', reject)
	})
	const half = Math.floor(body.length / 2)
	req.write(body.subarray(0, half))
	return {
		response,
		finish: () => req.end(body.subarray(half)),
	}
}

describe('pauseListening() / resumeListening()', () => {
	it('stops accepting connections and resumes on the same ports', async (t) => {
		const { server, localPort, remotePort } = await startServer(t)

		await server.pauseListening()
		expect(await connect(localPort)).toBe('ECONNREFUSED')
		expect(await connect(remotePort)).toBe('ECONNREFUSED')

		const ports = await server.resumeListening()
		expect(ports).toEqual({ localPort, remotePort })

		const response = await fetch(
			`http://127.0.0.1:${localPort}/maps/custom/style.json`,
		)
		expect(response.status).toBe(200)
		expect(await connect(remotePort)).toBe('connected')
	})

	it('keeps open connections alive while paused', async (t) => {
		const { server, localPort } = await startServer(t, {
			customMapPath: DEMOTILES_Z2,
		})

		const upload = startUpload(localPort)
		await delay(50)
		await server.pauseListening()
		expect(await connect(localPort)).toBe('ECONNREFUSED')

		upload.finish()
		const response = await upload.response
		expect(response.statusCode).toBe(200)
		response.resume()

		await server.resumeListening()
		const info = await fetch(
			`http://127.0.0.1:${localPort}/maps/custom/info`,
		).then((r) => r.json())
		expect(info.size).toBe(fs.statSync(OSM_BRIGHT_Z6).size)
	})

	it('map shares created before a pause still download after resume', async (t) => {
		const { sender, createShare, createDownload, receiver } =
			await startServers(t, {
				senderOptions: { customMapPath: OSM_BRIGHT_Z6 },
				receiverOptions: { customMapPath: DEMOTILES_Z2 },
			})

		const share = await createShare().json<MapShareState>()
		await sender.server.pauseListening()
		await sender.server.resumeListening()

		const download = await createDownload(share).json<any>()
		let status = download.status
		for (let i = 0; i < 100 && status === 'downloading'; i++) {
			await delay(50)
			status = (
				await receiver.get(`downloads/${download.downloadId}`).json<any>()
			).status
		}
		expect(status).toBe('completed')
	})

	it('falls back to random ports if the old ones were taken', async (t) => {
		const { server, localPort, remotePort } = await startServer(t)

		await server.pauseListening()
		const blockers = await Promise.all([
			occupy(localPort, '127.0.0.1'),
			occupy(remotePort, '0.0.0.0'),
		])
		t.onTestFinished(() => blockers.forEach((b) => b.close()))

		const ports = await server.resumeListening()
		expect(ports.localPort).not.toBe(localPort)
		expect(ports.remotePort).not.toBe(remotePort)

		// listen() reports the new ports, not the ones from the first listen()
		expect(await server.listen()).toEqual(ports)

		const response = await fetch(
			`http://127.0.0.1:${ports.localPort}/mapShares`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId: 'a'.repeat(64),
				}),
			},
		)
		expect(response.status).toBe(201)
		const share = (await response.json()) as MapShareState
		expect(new URL(share.mapShareUrls[0]!).port).toBe(String(ports.remotePort))
	})

	it('listen() while paused rejects and does not resume', async (t) => {
		const { server, localPort, remotePort } = await startServer(t)

		await server.pauseListening()
		await expect(server.listen()).rejects.toBeInstanceOf(errors.SERVER_PAUSED)
		expect(await connect(localPort)).toBe('ECONNREFUSED')

		expect(await server.resumeListening()).toEqual({ localPort, remotePort })
		expect(await server.listen()).toEqual({ localPort, remotePort })
	})

	it('pause during listen() leaves the server paused', async (t) => {
		const { server } = await startServer(t)
		await server.close()

		const listening = server.listen()
		await server.pauseListening()
		const { localPort } = await listening
		expect(await connect(localPort)).toBe('ECONNREFUSED')
		await server.resumeListening()
		expect(await connect(localPort)).toBe('connected')
	})

	it('pause and resume are idempotent', async (t) => {
		const { server, localPort, remotePort } = await startServer(t)

		await Promise.all([server.pauseListening(), server.pauseListening()])
		expect(await connect(localPort)).toBe('ECONNREFUSED')

		const [a, b] = await Promise.all([
			server.resumeListening(),
			server.resumeListening(),
		])
		expect(a).toEqual({ localPort, remotePort })
		expect(b).toEqual(a)
		expect(await server.resumeListening()).toEqual(a)
	})

	it('a failed resume leaves nothing listening and can be retried', async (t) => {
		const { server, localPort, remotePort } = await startServer(t)
		await server.pauseListening()

		// The local server fails to rebind with an error the fallback doesn't
		// handle, while the remote server rebinds.
		const spy = vi
			.spyOn(net.Server.prototype, 'listen')
			.mockImplementationOnce(function (this: net.Server) {
				process.nextTick(() =>
					this.emit(
						'error',
						Object.assign(new Error('listen EADDRNOTAVAIL'), {
							code: 'EADDRNOTAVAIL',
						}),
					),
				)
				return this
			})
		await expect(server.resumeListening()).rejects.toMatchObject({
			code: 'EADDRNOTAVAIL',
		})
		spy.mockRestore()
		// The remote server's successful bind was rolled back...
		expect(await connect(remotePort)).toBe('ECONNREFUSED')
		// ...and the server is still paused, so resume can simply be retried.
		await expect(server.listen()).rejects.toBeInstanceOf(errors.SERVER_PAUSED)
		expect(await server.resumeListening()).toEqual({ localPort, remotePort })
		expect(await connect(localPort)).toBe('connected')
		expect(await connect(remotePort)).toBe('connected')
	})

	it('survives repeated pause/resume cycles', async (t) => {
		const { server, localPort } = await startServer(t)

		for (let i = 0; i < 20; i++) {
			await server.pauseListening()
			await server.resumeListening()
		}
		const response = await fetch(
			`http://127.0.0.1:${localPort}/maps/custom/style.json`,
		)
		expect(response.status).toBe(200)
	})

	it('close() while paused resolves, even with an open connection', async (t) => {
		const { server, localPort } = await startServer(t)

		const upload = startUpload(localPort)
		upload.response.catch(() => {})
		await delay(50)
		await server.pauseListening()

		await server.close()
		await expect(server.resumeListening()).rejects.toBeInstanceOf(
			errors.SERVER_CLOSED,
		)
	})

	it('close() racing a resume does not hang', async (t) => {
		// Step the close() through successive microtasks so one lands between the
		// resume's listen() call and its 'listening' event.
		for (let ticks = 0; ticks < 10; ticks++) {
			const { server } = await startServer(t)
			await server.pauseListening()
			const resumed = server.resumeListening().then(
				() => 'resumed',
				(err) => err,
			)
			for (let i = 0; i < ticks; i++) await null
			await server.close()
			const outcome = await resumed
			if (outcome !== 'resumed') {
				expect(outcome).toBeInstanceOf(errors.SERVER_CLOSED)
			}
		}
	})

	it('can listen again after close() while paused', async (t) => {
		const { server } = await startServer(t)

		await server.pauseListening()
		await server.close()
		const { localPort } = await server.listen()
		expect(await connect(localPort)).toBe('connected')
	})

	it('pauseListening() is a no-op before listen()', async (t) => {
		const { server } = await startServer(t)
		await server.close()

		await server.pauseListening()
		await expect(server.resumeListening()).rejects.toBeInstanceOf(
			errors.SERVER_CLOSED,
		)
	})
})
