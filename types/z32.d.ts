declare module 'z32' {
	/**
	 * Encode a number to a z32 string
	 * @param num Number to encode
	 * @returns z32 encoded string
	 */
	declare function encode(buf: Buffer | Uint8Array): string
	declare function decode(
		str: string,
		out?: Buffer | Uint8Array,
	): Buffer | Uint8Array
	export { encode, decode }
}
