import type { IRequestStrict } from 'itty-router'
import type { Reader } from 'styled-map-package'
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
		status: T.Literal('completed', { description: 'Map has been downloaded' }),
	}),
	T.Object({
		status: T.Literal('error', {
			description: 'An error occurred while downloading',
		}),
		error: T.Any({
			description: 'Error that occurred while receiving the map share',
		}),
	}),
])

export type MapShareStateUpdate = Static<typeof MapShareStateUpdate>
export type MapShareStatus = Static<typeof MapShareStateUpdate>['status']

export type DownloadStateUpdate = Extract<
	MapShareStateUpdate,
	{ status: 'downloading' | 'completed' | 'error' | 'canceled' }
>

export const DownloadUrls = T.Array(T.String({ format: 'url' }), {
	description: 'List of URLs to download the map data from',
})
export type DownloadUrls = Static<typeof DownloadUrls>
export const ShareId = T.String({ description: 'The ID of the map share' })
export type ShareId = Static<typeof ShareId>
export const EstimatedSizeBytes = T.Number({
	description: 'Estimated size of the map data in bytes',
})

const MapShareBase = T.Object({
	receiverDeviceId: T.String({
		description: 'The ID of the device that can receive the map share',
	}),
	shareId: ShareId,
	mapName: T.String({ description: 'The name of the map being shared' }),
	mapId: T.String({ description: 'The ID of the map being shared' }),
	downloadUrls: DownloadUrls,
	bounds: T.Tuple([T.Number(), T.Number(), T.Number(), T.Number()], {
		description: 'The bounding box of the map data being shared',
	}),
	minzoom: T.Number({
		description: 'The minimum zoom level of the map data being shared',
	}),
	maxzoom: T.Number({
		description: 'The maximum zoom level of the map data being shared',
	}),
	estimatedSizeBytes: EstimatedSizeBytes,
})

export const MapShareState = T.Intersect([MapShareBase, MapShareStateUpdate])

export type MapShareState = DistributiveIntersection<
	Static<typeof MapShareBase>,
	Static<typeof MapShareStateUpdate>
>

export type MapInfo = {
	mapId: string
	mapName: string
	estimatedSizeBytes: number
	bounds: [number, number, number, number]
	minzoom: number
	maxzoom: number
	created: number
}

export type Context = {
	getMapInfo: (mapId: string) => Promise<MapInfo>
	getReader: (mapId: string) => Reader
	createMapReadableStream: (mapId: string) => ReadableStream<Uint8Array>
	createMapWritableStream: (mapId: string) => WritableStream<Uint8Array>
	getDefaultOnlineStyleUrl: () => URL
	getRemotePort: () => Promise<number>
}

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
	fetch: (request: IRequestStrict, context: FetchContext) => Promise<any>
}
