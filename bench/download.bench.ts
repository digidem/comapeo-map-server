import path from 'node:path'

import { afterAll, beforeAll, bench, describe } from 'vitest'

import { CUSTOM_MAP_ID } from '../src/lib/constants.js'
import { startServer } from '../test/helpers.js'
import { createBenchDir, createLargeSmp, startClient } from './helpers.js'

/** Same size as the upload bench, so the two are directly comparable. */
const MAP_SIZE_BYTES = 32 * 1024 * 1024

const BENCH_OPTIONS = {
	time: 0,
	iterations: 25,
	warmupTime: 0,
	warmupIterations: 8,
} as const

const MiB = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)

const receiverDeviceId = Buffer.alloc(32, 7).toString('hex')

let cleanup: () => Promise<void>
let client: Awaited<ReturnType<typeof startClient>>
let baseUrl: string

// See the note in upload.bench.ts: the benchmark runner ignores `beforeAll`
// inside `describe` and swallows errors thrown from a `bench` body.
beforeAll(async () => {
	const teardowns: Array<() => Promise<void>> = []
	const benchDir = await createBenchDir()
	teardowns.push(benchDir.cleanup)

	const customMapPath = await createLargeSmp(
		path.join(benchDir.dir, 'custom.smp'),
		MAP_SIZE_BYTES,
	)

	client = await startClient()
	teardowns.push(client.close)

	const server = await startServer((teardown) => teardowns.push(teardown), {
		customMapPath,
	})
	baseUrl = server.localBaseUrl

	cleanup = async () => {
		for (const teardown of teardowns.reverse()) await teardown()
	}

	await downloadShare()
}, 120_000)

afterAll(async () => {
	await cleanup?.()
})

/**
 * A share can only be downloaded once, so each iteration creates a fresh one.
 * Creating a share is a stat plus a style read — negligible next to streaming
 * tens of MiB.
 */
async function downloadShare() {
	const { shareId } = await client.request({
		op: 'postJson',
		url: `${baseUrl}/mapShares`,
		json: { mapId: CUSTOM_MAP_ID, receiverDeviceId },
	})
	await client.request({
		op: 'get',
		url: `${baseUrl}/mapShares/${shareId}/download`,
	})
}

describe(`map share download (${MiB(MAP_SIZE_BYTES)} MiB)`, () => {
	// The path a receiving device pulls a map over: map file → progress
	// transform → HTTP response.
	bench('GET /mapShares/:shareId/download', downloadShare, BENCH_OPTIONS)
})
