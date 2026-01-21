import { StatusError } from 'itty-router'

const errorsList = [
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
