import type { RequestLike } from 'itty-router'
import { Type as T, type Static } from 'typebox'

export const MapShareDeclineReason = T.Union([
	T.Literal('disk_full', {
		description:
			"The map share was declined because the receiver's disk is full",
	}),
	T.Literal('user_rejected', {
		description: 'The map share was declined by the user',
	}),
	T.String({
		minLength: 1,
		description: 'Other reason for declining the map share',
	}),
])

const MapShareStateUpdate = T.Union([
	T.Object({
		status: T.Literal('pending', {
			description: 'Map share is awaiting a response',
		}),
	}),
	T.Object({
		status: T.Literal('declined', {
			description: 'Map share has been declined',
		}),
		reason: MapShareDeclineReason,
	}),
	T.Object({
		status: T.Literal('downloading', {
			description: 'Map share is currently being downloaded',
		}),
		bytesDownloaded: T.Number({
			description:
				'Total bytes downloaded so far (compare with estimatedSizeBytes for progress)',
		}),
	}),
	T.Object({
		status: T.Literal('canceled', {
			description: 'Map share has been canceled (by the sharer)',
		}),
	}),
	T.Object({
		status: T.Literal('aborted', {
			description: 'Map share download was aborted (by the receiver)',
		}),
	}),
	T.Object({
		status: T.Literal('completed', { description: 'Map has been downloaded' }),
	}),
	T.Object({
		status: T.Literal('error', {
			description: 'An error occurred while downloading',
		}),
		error: T.Object(
			{
				message: T.String({ description: 'Error message' }),
				code: T.String({ description: 'Error code' }),
			},
			{
				description: 'Error that occurred while receiving the map share',
			},
		),
	}),
])

export type MapShareStateUpdate = Static<typeof MapShareStateUpdate>
export type MapShareStatus = Static<typeof MapShareStateUpdate>['status']

export type DownloadStateUpdate = Extract<
	MapShareStateUpdate,
	{ status: 'downloading' | 'completed' | 'error' | 'canceled' | 'aborted' }
>

export const MapShareUrls = T.Unsafe<readonly [string, ...string[]]>(
	T.Array(T.String({ format: 'uri' }), {
		minItems: 1,
		description:
			'List of map share URLs (for each network interface of the sharer)',
	}),
)
export const ShareId = T.String({
	minLength: 1,
	description: 'The ID of the map share',
})
export type ShareId = Static<typeof ShareId>
export const EstimatedSizeBytes = T.Number({
	description: 'Estimated size of the map data in bytes',
})

const MapInfo = T.Object({
	mapId: T.String({ description: 'The ID of the map' }),
	mapName: T.String({ description: 'The name of the map' }),
	estimatedSizeBytes: EstimatedSizeBytes,
	bounds: T.ReadonlyType(
		T.Tuple([T.Number(), T.Number(), T.Number(), T.Number()], {
			description: 'The bounding box of the map data',
		}),
	),
	minzoom: T.Number({ description: 'The minimum zoom level of the map data' }),
	maxzoom: T.Number({ description: 'The maximum zoom level of the map data' }),
	mapCreatedAt: T.Number({
		description: 'Timestamp (ms since epoch) when the map was created',
	}),
})

const MapShareBase = T.Intersect([
	T.Object({
		receiverDeviceId: T.String({
			description: 'The ID of the device that can receive the map share',
		}),
		shareId: ShareId,
		mapShareUrls: MapShareUrls,
		mapShareCreatedAt: T.Number({
			description: 'Timestamp (ms since epoch) when the map share was created',
		}),
	}),
	MapInfo,
])

export const MapShareState = T.Intersect([MapShareBase, MapShareStateUpdate])

export type MapShareState = DistributiveIntersection<
	Static<typeof MapShareBase>,
	Static<typeof MapShareStateUpdate>
>

export type MapInfo = Static<typeof MapInfo>

export type FetchContext = {
	isLocalhost?: boolean
	remoteDeviceId?: string
}

export type DistributiveIntersection<Base, Union> = Union extends unknown
	? Base & Union
	: never

export type DistributeProperty<T, K extends keyof T> = T[K] extends infer V
	? V extends T[K]
		? { [P in K]: V } & Omit<T, K>
		: never
	: never

/**
 * External router returned by create router functions. Ensures routers are
 * called with the necessary fetch context
 */
export type RouterExternal = {
	fetch: (request: RequestLike, context: FetchContext) => Promise<any>
}

export type BBox = Readonly<[number, number, number, number]>
