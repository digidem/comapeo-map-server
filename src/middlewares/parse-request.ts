import {
	type RequestHandler,
	type IRequestStrict,
	StatusError,
	type IRequest,
} from 'itty-router'
import { Type as T, type StaticType } from 'typebox'
import { Compile } from 'typebox/compile'

/**
 * A small helper to create middleware that parses and validates the request
 * body against the given schema. Downstream handlers can access the type-safe
 * parsed body via `request.parsed`.
 */
export const parseRequest = <
	TSchema extends T.TSchema,
	TRequest extends IRequest = IRequestStrict,
>(
	schema: TSchema,
): RequestHandler<
	TRequest & { parsed: StaticType<[], 'Decode', {}, {}, TSchema> }
> => {
	const C = Compile(schema)
	return async (request) => {
		try {
			const json = await request.json()
			// Use Check to validate without type coercion
			if (!C.Check(json)) {
				throw new StatusError(400, 'Invalid request body')
			}
			request.parsed = json as StaticType<[], 'Decode', {}, {}, TSchema>
		} catch (error) {
			if (error instanceof StatusError) throw error
			throw new StatusError(400, 'Invalid request body')
		}
	}
}
