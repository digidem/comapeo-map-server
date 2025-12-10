import { type TypedEventTarget as TypedEventTargetOrig } from 'typed-event-target'

/**
 * A strongly typed EventTarget - no runtime overhead
 */
export const TypedEventTarget = EventTarget as {
	new <
		PossibleEvents extends Readonly<Event>,
	>(): TypedEventTargetOrig<PossibleEvents>
	prototype: EventTarget
}
