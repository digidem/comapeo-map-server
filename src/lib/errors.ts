import { StatusError } from 'itty-router'

const errorsList = [
	// Download errors (receiver-side)
	{
		code: 'DOWNLOAD_NOT_FOUND',
		error: 'Download not found',
		status: 404,
	},
	{
		code: 'DOWNLOAD_ERROR',
		error: 'Download failed',
		status: 500,
	},
	{
		code: 'DOWNLOAD_SHARE_CANCELED',
		error: 'Download canceled by sender',
		status: 409,
	},
	{
		code: 'DOWNLOAD_SHARE_DECLINED',
		error: 'Cannot download: share was declined',
		status: 409,
	},
	{
		code: 'DOWNLOAD_SHARE_NOT_PENDING',
		error: 'Cannot download: share is not pending',
		status: 409,
	},
	{
		code: 'ABORT_NOT_DOWNLOADING',
		error: 'Cannot abort: download is not in progress',
		status: 409,
	},
	{
		code: 'INVALID_SENDER_DEVICE_ID',
		error: 'Invalid sender device ID',
		status: 400,
	},

	// Map share errors (sender-side)
	{
		code: 'MAP_SHARE_NOT_FOUND',
		error: 'Map share not found',
		status: 404,
	},
	{
		code: 'CANCEL_SHARE_NOT_CANCELABLE',
		error: 'Cannot cancel: share is not pending or downloading',
		status: 409,
	},
	{
		code: 'DECLINE_SHARE_NOT_PENDING',
		error: 'Cannot decline: share is not pending',
		status: 409,
	},
	{
		code: 'DECLINE_CANNOT_CONNECT',
		error: 'Cannot decline: unable to connect to sender',
		status: 502,
	},

	// Map errors
	{
		code: 'MAP_NOT_FOUND',
		error: 'Map not found',
		status: 404,
	},
	{
		code: 'RESOURCE_NOT_FOUND',
		error: 'Resource not found',
		status: 404,
	},
	{
		code: 'INVALID_MAP_FILE',
		error: 'Invalid map file',
		status: 400,
	},

	// Generic errors
	{
		code: 'FORBIDDEN',
		error: 'Forbidden',
		status: 403,
	},
	{
		code: 'INVALID_REQUEST',
		error: 'Invalid request',
		status: 400,
	},
] as const satisfies Array<{ error: string; status: number; code: string }>

export const errors = {} as Record<
	(typeof errorsList)[number]['code'],
	new (body?: { [key: string]: any } | string) => StatusError
>
for (const { code, error, status } of errorsList) {
	errors[code] = class extends StatusError {
		constructor(body?: { [key: string]: any } | string) {
			body = typeof body === 'string' ? { error: body } : body
			super(status, { code, error, ...body })
		}
	}
}

export class ExhaustivenessError extends Error {
	constructor(value: never) {
		super(`Exhaustiveness check failed. ${value} should be impossible`)
		this.name = 'ExhaustivenessError'
	}
}

export function jsonError(err: unknown): { message: string; code: string } {
	if (err === null) {
		return { message: 'Unknown error', code: 'UNKNOWN_ERROR' }
	} else if (typeof err !== 'object') {
		return { message: String(err), code: 'UNKNOWN_ERROR' }
	} else {
		return {
			message:
				'message' in err
					? String((err as any).message)
					: String((err as any).error),
			code: (err as any).code || 'UNKNOWN_ERROR',
		}
	}
}
