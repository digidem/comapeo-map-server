import { StatusError } from 'itty-router'
import { Agent as SecretStreamAgent } from 'secret-stream-http'
import z32 from 'z32'

import { TypedEventTarget } from '../lib/event-target.js'
import type { DownloadCreateRequest } from '../routes/downloads.js'
import { type DownloadStateUpdate } from '../types.js'
import { errors, jsonError } from './errors.js'
import { secretStreamFetch } from './secret-stream-fetch.js'
import { StateUpdateEvent } from './state-update-event.js'
import { addTrailingSlash, generateId, getErrorCode, noop } from './utils.js'

type DownloadRequestState = DownloadStateUpdate &
	Omit<DownloadCreateRequest, 'mapShareUrls'> & { downloadId: string }

export class DownloadRequest extends TypedEventTarget<
	InstanceType<typeof StateUpdateEvent<DownloadStateUpdate>>
> {
	#state: DownloadRequestState
	#abortController = new AbortController()
	#transform = new TransformStream({
		transform: (chunk, controller) => {
			if (this.#state.status !== 'downloading') {
				throw new Error('Download has been cancelled or encountered an error')
			}
			this.#updateState({
				status: 'downloading',
				bytesDownloaded: this.#state.bytesDownloaded + chunk.byteLength,
			})
			controller.enqueue(chunk)
		},
	})
	#dispatcher: SecretStreamAgent

	constructor(
		stream: WritableStream<Uint8Array>,
		{ mapShareUrls, ...rest }: DownloadCreateRequest,
		keyPair: { publicKey: Uint8Array; secretKey: Uint8Array },
	) {
		super()
		this.#state = {
			...rest,
			status: 'downloading',
			bytesDownloaded: 0,
			downloadId: generateId(),
		}
		let remotePublicKey: Uint8Array
		try {
			remotePublicKey = z32.decode(this.#state.senderDeviceId)
		} catch {
			throw new errors.INVALID_SENDER_DEVICE_ID(
				`Invalid sender device ID: ${this.#state.senderDeviceId}`,
			)
		}
		if (remotePublicKey.length !== 32) {
			throw new errors.INVALID_SENDER_DEVICE_ID(
				`Invalid sender device ID: ${this.#state.senderDeviceId}`,
			)
		}
		this.#dispatcher = new SecretStreamAgent({ remotePublicKey, keyPair })
		this.#start({ mapShareUrls, stream, remotePublicKey, keyPair }).catch(
			async (error) => {
				// In case the error happens before we pipe to the stream, we need to abort the stream
				stream.abort().catch(noop)
				if (error.name === 'AbortError') {
					this.#updateState({ status: 'aborted' })
				} else if (getErrorCode(error) === 'DOWNLOAD_MAP_SHARE_CANCELED') {
					this.#updateState({ status: 'canceled' })
				} else if (getErrorCode(error)) {
					// Specific known error from the server
					this.#updateState({ status: 'error', error })
				} else {
					// Once the download has started, the sender can only close the
					// connection to cancel the download, which we only see as an
					// ECONNRESET error here, which could happen for multiple reasons.
					// Rather than immediately updating the state to error, we first check
					// with the sender to see if we can access the status of the share,
					// namely whether it was canceled, or if a different error occurred on
					// the server side.
					try {
						const response = await secretStreamFetch(mapShareUrls, {
							dispatcher: this.#dispatcher,
							signal: AbortSignal.timeout(2000),
						})
						const json = await response.json()
						if (json.status) {
							this.#updateState({ status: json.status, error: json.error })
							return
						}
					} catch (err) {
						// Ignore errors from checking the status and update state with original error
					}
					this.#updateState({ status: 'error', error: jsonError(error) })
				}
			},
		)
	}

	async #start({
		mapShareUrls,
		stream,
		remotePublicKey,
		keyPair,
	}: {
		mapShareUrls: string[]
		stream: WritableStream<Uint8Array>
		remotePublicKey: Uint8Array
		keyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
	}) {
		const downloadUrls = mapShareUrls.map(
			(baseUrl) => new URL('download', addTrailingSlash(baseUrl)),
		)
		const response = await secretStreamFetch(downloadUrls, {
			dispatcher: this.#dispatcher,
		})
		if (!response.body) {
			throw new errors.DOWNLOAD_ERROR('Could not connect to map share sender')
		}
		if (!response.ok) {
			throw new StatusError(response.status, await response.json())
		}
		if (this.#abortController.signal.aborted) {
			response.body.cancel().catch(noop)
			throw new DOMException('Download aborted', 'AbortError')
		}
		await response.body.pipeThrough(this.#transform).pipeTo(stream, {
			signal: this.#abortController.signal,
		})
		this.#updateState({ status: 'completed' })
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
