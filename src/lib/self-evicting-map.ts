import { noop } from './utils.js'

/**
 * A Map that automatically evicts promise entries when they settle, and limits
 * the number of entries. Used to track active downloads.
 */
export class SelfEvictingPromiseMap<K, V extends Promise<any>> extends Map<
	K,
	V
> {
	override set(key: K, value: V): this {
		super.set(key, value)
		value
			.finally(() => {
				if (this.get(key) === value) {
					this.delete(key)
				}
			})
			// .finally() creates a new promise, so we need to catch errors here to
			// avoid unhandled rejections
			.catch(noop)
		return this
	}
}

const DEFAULT_EVICTION_TIMEOUT_MS = 15 * 60 * 1000 // 15 minutes

/**
 * "Not a LRU": A Map that automatically evicts entries after a specified
 * timeout. Used for MapShares which we don't want to keep indefinitely. NB: The
 * use of the Typescript `object` type is intentional: this must be used with
 * non-primitive values, otherwise behaviour would be unexpected because
 * removing a value and re-adding it could result in it being evicted with the
 * original timeout. This has limited applications, but works for our needs.
 */
export class SelfEvictingTimeoutMap<K, V extends object> extends Map<K, V> {
	#evictionTimeoutMs: number
	#timeouts = new Set<NodeJS.Timeout>()

	constructor(
		iterable?: ConstructorParameters<typeof Map<K, V>>[0],
		{ evictionTimeoutMs = DEFAULT_EVICTION_TIMEOUT_MS } = {},
	) {
		super(iterable)
		this.#evictionTimeoutMs = evictionTimeoutMs
	}

	override set(key: K, value: V): this {
		super.set(key, value)
		const timeout = setTimeout(() => {
			this.#timeouts.delete(timeout)
			if (this.get(key) === value) {
				this.delete(key)
			}
		}, this.#evictionTimeoutMs)
		timeout.unref()
		this.#timeouts.add(timeout)
		return this
	}
}
