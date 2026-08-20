import fsPromises from 'node:fs/promises'
import path from 'node:path'

import { afterAll, beforeAll, bench, describe } from 'vitest'

import { Context } from '../src/context.js'
import { CUSTOM_MAP_ID } from '../src/lib/constants.js'
import { DEMOTILES_Z2, startServer } from '../test/helpers.js'
import {
	chunkBytes,
	createBenchDir,
	createLargeSmp,
	startClient,
} from './helpers.js'

/**
 * Size of the map uploaded in each iteration. Big enough that per-chunk
 * pipeline overhead dominates, small enough to keep a bench run quick.
 */
const MAP_SIZE_BYTES = 32 * 1024 * 1024
/**
 * Matches the default read size of a Node HTTP socket, i.e. roughly what the
 * upload route sees per chunk in production.
 */
const CHUNK_SIZE = 64 * 1024

const BENCH_OPTIONS = {
	time: 0,
	iterations: 25,
	warmupTime: 0,
	warmupIterations: 8,
} as const

const MiB = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)

let cleanup: () => Promise<void>
let client: Awaited<ReturnType<typeof startClient>>
let uploadUrl: string
let smpPath: string
let chunks: Uint8Array[]
let context: Context

// Vitest's benchmark runner ignores `beforeAll` inside `describe` and silently
// swallows errors thrown from a `bench` body, so all setup happens here, and
// each benched path runs once up front to turn a broken bench into a loud
// failure rather than an empty results table.
beforeAll(async () => {
	const teardowns: Array<() => Promise<void>> = []
	const benchDir = await createBenchDir()
	teardowns.push(benchDir.cleanup)

	smpPath = await createLargeSmp(
		path.join(benchDir.dir, 'source.smp'),
		MAP_SIZE_BYTES,
	)
	chunks = chunkBytes(await fsPromises.readFile(smpPath), CHUNK_SIZE)

	client = await startClient()
	teardowns.push(client.close)

	const { localBaseUrl } = await startServer((teardown) =>
		teardowns.push(teardown),
	)
	uploadUrl = `${localBaseUrl}/maps/${CUSTOM_MAP_ID}`

	context = new Context({
		defaultOnlineStyleUrl: 'https://example.com/style.json',
		customMapPath: path.join(benchDir.dir, 'sink-custom.smp'),
		fallbackMapPath: DEMOTILES_Z2,
		keyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
		getRemotePort: async () => 0,
	})
	teardowns.push(() => context.close())

	cleanup = async () => {
		for (const teardown of teardowns.reverse()) await teardown()
	}

	await uploadOverHttp()
	await uploadToSink()
}, 120_000)

afterAll(async () => {
	await cleanup?.()
})

function uploadOverHttp() {
	return client.request({ op: 'put', url: uploadUrl, filePath: smpPath })
}

async function uploadToSink() {
	let index = 0
	const source = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index >= chunks.length) {
				controller.close()
				return
			}
			controller.enqueue(chunks[index++])
		},
	})
	await source.pipeTo(context.createMapWritableStream(CUSTOM_MAP_ID))
}

describe(`map upload (${MiB(MAP_SIZE_BYTES)} MiB)`, () => {
	// The whole path an upload from the app takes: HTTP socket → Request body →
	// idle-timeout transform → temp file → validate → rename.
	bench('PUT /maps/custom over loopback HTTP', uploadOverHttp, BENCH_OPTIONS)

	// Isolates the file-writing half of the pipeline from the HTTP half.
	bench('ReadableStream → createMapWritableStream', uploadToSink, BENCH_OPTIONS)
})
