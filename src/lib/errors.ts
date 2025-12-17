import { StatusError } from 'itty-router'

const errorsList = [
	{
		code: 'DOWNLOAD_MAP_SHARE_NOT_PENDING',
		message: 'Cannot start download: map share is not in pending state',
		status: 409,
	},
	{
		code: 'DOWNLOAD_NOT_FOUND',
		message: 'The requested download was not found',
		status: 404,
	},
	{
		code: 'DECLINE_NOT_PENDING',
		message: 'Cannot decline map share: map share is not pending',
		status: 409,
	},
	{
		code: 'DECLINE_CANNOT_CONNECT',
		message: 'Cannot decline map share: unable to connect to sender device',
		status: 500,
	},
	{
		code: 'CANCEL_NOT_PENDING_OR_DOWNLOADING',
		message: 'Cannot cancel map share: map share is not pending or downloading',
		status: 409,
	},
	{
		code: 'ABORT_NOT_DOWNLOADING',
		message: 'Cannot abort download: download is not downloading',
		status: 409,
	},
	{
		code: 'MAP_NOT_FOUND',
		message: 'The requested map was not found',
		status: 404,
	},
	{
		code: 'MAP_SHARE_NOT_FOUND',
		message: 'The requested map share was not found',
		status: 404,
	},
	{
		code: 'INVALID_MAP_FILE',
		message: 'The provided map file is invalid',
		status: 400,
	},
	{
		code: 'INVALID_SENDER_DEVICE_ID',
		message: 'The provided senderDeviceId is invalid',
		status: 400,
	},
	{
		code: 'DOWNLOAD_ERROR',
		message: 'An error occurred during the download process',
		status: 500,
	},
] as const satisfies Array<{ message: string; status: number; code: string }>

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
