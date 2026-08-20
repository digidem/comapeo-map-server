import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { Writer } from 'styled-map-package-api/writer'

const TILE_BYTES = 64 * 1024

const BENCH_STYLE = {
	version: 8,
	name: 'bench',
	sources: {
		bench: {
			type: 'vector' as const,
			tiles: ['https://example.com/{z}/{x}/{y}.mvt'],
			minzoom: 0,
			maxzoom: 8,
		},
	},
	layers: [
		{
			id: 'background',
			type: 'background' as const,
			paint: { 'background-color': '#ffffff' },
		},
	],
}

/**
 * Write a valid `.smp` of roughly `sizeBytes`, filled with incompressible tile
 * data so the archive does not shrink under deflate. Uploads of a valid file
 * are what we want to measure: an invalid one short-circuits at the validation
 * step in `Context#createMapWritableStream`.
 */
export async function createLargeSmp(
	filePath: string,
	sizeBytes: number,
): Promise<string> {
	const writer = new Writer(BENCH_STYLE, { dedupe: false })
	const written = writer.outputStream.pipeTo(
		Writable.toWeb(
			fs.createWriteStream(filePath),
		) as WritableStream<Uint8Array>,
	)
	const tileCount = Math.ceil(sizeBytes / TILE_BYTES)
	let remaining = tileCount
	loop: for (let z = 0; z <= 8; z++) {
		for (let x = 0; x < 2 ** z; x++) {
			for (let y = 0; y < 2 ** z; y++) {
				await writer.addTile(randomBytes(TILE_BYTES), {
					z,
					x,
					y,
					sourceId: 'bench',
					format: 'mvt',
				})
				if (--remaining <= 0) break loop
			}
		}
	}
	await writer.finish()
	await written
	return filePath
}

export async function createBenchDir(): Promise<{
	dir: string
	cleanup: () => Promise<void>
}> {
	const dir = await fsPromises.mkdtemp(
		path.join(os.tmpdir(), 'map-server-bench-'),
	)
	return {
		dir,
		cleanup: () => fsPromises.rm(dir, { recursive: true, force: true }),
	}
}

export function chunkBytes(bytes: Uint8Array, chunkSize: number) {
	const chunks: Uint8Array[] = []
	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		chunks.push(bytes.subarray(offset, offset + chunkSize))
	}
	return chunks
}

/** Identifies the SecretStream peers, so the client can reuse a dispatcher. */
type SecretStreamParams = { keyPairSeed: string; remotePublicKey: string }

type ClientRequest =
	| { op: 'put'; url: string; filePath: string }
	| { op: 'get'; url: string; secretStream?: SecretStreamParams }
	| { op: 'postJson'; url: string; json: unknown }

/**
 * Drives requests from a forked process, so the numbers reflect the server's
 * own throughput rather than a client and server sharing one event loop — which
 * is also how this runs on a device.
 */
export async function startClient() {
	const child = fork(fileURLToPath(new URL('./client.mjs', import.meta.url)))
	const pending = new Map<
		number,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>()
	let nextId = 0

	child.on('message', (message: any) => {
		const handlers = pending.get(message.id)
		if (!handlers) return
		pending.delete(message.id)
		if (message.error) handlers.reject(new Error(message.error))
		else handlers.resolve(message.result)
	})
	child.on('exit', (code) => {
		for (const { reject } of pending.values()) {
			reject(new Error(`Bench client exited with code ${code}`))
		}
		pending.clear()
	})
	await new Promise((resolve) => child.once('spawn', resolve))

	return {
		request(request: ClientRequest): Promise<any> {
			const id = nextId++
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject })
				child.send({ id, ...request })
			})
		},
		close: async () => {
			child.kill()
		},
	}
}
