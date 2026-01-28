import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { createServer } from '../src/index.js'

describe('createServer factory function', () => {
	const validKeyPair = {
		publicKey: randomBytes(32),
		secretKey: randomBytes(32),
	}
	const validFallbackMapPath = fileURLToPath(
		new URL('./fixtures/demotiles-z2.smp', import.meta.url),
	)
	const validCustomMapPath = fileURLToPath(
		new URL('./fixtures/osm-bright-z6.smp', import.meta.url),
	)
	const validOnlineStyleUrl = `https://demotiles.maplibre.org/style.json`

	describe('Invalid URL parameters', () => {
		it('should throw on invalid defaultOnlineStyleUrl', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: 'not a valid url',
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})

		it('should throw on empty defaultOnlineStyleUrl', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: '',
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})

		it('should throw on empty customMapPath', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: '',
					fallbackMapPath: validFallbackMapPath,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})

		it('should throw on empty fallbackMapPath', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: '',
					keyPair: validKeyPair,
				}),
			).toThrow()
		})
	})

	describe('Invalid keyPair parameters', () => {
		it('should throw when keyPair is null', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					// @ts-expect-error - Testing null keyPair
					keyPair: null,
				}),
			).toThrow()
		})

		it('should throw when keyPair.publicKey is missing', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: {
						// @ts-expect-error - Testing missing publicKey
						publicKey: undefined,
						secretKey: randomBytes(32),
					},
				}),
			).toThrow()
		})

		it('should throw when keyPair.secretKey is missing', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: {
						publicKey: randomBytes(32),
						// @ts-expect-error - Testing missing secretKey
						secretKey: undefined,
					},
				}),
			).toThrow()
		})

		it('should throw when keyPair.publicKey is wrong type', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: {
						// @ts-expect-error - Testing wrong type
						publicKey: 'not a Uint8Array',
						secretKey: randomBytes(32),
					},
				}),
			).toThrow()
		})

		it('should throw when keyPair.secretKey is wrong type', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: {
						publicKey: randomBytes(32),
						// @ts-expect-error - Testing wrong type
						secretKey: 'not a Uint8Array',
					},
				}),
			).toThrow()
		})
	})

	describe('Missing required parameters', () => {
		it('should throw when defaultOnlineStyleUrl is missing', () => {
			expect(() =>
				createServer({
					// @ts-expect-error - Testing missing parameter
					defaultOnlineStyleUrl: undefined,
					customMapPath: validCustomMapPath,
					fallbackMapPath: validFallbackMapPath,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})

		it('should throw when customMapPath is missing', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					// @ts-expect-error - Testing missing parameter
					customMapPath: undefined,
					fallbackMapPath: validFallbackMapPath,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})

		it('should throw when fallbackMapPath is missing', () => {
			expect(() =>
				createServer({
					defaultOnlineStyleUrl: validOnlineStyleUrl,
					customMapPath: validCustomMapPath,
					// @ts-expect-error - Testing missing parameter
					fallbackMapPath: undefined,
					keyPair: validKeyPair,
				}),
			).toThrow()
		})
	})

	describe('Valid parameters', () => {
		it('should create server with valid parameters', () => {
			const server = createServer({
				defaultOnlineStyleUrl: validOnlineStyleUrl,
				customMapPath: validCustomMapPath,
				fallbackMapPath: validFallbackMapPath,
				keyPair: validKeyPair,
			})

			expect(server).toBeDefined()
			expect(server).toHaveProperty('listen')
			expect(typeof server.listen).toBe('function')
		})

		it('should accept http URLs for defaultOnlineStyleUrl', () => {
			const server = createServer({
				defaultOnlineStyleUrl: 'http://localhost:8080/style.json',
				customMapPath: validCustomMapPath,
				fallbackMapPath: validFallbackMapPath,
				keyPair: validKeyPair,
			})

			expect(server).toBeDefined()
		})
	})

	describe('listen() method', () => {
		it('should accept empty options', async () => {
			const server = createServer({
				defaultOnlineStyleUrl: validOnlineStyleUrl,
				customMapPath: validCustomMapPath,
				fallbackMapPath: validFallbackMapPath,
				keyPair: validKeyPair,
			})

			const result = await server.listen()

			expect(result).toHaveProperty('localPort')
			expect(result).toHaveProperty('remotePort')
			expect(typeof result.localPort).toBe('number')
			expect(typeof result.remotePort).toBe('number')
		})

		it('should accept port options', async () => {
			const server = createServer({
				defaultOnlineStyleUrl: validOnlineStyleUrl,
				customMapPath: validCustomMapPath,
				fallbackMapPath: validFallbackMapPath,
				keyPair: validKeyPair,
			})

			const result = await server.listen({
				localPort: 54321,
				remotePort: 54322,
			})

			expect(result.localPort).toEqual(54321)
			expect(result.remotePort).toEqual(54322)
			await server.close()
		})

		it('should accept partial port options', async () => {
			const server = createServer({
				defaultOnlineStyleUrl: validOnlineStyleUrl,
				customMapPath: validCustomMapPath,
				fallbackMapPath: validFallbackMapPath,
				keyPair: validKeyPair,
			})

			const result = await server.listen({
				localPort: 54321,
				// remotePort omitted
			})

			expect(result.localPort).toEqual(54321)
			expect(result.remotePort).toBeGreaterThan(0)
			await server.close()
		})
	})
})
