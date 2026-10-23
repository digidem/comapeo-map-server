import { describe, it, expect } from 'vitest'

import {
	remoteErrorDetails,
	remoteStatusError,
	StatusError,
} from '../src/lib/errors.js'

const withProto = (fields: object) =>
	JSON.stringify(fields).replace(/^\{/, '{"__proto__":{"polluted":true},')

describe('remoteStatusError', () => {
	it('keeps properties it does not know about', async () => {
		const response = new Response(
			JSON.stringify({ code: 'NEW_CODE', message: 'From the future', hint: 1 }),
			{ status: 409 },
		)
		const err = await remoteStatusError(response)
		expect(err).toBeInstanceOf(StatusError)
		expect(err).toMatchObject({
			status: 409,
			code: 'NEW_CODE',
			message: 'From the future',
			hint: 1,
		})
	})

	it('does not let __proto__ replace the prototype', async () => {
		const response = new Response(withProto({ code: 'X' }), { status: 409 })
		const err = await remoteStatusError(response)
		expect(err).toBeInstanceOf(StatusError)
		expect(err.code).toBe('X')
		expect(err.polluted).toBeUndefined()
	})

	it('handles a body that is not a JSON object', async () => {
		for (const body of ['<html>Bad Gateway</html>', 'null', '[1]', '"x"', '']) {
			const err = await remoteStatusError(new Response(body, { status: 502 }))
			expect(err).toBeInstanceOf(StatusError)
			expect(err.status).toBe(502)
			expect(err.code).toBe('UNKNOWN_ERROR')
			expect(err.message).toMatch(/502/)
		}
	})
})

describe('remoteErrorDetails', () => {
	it('keeps extra properties', () => {
		expect(
			remoteErrorDetails({ code: 'NEW_CODE', message: 'm', hint: 1 }),
		).toEqual({ code: 'NEW_CODE', message: 'm', hint: 1 })
	})

	it('fills in a code and message when they are missing or not strings', () => {
		expect(remoteErrorDetails({ code: 42 })).toEqual({
			code: 'UNKNOWN_ERROR',
			message: 'Unknown error',
		})
		expect(remoteErrorDetails('oops')).toEqual({
			code: 'UNKNOWN_ERROR',
			message: 'Unknown error',
		})
	})

	it('drops __proto__', () => {
		const details = remoteErrorDetails(JSON.parse(withProto({ code: 'X' })))
		expect(Object.keys(details)).not.toContain('__proto__')
		expect(Object.getPrototypeOf(details)).toBe(Object.prototype)
	})
})
