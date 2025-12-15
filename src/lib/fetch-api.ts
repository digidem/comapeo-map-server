import type { ServerAdapterOptions } from '@whatwg-node/server'

// @whatwg-node/server ponyfills the fetch API by default, which has bugs in the
// ReadableStream implementation that was causing issues with stream error
// propagation. To avoid these issues, we explicitly provide the native fetch
// API implementation from Node.js.
export const fetchAPI: ServerAdapterOptions<any>['fetchAPI'] = {
	ReadableStream: globalThis.ReadableStream,
	WritableStream: globalThis.WritableStream,
	TransformStream: globalThis.TransformStream,
	Response: globalThis.Response,
	Request: globalThis.Request,
	Headers: globalThis.Headers,
	FormData: globalThis.FormData,
	File: globalThis.File,
	Blob: globalThis.Blob,
	fetch: globalThis.fetch,
}
