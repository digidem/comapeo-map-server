import { TypedEventTarget } from '../lib/event-target.js'
import {
	MapShareState,
	type MapShareStateUpdate,
	type DownloadStateUpdate,
	type MapInfo,
} from '../types.js'
import { errors } from './errors.js'
import { StateUpdateEvent } from './state-update-event.js'
import { generateId, getErrorCode } from './utils.js'

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
				(baseUrl) => new URL(`${shareId}/download`, baseUrl).href,
			),
			declineUrls: baseUrls.map(
				(baseUrl) => new URL(`${shareId}/decline`, baseUrl).href,
			),
			receiverDeviceId,
			mapShareCreated: Date.now(),
			status: 'pending',
		}
	}

	get shareId() {
		return this.#state.shareId
	}

	get state() {
		// console.log('Getting map share state:', this.#state)
		return this.#state
	}

	/**
	 * Create a download response for the map share
	 */
	downloadResponse(readable: ReadableStream): Response {
		if (this.#state.status !== 'pending') {
			throw new errors.DOWNLOAD_MAP_SHARE_NOT_PENDING(
				`Cannot download map share in status '${this.#state.status}'`,
			)
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
			throw new errors.DECLINE_NOT_PENDING(
				`Cannot decline map share in status '${this.#state.status}'`,
			)
		}
		this.#updateState({ status: 'declined', reason })
	}

	/**
	 * Cancel the map share
	 */
	cancel() {
		if (
			this.#state.status !== 'pending' &&
			this.#state.status !== 'downloading'
		) {
			throw new errors.CANCEL_NOT_PENDING_OR_DOWNLOADING(
				`Cannot cancel map share in status '${this.#state.status}'`,
			)
		}
		this.#download?.cancel()
		this.#updateState({ status: 'canceled' })
	}

	#updateState(update: MapShareStateUpdate) {
		this.#state = { ...this.#state, ...update }
		console.log('state update for map share', this.shareId, { ...update })
		queueMicrotask(() => this.dispatchEvent(new StateUpdateEvent(update)))
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
	#response: Response

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
				console.log('Download pipeTo error:', error)
				if (error.name === 'AbortError') {
					this.#updateState({ status: 'canceled' })
				} else if (getErrorCode(error) === 'ECONNRESET') {
					this.#updateState({ status: 'aborted' })
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
		console.log('Download state update:', update)
		this.dispatchEvent(new StateUpdateEvent(update))
	}
}
