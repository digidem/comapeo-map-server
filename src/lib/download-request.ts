import { Agent as SecretStreamAgent } from 'secret-stream-http'

import { TypedEventTarget } from '../lib/event-target.js'
import type { DownloadCreateParams } from '../routes/downloads.js'
import { type DownloadStateUpdate } from '../types.js'
import { StatusError } from './errors.js'
import { errors, jsonError } from './errors.js'
import { anyFetch } from './secret-stream-fetch.js'
import { StateUpdateEvent } from './state-update-event.js'
import { throttle } from './throttle.js'
import { addTrailingSlash, generateId, getErrorCode, noop } from './utils.js'

export type DownloadState = DownloadStateUpdate &
	Omit<DownloadCreateParams, 'mapShareUrls'> & { downloadId: string }

const PROGRESS_THROTTLE_MS = 100

export class DownloadRequest extends TypedEventTarget<
	InstanceType<typeof StateUpdateEvent<DownloadStateUpdate>>
> {
	#state: DownloadState
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
		{ mapShareUrls, ...rest }: DownloadCreateParams,
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
			remotePublicKey = Buffer.from(this.#state.senderDeviceId, 'hex')
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
				await stream.abort().catch(noop)
				if (error.name === 'AbortError') {
					this.#updateState({ status: 'aborted' })
				} else if (getErrorCode(error) === 'DOWNLOAD_SHARE_CANCELED') {
					this.#updateState({ status: 'canceled' })
				} else if (getErrorCode(error)) {
					// Specific known error from the server
					this.#updateState({ status: 'error', error: jsonError(error) })
				} else {
					// Once the download has started, the sender can only close the
					// connection to cancel the download, which we only see as an
					// ECONNRESET error here, which could happen for multiple reasons.
					// Rather than immediately updating the state to error, we first check
					// with the sender to see if we can access the status of the share,
					// namely whether it was canceled, or if a different error occurred on
					// the server side.
					try {
						// GET /:shareId is idempotent, so racing URLs directly is safe.
						const response = await anyFetch(mapShareUrls, {
							dispatcher: this.#dispatcher,
							signal: AbortSignal.timeout(2000),
						})
						const json = await response.json()
						if (json.status) {
							this.#updateState({ status: json.status, error: json.error })
							return
						}
					} catch {
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
	}: {
		mapShareUrls: readonly [string, ...string[]]
		stream: WritableStream<Uint8Array>
		remotePublicKey: Uint8Array
		keyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
	}) {
		// anyFetch probes the URLs in parallel and only sends the real /download
		// request to the winner. Necessary because the sender only supports one
		// active download per share, so racing /download against a server
		// reachable on several URLs would be unsafe.
		const downloadUrls = mapShareUrls.map(
			(baseUrl) => new URL('download', addTrailingSlash(baseUrl)),
		) as unknown as readonly [URL, ...URL[]]
		let response: Response
		try {
			// We deliberately do NOT pass this.#abortController.signal here. If we
			// did, a fast abort could fire while anyFetch is still in the probe
			// phase — before any real /download request has reached the sender —
			// leaving the sender's MapShare stuck in 'pending' because it never
			// saw a connection to cancel. Instead we let anyFetch run to
			// completion, then check the abort flag below (see the
			// `signal.aborted` check after this try/catch). That way the sender
			// always gets a real request, and cancelling the response body
			// closes the connection so the sender can transition its state.
			response = await anyFetch(downloadUrls, {
				dispatcher: this.#dispatcher,
			})
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') {
				throw error // Handle abort in caller
			}
			throw new errors.DOWNLOAD_ERROR({
				message: 'Could not connect to map share sender',
				urls: mapShareUrls,
				cause: error,
			})
		}
		if (!response.body) {
			throw new errors.DOWNLOAD_ERROR({
				message: 'Could not connect to map share sender',
				urls: mapShareUrls,
			})
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

	#dispatchProgress = throttle((update: DownloadStateUpdate) => {
		this.dispatchEvent(new StateUpdateEvent(update))
	}, PROGRESS_THROTTLE_MS)

	#updateState(update: DownloadStateUpdate) {
		// Update #state synchronously so the transform stream's running byte
		// count always reads the latest value; only the progress event dispatch
		// is throttled.
		this.#state = { ...this.#state, ...update }
		if (update.status === 'downloading') {
			this.#dispatchProgress(update)
		} else {
			// Emit any pending progress update before the terminal state so
			// consumers always see the final bytesDownloaded value.
			this.#dispatchProgress.flush()
			this.dispatchEvent(new StateUpdateEvent(update))
		}
	}
}
