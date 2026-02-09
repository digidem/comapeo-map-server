import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Agent as SecretStreamAgent } from 'secret-stream-http'
import { describe, it, expect } from 'vitest'

import { createServer } from '../src/index.js'

import { DEMOTILES_Z2, OSM_BRIGHT_Z6 } from './helpers.js'

describe('Server Restart', () => {
	it('should use new ports when restarted with different ports', async (t) => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'map-server-test-'))
		const tmpCustomMapPath = path.join(tmpDir, 'custom-map.smp')
		await fs.copyFile(OSM_BRIGHT_Z6, tmpCustomMapPath)

		t.onTestFinished(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
		})

		const keyPair = SecretStreamAgent.keyPair()
		const receiverKeyPair = SecretStreamAgent.keyPair(Buffer.alloc(32, 1))
		const receiverDeviceId = Buffer.from(receiverKeyPair.publicKey).toString(
			'hex',
		)

		const server = createServer({
			defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',
			customMapPath: tmpCustomMapPath,
			fallbackMapPath: DEMOTILES_Z2,
			keyPair,
		})

		// First listen - use specific ports
		const firstResult = await server.listen({
			localPort: 0,
			remotePort: 0,
		})
		const firstLocalPort = firstResult.localPort
		const firstRemotePort = firstResult.remotePort

		// Create a map share to capture the remote port being used
		const firstShareResponse = await fetch(
			`http://127.0.0.1:${firstLocalPort}/mapShares`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId,
				}),
			},
		)
		expect(firstShareResponse.status).toBe(201)
		const firstShare = await firstShareResponse.json()

		// The mapShareUrls should contain the first remote port
		expect(firstShare.mapShareUrls).toBeDefined()
		expect(firstShare.mapShareUrls.length).toBeGreaterThan(0)
		const firstUrl = new URL(firstShare.mapShareUrls[0])
		expect(firstUrl.port).toBe(String(firstRemotePort))

		// Close the server
		await server.close()

		// Listen again - ports will be different (since we use 0)
		const secondResult = await server.listen({
			localPort: 0,
			remotePort: 0,
		})
		const secondLocalPort = secondResult.localPort
		const secondRemotePort = secondResult.remotePort

		// Ports should be different (very likely with port 0)
		// At minimum, the listen result should reflect the new ports
		expect(secondResult.localPort).not.toBe(firstLocalPort)

		// Create another map share - this should use the NEW remote port
		const secondShareResponse = await fetch(
			`http://127.0.0.1:${secondLocalPort}/mapShares`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mapId: 'custom',
					receiverDeviceId,
				}),
			},
		)
		expect(secondShareResponse.status).toBe(201)
		const secondShare = await secondShareResponse.json()

		// The mapShareUrls should contain the SECOND remote port, not the first
		expect(secondShare.mapShareUrls).toBeDefined()
		expect(secondShare.mapShareUrls.length).toBeGreaterThan(0)
		const secondUrl = new URL(secondShare.mapShareUrls[0])

		// This is the key assertion - the URL should have the new port
		expect(secondUrl.port).toBe(String(secondRemotePort))
		expect(secondUrl.port).not.toBe(String(firstRemotePort))

		// Clean up
		await server.close()
	})

	it('should work correctly after multiple restart cycles', async (t) => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'map-server-test-'))
		const tmpCustomMapPath = path.join(tmpDir, 'custom-map.smp')
		await fs.copyFile(OSM_BRIGHT_Z6, tmpCustomMapPath)

		t.onTestFinished(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
		})

		const server = createServer({
			defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',
			customMapPath: tmpCustomMapPath,
			fallbackMapPath: DEMOTILES_Z2,
		})

		const ports: number[] = []

		// Restart 3 times
		for (let i = 0; i < 3; i++) {
			const result = await server.listen({ localPort: 0, remotePort: 0 })
			ports.push(result.localPort)

			// Verify server is working
			const response = await fetch(
				`http://127.0.0.1:${result.localPort}/maps/custom/style.json`,
			)
			expect(response.status).toBe(200)

			await server.close()
		}

		// All ports should be different (extremely likely with port 0)
		const uniquePorts = new Set(ports)
		expect(uniquePorts.size).toBe(3)
	})
})
