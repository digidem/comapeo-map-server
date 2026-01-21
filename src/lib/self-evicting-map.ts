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
