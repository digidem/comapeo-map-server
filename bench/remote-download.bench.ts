import path from 'node:path'

import { Agent as SecretStreamAgent } from 'secret-stream-http'
import { afterAll, beforeAll, bench, describe } from 'vitest'

import { CUSTOM_MAP_ID } from '../src/lib/constants.js'
import { startServer } from '../test/helpers.js'
import { createBenchDir, createLargeSmp, startClient } from './helpers.js'

/** Same size as the other transfer benches, so they are comparable. */
const MAP_SIZE_BYTES = 32 * 1024 * 1024

const BENCH_OPTIONS = {
	time: 0,
	iterations: 25,
	warmupTime: 0,
	warmupIterations: 8,
} as const

const MiB = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)

/** Fixed so the forked client can rebuild the same key pair. */
const RECEIVER_SEED = Buffer.alloc(32, 7)
const receiverKeyPair = SecretStreamAgent.keyPair(RECEIVER_SEED)
const receiverDeviceId = Buffer.from(receiverKeyPair.publicKey).toString('hex')

let cleanup: () => Promise<void>
let client: Awaited<ReturnType<typeof startClient>>
let localBaseUrl: string
let remoteBaseUrl: string
let secretStream: { keyPairSeed: string; remotePublicKey: string }

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

	const sender = await startServer((teardown) => teardowns.push(teardown), {
		customMapPath,
	})
	localBaseUrl = sender.localBaseUrl
	remoteBaseUrl = sender.remoteBaseUrl
	secretStream = {
		keyPairSeed: RECEIVER_SEED.toString('hex'),
		remotePublicKey: Buffer.from(sender.keyPair.publicKey).toString('hex'),
	}

	cleanup = async () => {
		for (const teardown of teardowns.reverse()) await teardown()
	}

	await downloadShareOverSecretStream()
}, 120_000)

afterAll(async () => {
	await cleanup?.()
})

/**
 * A share is created over the local API (as the sharing app does) and then
 * pulled over the encrypted remote server, the way a receiving device does it.
 * Each iteration needs a fresh share: a share can only be downloaded once.
 */
async function downloadShareOverSecretStream() {
	const { shareId } = await client.request({
		op: 'postJson',
		url: `${localBaseUrl}/mapShares`,
		json: { mapId: CUSTOM_MAP_ID, receiverDeviceId },
	})
	await client.request({
		op: 'get',
		url: `${remoteBaseUrl}/mapShares/${shareId}/download`,
		secretStream,
	})
}

describe(`map share download over SecretStream (${MiB(MAP_SIZE_BYTES)} MiB)`, () => {
	bench(
		'GET /mapShares/:shareId/download',
		downloadShareOverSecretStream,
		BENCH_OPTIONS,
	)
})
