import fs from 'node:fs/promises'

import {
	Agent as SecretStreamAgent,
	fetch as secretStreamFetch,
} from 'secret-stream-http'

/**
 * Benchmark client, run as a child process so that the map server is measured
 * on its own — which is also how it runs on a device, with the app doing the
 * fetch from a different process than the server.
 *
 * Plain JS rather than TypeScript because this is forked directly by Node,
 * without Vite's transform.
 *
 * Protocol: parent sends `{ id, op, ...params }`, child replies with
 * `{ id, result }` or `{ id, error }`.
 */

/** @type {Map<string, Uint8Array<ArrayBuffer>>} */
const fileCache = new Map()

/**
 * Dispatcher for requests to the remote (SecretStream) server, keyed by the
 * peer it talks to. Reused so the handshake is not re-measured every iteration.
 *
 * @type {Map<string, SecretStreamAgent>}
 */
const dispatchers = new Map()

/** @param {{ keyPairSeed: string, remotePublicKey: string }} params */
function getDispatcher({ keyPairSeed, remotePublicKey }) {
	const key = `${keyPairSeed}:${remotePublicKey}`
	let dispatcher = dispatchers.get(key)
	if (!dispatcher) {
		dispatcher = new SecretStreamAgent({
			keyPair: SecretStreamAgent.keyPair(Buffer.from(keyPairSeed, 'hex')),
			remotePublicKey: Buffer.from(remotePublicKey, 'hex'),
		})
		dispatchers.set(key, dispatcher)
	}
	return dispatcher
}

/** @param {string} filePath */
async function readCached(filePath) {
	let contents = fileCache.get(filePath)
	if (!contents) {
		contents = new Uint8Array(await fs.readFile(filePath))
		fileCache.set(filePath, contents)
	}
	return contents
}

const operations = {
	/** @param {{ url: string, filePath: string }} params */
	async put({ url, filePath }) {
		const body = await readCached(filePath)
		const response = await fetch(url, { method: 'PUT', body })
		if (!response.ok) {
			throw new Error(`PUT ${url} failed: ${response.status}`)
		}
		await response.arrayBuffer()
	},
	/**
	 * @param {{ url: string, secretStream?: { keyPairSeed: string, remotePublicKey: string } }} params
	 */
	async get({ url, secretStream }) {
		const response = secretStream
			? await secretStreamFetch(url, {
					dispatcher: getDispatcher(secretStream),
				})
			: await fetch(url)
		if (!response.ok || !response.body) {
			throw new Error(`GET ${url} failed: ${response.status}`)
		}
		const reader = response.body.getReader()
		let received = 0
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			received += value.byteLength
		}
		if (received === 0) throw new Error(`GET ${url} returned no data`)
	},
	/** @param {{ url: string, json: unknown }} params */
	async postJson({ url, json }) {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(json),
		})
		if (!response.ok) {
			throw new Error(`POST ${url} failed: ${response.status}`)
		}
		return response.json()
	},
}

process.on('message', (/** @type {any} */ message) => {
	const { id, op, ...params } = message
	Promise.resolve()
		.then(() => operations[/** @type {keyof operations} */ (op)](params))
		.then(
			(result) => process.send?.({ id, result }),
			(error) => process.send?.({ id, error: error.message }),
		)
})
