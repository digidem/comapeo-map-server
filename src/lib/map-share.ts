import { StatusError } from 'itty-router'

import { TypedEventTarget } from '../lib/event-target.js'
import {
	MapShareState,
	type MapShareStateUpdate,
	type DownloadStateUpdate,
	type MapInfo,
} from '../types.js'
import { StateUpdateEvent } from './state-update-event.js'
import { generateId } from './utils.js'

export type MapShareOptions = MapInfo & {
	/**
	 * Base URLs to construct the download URLs for the map share. Multiple URLs
	 * are supported because the server might have multiple network interfaces
	 * with different IP addresses
	 */
	baseUrls: string[]
	/** The device ID of the receiver */
	receiverDeviceId: string
}

/**
 * Maintains the state of a map share and handles downloading from the sharer side
 */
export class MapShare extends TypedEventTarget<
	InstanceType<typeof StateUpdateEvent>
> {
	#state: MapShareState
	#download: DownloadResponse | undefined
	constructor({ baseUrls, receiverDeviceId, ...mapInfo }: MapShareOptions) {
		super()
		const shareId = generateId()
		this.#state = {
			...mapInfo,
			shareId,
			downloadUrls: baseUrls.map(
				(baseUrl) => new URL(`${shareId}`, baseUrl).href,
			),
			receiverDeviceId,
			status: 'pending',
		}
	}

	get shareId() {
		return this.#state.shareId
	}

	get state() {
		return this.#state
	}

	/**
	 * Create a download response for the map share
	 */
	downloadResponse(readable: ReadableStream<Uint8Array>) {
		if (this.#download?.state.status === 'downloading') {
			throw new StatusError(400, 'Download already in progress')
		} else if (this.#download?.state.status === 'completed') {
			throw new StatusError(400, 'Download already completed')
		} else if (this.#state.status === 'declined') {
			throw new StatusError(400, 'Map share has been declined')
		}
		this.#download?.removeAllEventListeners()
		this.#download = new DownloadResponse(readable)
		this.#download.addEventListener('update', (event) => {
			this.#updateState(event)
		})
		return this.#download.response
	}

	/**
	 * Decline the map share with a given reason
	 */
	decline(
		reason: Extract<MapShareStateUpdate, { status: 'declined' }>['reason'],
	) {
		if (this.#state.status !== 'pending') {
			throw new StatusError(400, 'Can only decline pending map shares')
		}
		this.#updateState({ status: 'declined', reason })
	}

	/**
	 * Cancel the map share
	 */
	cancel() {
		if (this.#state.status === 'completed') {
			throw new StatusError(400, 'Cannot cancel completed map share')
		}
		this.#download?.cancel()
		this.#updateState({ status: 'canceled' })
	}

	#updateState(update: MapShareStateUpdate) {
		this.#state = { ...this.#state, ...update }
		this.dispatchEvent(new StateUpdateEvent(update))
	}
}

/**
 * Handles the download response of a map share and tracks its state.
 *
 * Currently we only support a single download per map share, but I'm keeping
 * this as a separate class in case we want to support multiple downloads per
 * share in the future (multiple downloads per share will make the "state" of a
 * MapShare harder to reason about and define).
 */
export class DownloadResponse extends TypedEventTarget<
	InstanceType<typeof StateUpdateEvent<DownloadStateUpdate>>
> {
	#stream: TransformStream
	#bytesDownloaded = 0
	#abortController = new AbortController()
	#state: DownloadStateUpdate = { status: 'downloading', bytesDownloaded: 0 }
	#response: any

	constructor(readable: ReadableStream<Uint8Array>) {
		super()
		this.#stream = new TransformStream({
			start: () => {
				this.#updateState({ status: 'downloading', bytesDownloaded: 0 })
			},
			transform: (chunk, controller) => {
				this.#bytesDownloaded += chunk.length
				this.#updateState({
					status: 'downloading',
					bytesDownloaded: this.#bytesDownloaded,
				})
				controller.enqueue(chunk)
			},
			flush: () => {
				this.#updateState({ status: 'completed' })
			},
		})
		readable
			.pipeTo(this.#stream.writable, {
				signal: this.#abortController.signal,
			})
			.catch((error) => {
				if (error.name === 'AbortError') {
					this.#updateState({ status: 'canceled' })
				} else {
					this.#updateState({ status: 'error', error })
				}
			})

		this.#response = new Response(this.#stream.readable, {
			headers: {
				'Content-Type': 'application/vnd.smp+zip',
			},
		})
	}

	get response() {
		return this.#response
	}

	get state() {
		return this.#state
	}

	cancel() {
		this.#abortController.abort()
	}

	#updateState(update: DownloadStateUpdate) {
		this.#state = update
		this.dispatchEvent(new StateUpdateEvent(update))
	}
}
