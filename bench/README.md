# Benchmarks

`npm run bench` — measures the paths that move whole map files:

- `upload.bench.ts` — `PUT /maps/custom` end to end, plus the writable stream
  it feeds on its own.
- `download.bench.ts` — `GET /mapShares/:shareId/download` over the local
  server.
- `remote-download.bench.ts` — the same download over the encrypted remote
  server, the way a receiving device actually pulls a map.

Requests are issued from a forked child process (`client.mjs`). Running the
client in the same process makes it compete with the server for the event loop
and hides server-side differences; it also matches how this runs on a device,
where the app and the server are separate processes.

Each iteration transfers a 32 MiB `.smp` generated at startup from
incompressible tile data, so the archive does not shrink under deflate. Vitest
reports time per iteration: 32 MiB / mean ms is the throughput.

## Reading the numbers

Vitest's benchmark runner ignores `beforeAll` inside a `describe` and silently
swallows anything a `bench` body throws, which shows up as an empty results
table rather than a failure. Both files therefore do all setup in a file-level
`beforeAll` and run each benched path once there.

The first benchmark in a file is penalised by warmup even with
`warmupIterations` set — compare a variant against a baseline run of the same
benchmark, not against its neighbours in the table.

## Where the buffer sizes came from

The high water marks in `src/context.ts` and `src/index.ts` were picked by
sweeping them here, on macOS with an SSD (measured as time for 32 MiB, mean of
25 iterations):

| Change                               |  Before |   After |
| ------------------------------------ | ------: | ------: |
| `createWriteStream` 16 KiB → 256 KiB | 24.6 ms | 15.9 ms |
| `createReadStream` 64 KiB → 256 KiB  | 40.6 ms | 27.0 ms |
| Local server socket 64 KiB → 512 KiB | 37.7 ms | 28.9 ms |

Raising each beyond those sizes bought nothing measurable. Two things did
_not_ help and were left alone: the queuing strategy of the upload route's
idle-timeout `TransformStream`, and a larger socket buffer on the download
side.

Both halves of the pipeline were within ~15% of a bare
`req.pipe(fs.createWriteStream(…))` afterwards, so the remaining overhead is
not in the fetch adapter or the web streams.

## Why the remote download is ~6x slower

Pulling a share over SecretStream costs ~118 ms per 32 MiB against ~20 ms over
the local server, and no amount of buffering closes that gap. Raising the high
water mark on the raw TCP socket and on the `SecretStreamSocket` duplex — both
inside `secret-stream-http` — moved the number by under 4%.

The cost is the cipher. A CPU profile of the sending process puts 63% of its
samples in `crypto_secretstream_xchacha20poly1305_push`; the streamx-to-Node
duplex bridge, HTTP, and the socket writes together account for under 5%.
Measured directly, `sodium-native` encrypts at ~340 MiB/s on this machine
(macOS arm64), so 32 MiB costs ~95 ms — essentially the whole transfer. Sender
and receiver already overlap: the total is roughly one pass of the cipher, not
two.

For reference on the same machine, OpenSSL's ChaCha20-Poly1305 through
`node:crypto` runs at ~855 MiB/s. Closing that gap would mean changing how
`@hyperswarm/secret-stream` encrypts, which is a wire-format concern well
outside this server.
