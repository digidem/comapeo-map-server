import { type IRequestStrict, type RequestHandler } from 'itty-router'

import { errors } from '../lib/errors.js'

/**
 * Middleware to restrict access to localhost only. The localhost listener must
 * pass { isLocalhost: true } in the context.
 */
export const localhostOnly: RequestHandler<
	IRequestStrict,
	[{ isLocalhost: boolean }]
> = async (_, { isLocalhost }) => {
	if (!isLocalhost) {
		throw new errors.FORBIDDEN()
	}
}
