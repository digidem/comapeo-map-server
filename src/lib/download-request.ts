import { StatusError } from 'itty-router'

import { TypedEventTarget } from '../lib/event-target.js'
import type { DownloadCreateRequest } from '../routes/downloads.js'
import {
	MapShareState,
	type DownloadStateUpdate,
	type MapInfo,
	type MapShareStateUpdate,
} from '../types.js'
import { StateUpdateEvent } from './state-update-event.js'
import { generateId } from './utils.js'

type DownloadRequestState = DownloadStateUpdate &
	Omit<DownloadCreateRequest, 'downloadUrls'> & { downloadId: string }

export class DownloadRequest extends TypedEventTarget<
	InstanceType<typeof StateUpdateEvent<DownloadStateUpdate>>
> {
	#state: DownloadRequestState
	#abortController = new AbortController()

	constructor(
		stream: WritableStream<Uint8Array>,
		{ downloadUrls, ...rest }: DownloadCreateRequest,
	) {
		super()
		this.#state = {
			...rest,
			status: 'downloading',
			bytesDownloaded: 0,
			downloadId: generateId(),
		}
		this.#start(downloadUrls, stream).catch((error) => {
			this.#updateState({ status: 'error', error })
		})
	}

	async #start(downloadUrls: string[], stream: WritableStream<Uint8Array>) {
		let response: Response | undefined
		// The sharer could have multiple IPs for different network interfaces, and
		// not all of them may be on the same network as us, so try each URL until
		// one works
		for (const url of downloadUrls) {
			try {
				response = await fetch(url, { signal: this.#abortController.signal })
				break // Exit loop on successful fetch
			} catch (error) {
				if (error instanceof DOMException && error.name === 'AbortError') {
					throw error // Handle abort in caller
				}
				// Otherwise, try the next URL
			}
		}
		if (!response) {
			throw new Error('Could not connect to map share sender')
		}
		if (!response.ok || !response.body) {
			throw new StatusError(response.status, 'Failed to download map data')
		}
		await response.body.pipeTo(stream)
	}

	get state() {
		return this.#state
	}

	cancel() {
		this.#abortController.abort()
	}

	#updateState(update: DownloadStateUpdate) {
		this.#state = { ...this.#state, ...update }
		this.dispatchEvent(new StateUpdateEvent(update))
	}
}
