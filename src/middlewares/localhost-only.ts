import {
	StatusError,
	type IRequestStrict,
	type RequestHandler,
} from 'itty-router'

/**
 * Middleware to restrict access to localhost only. The localhost listener must
 * pass { isLocalhost: true } in the context.
 */
export const localhostOnly: RequestHandler<
	IRequestStrict,
	[{ isLocalhost: boolean }]
> = async (_, { isLocalhost }) => {
	if (!isLocalhost) {
		throw new StatusError(403, 'Forbidden')
	}
}
