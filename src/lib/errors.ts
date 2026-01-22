import { json, type ErrorFormatter } from 'itty-router'

interface ErrorDefinition {
	message: string
	status: number
	code: string
}

type StatusErrorObject = {
	message?: string
	[key: string]: any
}

export class StatusError extends Error {
	status: number;
	[key: string]: any

	constructor(status = 500, body?: StatusErrorObject | string) {
		super(typeof body === 'object' ? body.message : body)
		if (typeof body === 'object') Object.assign(this, body)
		this.status = status
	}
}

const errorsList = [
	// Download errors (receiver-side)
	{
		code: 'DOWNLOAD_NOT_FOUND',
		message: 'Download not found',
		status: 404,
	},
	{
		code: 'DOWNLOAD_ERROR',
		message: 'Download failed',
		status: 500,
	},
	{
		code: 'DOWNLOAD_SHARE_CANCELED',
		message: 'Download canceled by sender',
		status: 409,
	},
	{
		code: 'DOWNLOAD_SHARE_DECLINED',
		message: 'Cannot download: share was declined',
		status: 409,
	},
	{
		code: 'DOWNLOAD_SHARE_NOT_PENDING',
		message: 'Cannot download: share is not pending',
		status: 409,
	},
	{
		code: 'ABORT_NOT_DOWNLOADING',
		message: 'Cannot abort: download is not in progress',
		status: 409,
	},
	{
		code: 'INVALID_SENDER_DEVICE_ID',
		message: 'Invalid sender device ID',
		status: 400,
	},

	// Map share errors (sender-side)
	{
		code: 'MAP_SHARE_NOT_FOUND',
		message: 'Map share not found',
		status: 404,
	},
	{
		code: 'CANCEL_SHARE_NOT_CANCELABLE',
		message: 'Cannot cancel: share is not pending or downloading',
		status: 409,
	},
	{
		code: 'DECLINE_SHARE_NOT_PENDING',
		message: 'Cannot decline: share is not pending',
		status: 409,
	},
	{
		code: 'DECLINE_CANNOT_CONNECT',
		message: 'Cannot decline: unable to connect to sender',
		status: 502,
	},

	// Map errors
	{
		code: 'MAP_NOT_FOUND',
		message: 'Map not found',
		status: 404,
	},
	{
		code: 'RESOURCE_NOT_FOUND',
		error: 'Resource not found',
		status: 404,
	},
	{
		code: 'INVALID_MAP_FILE',
		message: 'Invalid map file',
		status: 400,
	},

	// Generic errors
	{
		code: 'FORBIDDEN',
		message: 'Forbidden',
		status: 403,
	},
	{
		code: 'INVALID_REQUEST',
		message: 'Invalid request',
		status: 400,
	},
] as const satisfies Array<ErrorDefinition>

export const errors = {} as Record<
	(typeof errorsList)[number]['code'],
	new (body?: { [key: string]: any } | string) => StatusError
>
for (const { code, message, status } of errorsList) {
	errors[code] = class extends StatusError {
		constructor(body?: { [key: string]: any } | string) {
			body = typeof body === 'string' ? { message: body } : body
			super(status, { code, message, ...body })
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

const getMessage = (code: number): string =>
	({
		400: 'Bad Request',
		401: 'Unauthorized',
		403: 'Forbidden',
		404: 'Not Found',
		500: 'Internal Server Error',
	})[code] || 'Unknown Error'

const getCode = (status: number): string =>
	({
		400: 'BAD_REQUEST',
		401: 'UNAUTHORIZED',
		403: 'FORBIDDEN',
		404: 'NOT_FOUND',
		500: 'INTERNAL_SERVER_ERROR',
	})[status] || 'UNKNOWN_ERROR'

export const error: ErrorFormatter = (a = 500, b?) => {
	// handle passing an Error | StatusError directly in
	if (a instanceof Error) {
		const { message, code, ...err } = a
		a = a.status || 500
		b = {
			message: message || getMessage(a),
			code: code || getCode(a),
			...err,
		}
	}

	b = {
		status: a,
		...(typeof b === 'object' ? b : { message: b || getMessage(a) }),
	}

	return json(b, { status: a })
}
