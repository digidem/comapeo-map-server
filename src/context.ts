import fs, { type Stats } from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { StatusError } from 'itty-router'
import { Reader } from 'styled-map-package'
import type { SetRequired } from 'type-fest'

import type { ServerOptions } from './index.js'
import { CUSTOM_MAP_ID, FALLBACK_MAP_ID } from './lib/constants.js'
import {
	getErrorCode,
	getStyleBbox,
	getStyleMaxZoom,
	getStyleMinZoom,
	noop,
} from './lib/utils.js'

type ContextOptions = SetRequired<ServerOptions, 'keyPair'> & {
	getRemotePort: () => Promise<number>
}

let tmpCounter = 0

export class Context {
	#defaultOnlineStyleUrl: URL
	#mapFileUrls: Map<string, URL>
	#mapReaders: Map<string, Promise<Reader>> = new Map()
	#keyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
	getRemotePort: () => Promise<number>

	constructor({
		defaultOnlineStyleUrl,
		customMapPath,
		fallbackMapPath,
		keyPair,
		getRemotePort,
	}: ContextOptions) {
		this.#defaultOnlineStyleUrl = new URL(defaultOnlineStyleUrl)
		this.#mapFileUrls = new Map([
			[
				CUSTOM_MAP_ID,
				typeof customMapPath === 'string'
					? pathToFileURL(customMapPath)
					: customMapPath,
			],
			[
				FALLBACK_MAP_ID,
				typeof fallbackMapPath === 'string'
					? pathToFileURL(fallbackMapPath)
					: fallbackMapPath,
			],
		])
		this.#keyPair = keyPair
		this.getRemotePort = getRemotePort
	}
	getDefaultOnlineStyleUrl() {
		return this.#defaultOnlineStyleUrl
	}
	getKeyPair() {
		return this.#keyPair
	}
	async getMapInfo(mapId: string) {
		const mapFileUrl = this.#mapFileUrls.get(mapId)
		if (!mapFileUrl) {
			throw new StatusError(404, `Map ID not found: ${mapId}`)
		}
		let stats: Stats
		try {
			stats = await fsPromises.stat(mapFileUrl)
		} catch (err) {
			if (getErrorCode(err) === 'ENOENT') {
				throw new StatusError(404, 'Custom map not found')
			}
			throw err
		}
		const reader = await this.getReader(mapId)
		const style = await reader.getStyle()
		const mapName = style.name || path.basename(fileURLToPath(mapFileUrl))
		return {
			mapId,
			mapName,
			bounds: getStyleBbox(style),
			maxzoom: getStyleMaxZoom(style),
			minzoom: getStyleMinZoom(style),
			estimatedSizeBytes: stats.size,
			created: stats.ctimeMs,
		}
	}
	getReader(mapId: string) {
		const readerPromise = this.#mapReaders.get(mapId)
		if (readerPromise) {
			return readerPromise
		}
		const mapFileUrl = this.#mapFileUrls.get(mapId)
		if (!mapFileUrl) {
			throw new StatusError(404, `Map ID not found: ${mapId}`)
		}
		const reader = new Reader(fileURLToPath(mapFileUrl))
		this.#mapReaders.set(mapId, Promise.resolve(reader))
		return Promise.resolve(reader)
	}
	createMapReadableStream(mapId: string) {
		const mapFileUrl = this.#mapFileUrls.get(mapId)
		if (!mapFileUrl) {
			throw new StatusError(404, `Map ID not found: ${mapId}`)
		}
		return Readable.toWeb(fs.createReadStream(mapFileUrl))
	}
	/**
	 * Creates a writable stream to write map data to the specified map ID.
	 * The data is first written to a temporary file, and once the stream is closed,
	 * the temporary file replaces the existing map file. This ensures that the map
	 * file is only updated when the write operation is fully complete.
	 *
	 * @param mapId - The ID of the map to write data to.
	 * @returns A writable stream to write map data.
	 */
	createMapWritableStream(mapId: string) {
		const mapFileUrl = this.#mapFileUrls.get(mapId)
		if (!mapFileUrl) {
			throw new StatusError(404, `Map ID not found: ${mapId}`)
		}
		const tempPath = `${fileURLToPath(mapFileUrl)}.download-${tmpCounter++}`
		const writable = Writable.toWeb(fs.createWriteStream(tempPath))
		const writer = writable.getWriter()
		return new WritableStream({
			async write(chunk) {
				await writer.write(chunk)
			},
			close: async () => {
				// Finish writing to the temp file
				await writer.close()

				// Validate the uploaded map file BEFORE replacing the existing one
				const tempReader = new Reader(tempPath)
				try {
					await tempReader.opened()
				} catch (err) {
					// Clean up temp file on validation failure
					await fsPromises.unlink(tempPath).catch(noop)
					throw new StatusError(400, 'Uploaded map file is invalid')
				} finally {
					await tempReader.close().catch(noop)
				}

				// Graceful replacement of SMP Reader when map file is updated
				const readerPromise = (async () => {
					const existingReaderPromise = this.#mapReaders.get(mapId)
					if (existingReaderPromise) {
						const existingReader = await existingReaderPromise
						await existingReader.close().catch(noop)
					}
					await fsPromises.cp(tempPath, mapFileUrl, { force: true })
					return new Reader(fileURLToPath(mapFileUrl))
				})()
				this.#mapReaders.set(mapId, readerPromise)
				// Wait for the file copy to complete before closing the stream
				await readerPromise
			},
			async abort(err) {
				try {
					await writer.abort(err)
				} finally {
					fsPromises.unlink(tempPath).catch(noop)
				}
			},
		})
	}
	/**
	 * Deletes the map file for the specified map ID.
	 * Closes any existing reader and removes it from the cache.
	 *
	 * @param mapId - The ID of the map to delete.
	 */
	async deleteMap(mapId: string) {
		const mapFileUrl = this.#mapFileUrls.get(mapId)
		if (!mapFileUrl) {
			throw new StatusError(404, `Map ID not found: ${mapId}`)
		}
		// Close and remove the reader if it exists
		const existingReaderPromise = this.#mapReaders.get(mapId)
		if (existingReaderPromise) {
			const existingReader = await existingReaderPromise
			await existingReader.close().catch(noop)
			this.#mapReaders.delete(mapId)
		}
		// Delete the map file
		const mapFilePath = fileURLToPath(mapFileUrl)
		try {
			await fsPromises.unlink(mapFilePath)
		} catch (err) {
			if (getErrorCode(err) === 'ENOENT') {
				throw new StatusError(404, 'Custom map not found')
			}
			throw err
		}
	}
}
