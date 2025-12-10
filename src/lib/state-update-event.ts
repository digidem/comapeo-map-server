import type { MapShareStateUpdate, MapInfo } from '../types.js'

/**
 * Event representing a state update in a map share
 */
export const StateUpdateEvent = class extends Event {
	public static readonly type = 'update'
	constructor(update: MapShareStateUpdate) {
		super('update')
		Object.assign(this, update)
	}
} as new <TUpdate extends MapShareStateUpdate>(
	update: TUpdate,
) => Event & { type: 'update' } & TUpdate
