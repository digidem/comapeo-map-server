# @comapeo/map-server

A lightweight embedded map tile server for serving offline vector maps in desktop and mobile applications. Designed primarily for [CoMapeo](https://comapeo.app/), an offline-first mapping tool built for Indigenous communities and land defenders to document and monitor their territories.

## What It Does

This server provides everything needed to display offline vector maps in [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/) and compatible libraries:

- **Vector tile serving** - Delivers map tiles on demand
- **MapLibre style.json** - Provides the style specification
- **Glyphs (fonts)** - Serves text rendering resources
- **Sprites** - Delivers map icons and symbols
- **P2P map sharing** - Securely share offline maps between devices on a local network

All map resources are served from [Styled Map Package (SMP)](https://github.com/digidem/styled-map-package) files - a zip-based format containing everything needed for a complete offline map.

## Why This Exists

CoMapeo and similar offline mapping applications need to:

1. **Serve maps offline** - Display vector maps without internet connectivity
2. **Run embedded** - Operate within desktop and mobile apps (Electron, React Native, etc.)
3. **Share maps locally** - Transfer large map files between devices on the same network without internet

This server solves all three by embedding a lightweight HTTP server that speaks the MapLibre/Mapbox protocol and adds encrypted peer-to-peer map sharing.

## Architecture

The server listens on two different network interfaces:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Application (CoMapeo, etc)                    │
│                                                                   │
│                      HTTP Map Server                             │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                                                              ││
│  │  Loopback (127.0.0.1)          All Interfaces (0.0.0.0)    ││
│  │  • Map tiles                    • Noise protocol encrypted  ││
│  │  • Styles/glyphs/sprites        • Public key authentication ││
│  │  • Map management API           • Map sharing only          ││
│  │  • Regular HTTP                 • Device-to-device          ││
│  │                                                              ││
│  └──────────────────────────────────────────────────────────────┘│
│         ↑                                       ↑                │
└─────────┼───────────────────────────────────────┼────────────────┘
          │                                       │
    MapLibre GL                              Other Devices
    Your App Code                         (Noise encrypted streams)
```

**Loopback Interface** (127.0.0.1): Regular HTTP for your application to serve map tiles and control the server

**Network Interface** (0.0.0.0): Only accepts Noise protocol encrypted streams via [secret-stream-http](https://github.com/holepunchto/secret-stream-http). The public keys exchanged during the Noise handshake authenticate both client and server, eliminating the need for TLS certificates.

## Installation

```bash
npm install @comapeo/map-server
```

## Quick Start

```javascript
import { createServer } from '@comapeo/map-server'
import Hypercore from 'hypercore'

// Generate a keypair for this device (persist this!)
const keyPair = Hypercore.keyPair()

const server = createServer({
	// Fallback for when offline maps aren't available
	defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',

	// Path to your custom offline map (SMP format)
	customMapPath: '/path/to/custom-map.smp',

	// Path to bundled fallback map
	fallbackMapPath: '/path/to/fallback-map.smp',

	// Device keypair for encrypted P2P connections
	keyPair: {
		publicKey: keyPair.publicKey,
		secretKey: keyPair.secretKey,
	},
})

// Start listening on both interfaces
const { localPort, remotePort } = await server.listen({
	localPort: 8080, // Optional: loopback interface port
	remotePort: 9090, // Optional: network interface port
})

console.log(`Map tiles: http://127.0.0.1:${localPort}/maps/default/style.json`)
console.log(`P2P sharing: listening on 0.0.0.0:${remotePort} (Noise encrypted)`)
```

## Using Maps in MapLibre

Once the server is running, configure MapLibre to use it:

```javascript
import maplibregl from 'maplibre-gl'

const map = new maplibregl.Map({
	container: 'map',
	style: 'http://127.0.0.1:8080/maps/default/style.json',
	center: [0, 0],
	zoom: 2,
})
```

The `default` map ID provides intelligent fallback:

1. Tries to serve the custom map
2. Falls back to the online style URL (if network available)
3. Falls back to the bundled offline map

## Map Configuration

The server uses a three-tier map system to ensure maps are always available:

### 1. Online Map (Default)

By default, when you first start the server, it serves an online map via `defaultOnlineStyleUrl`. This provides global coverage when internet connectivity is available.

### 2. Fallback Map (Always Available Offline)

A basic global map that ships with the application, typically the [CoMapeo Fallback Map](https://github.com/digidem/comapeo-fallback-smp). This provides:

- Country outlines and borders
- Major cities and populated places
- Basic road network
- Coastlines and major water bodies

The fallback map ensures users always have some map coverage even without internet or a custom map.

### 3. Custom Map (Optional)

Users can optionally create or upload a detailed offline map for their specific area of interest using the Styled Map Package (SMP) format. Custom maps typically contain:

- High-detail vector tiles for a specific region
- Custom styling optimized for the use case
- Detailed features like trails, buildings, land use, etc.
- Much higher zoom levels than the fallback map

**Fallback Logic:**

When a client requests `/maps/default/style.json`, the server tries sources in this order:

1. **Custom map** - If uploaded by the user
2. **Online map** - If internet connectivity is available
3. **Fallback map** - Always available as last resort

This ensures maps work offline while providing the best available map for the current situation.

## Map Format: Styled Map Package (SMP)

SMP files are zip archives containing all resources for a complete offline map:

- Vector or raster tiles
- MapLibre style.json
- Glyphs (font files for text rendering)
- Sprite images and metadata (map icons)

**Creating SMP files:**

- [SMP Downloader](https://styled-map-package.fly.dev/) - Web-based tool
- [styled-map-package](https://github.com/digidem/styled-map-package) - CLI utilities
- [mapgl-tile-renderer](https://github.com/ConservationMetrics/mapgl-tile-renderer) - Generate styled raster tiles

## API Reference

### Map Tile API (Localhost Only)

All endpoints are prefixed with `http://127.0.0.1:{localPort}`

#### Get Map Style

```http
GET /maps/{mapId}/style.json
```

Returns the MapLibre style specification. Use this as the `style` URL in MapLibre.

**Map IDs:**

- `default` - Intelligent fallback (custom → online → fallback)
- `custom` - Your uploaded custom map
- `fallback` - Bundled offline map

#### Get Tiles

```http
GET /maps/{mapId}/{z}/{x}/{y}.{format}
```

Standard slippy map tile endpoint. Format is usually `pbf` for vector tiles or `png`/`jpg` for raster.

#### Get Glyphs (Fonts)

```http
GET /maps/{mapId}/glyphs/{fontstack}/{range}.pbf
```

Serves font glyphs for text rendering.

#### Get Sprites (Icons)

```http
GET /maps/{mapId}/sprites/{spriteId}{scale}.{format}
```

Serves sprite images and metadata for map icons.

#### Upload Custom Map

```http
PUT /maps/custom
Content-Type: application/octet-stream

[binary SMP file data]
```

Uploads a new custom map or replaces an existing one. The map becomes immediately available at `/maps/custom/`. This is how users add detailed offline maps for their specific area of interest.

#### Delete Custom Map

```http
DELETE /maps/custom
```

Deletes the custom map. Returns 204 No Content on success, 404 if the map doesn't exist. Only the custom map can be deleted - the fallback map is protected.

After deletion, the `/maps/default/` endpoint will fall back to the online map or fallback map.

#### Get Map Info

```http
GET /maps/{mapId}/info
```

Returns metadata about the map.

**Response:**

```json
{
	"name": "Custom Map",
	"size": 12345678,
	"created": 1234567890123
}
```

### P2P Map Sharing API

The sharing API allows devices on the same local network to securely transfer SMP files.

#### Creating a Share (Sender)

```http
POST /mapShares
Content-Type: application/json

{
  "mapId": "custom",
  "receiverDeviceId": "kmx8sejfn..." // z32-encoded public key
}
```

Creates a share offer for a specific device.

**Response (201):**

```json
{
	"shareId": "abc123...",
	"receiverDeviceId": "kmx8sejfn...",
	"mapId": "custom",
	"mapName": "My Custom Map",
	"mapShareUrls": [
		"http://192.168.1.100:9090/mapShares/abc123...",
		"http://10.0.0.5:9090/mapShares/abc123..."
	],
	"bounds": [-122.5, 37.5, -122.0, 38.0],
	"minzoom": 0,
	"maxzoom": 14,
	"estimatedSizeBytes": 12345678,
	"status": "pending"
}
```

The `mapShareUrls` contain all local IP addresses of the sender. The receiver tries each until one succeeds.

#### Monitor Share Progress (Sender)

```http
GET /mapShares/{shareId}/events
Accept: text/event-stream
```

Server-Sent Events stream for real-time status updates.

**Statuses:**

- `pending` - Awaiting receiver response
- `downloading` - Receiver is downloading (includes `bytesDownloaded`)
- `completed` - Transfer finished
- `declined` - Receiver declined (includes `reason`)
- `canceled` - Sender canceled
- `aborted` - Receiver aborted the download
- `error` - Transfer failed (includes `error`)

#### Cancel Share (Sender)

```http
POST /mapShares/{shareId}/cancel
```

Returns 204 No Content.

#### Starting a Download (Receiver)

```http
POST /downloads
Content-Type: application/json

{
  "senderDeviceId": "z32-encoded-public-key",
  "shareId": "abc123...",
  "mapShareUrls": ["http://192.168.1.100:9090/mapShares/abc123..."],
  "estimatedSizeBytes": 12345678
}
```

Starts downloading a shared map.

**Response (201):**

```json
{
	"downloadId": "xyz789...",
	"status": "downloading",
	"bytesDownloaded": 0,
	"estimatedSizeBytes": 12345678
}
```

#### Monitor Download Progress (Receiver)

```http
GET /downloads/{downloadId}/events
Accept: text/event-stream
```

Real-time download progress via Server-Sent Events.

#### Abort Download (Receiver)

```http
POST /downloads/{downloadId}/abort
```

Returns 204 No Content.

#### Decline Share (Receiver)

```http
POST /mapShares/{shareId}/decline
Content-Type: application/json

{
  "reason": "disk_full" | "user_rejected" | "other reason"
}
```

Accessed via the P2P server (remote connection).

## Complete Example: Sharing Between Two Devices

### Device A (Sender)

```javascript
import { createServer } from '@comapeo/map-server'
import Hypercore from 'hypercore'
import z32 from 'z32'

const deviceAKeyPair = Hypercore.keyPair()
const serverA = createServer({
	defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',
	customMapPath: 'file:///maps/my-map.smp',
	fallbackMapPath: 'file:///maps/fallback.smp',
	keyPair: deviceAKeyPair,
})

const { localPort } = await serverA.listen()

// Device B's public key (exchanged via your discovery mechanism)
const deviceBId = 'kmx8sejfn...' // z32-encoded

// Create share
const res = await fetch(`http://127.0.0.1:${localPort}/mapShares`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({
		mapId: 'custom',
		receiverDeviceId: deviceBId,
	}),
})

const share = await res.json()

// Send share offer to Device B via your messaging layer
await yourApp.sendToDevice(deviceBId, {
	type: 'map-share-offer',
	share,
})

// Monitor progress
const eventSource = new EventSource(
	`http://127.0.0.1:${localPort}/mapShares/${share.shareId}/events`,
)

eventSource.onmessage = (event) => {
	const state = JSON.parse(event.data)
	if (state.status === 'downloading') {
		console.log(
			`Progress: ${((state.bytesDownloaded / state.estimatedSizeBytes) * 100).toFixed(1)}%`,
		)
	}
	if (state.status === 'completed') {
		console.log('Transfer complete!')
		eventSource.close()
	}
}
```

### Device B (Receiver)

```javascript
import { createServer } from '@comapeo/map-server'
import Hypercore from 'hypercore'

const deviceBKeyPair = Hypercore.keyPair()
const serverB = createServer({
	defaultOnlineStyleUrl: 'https://demotiles.maplibre.org/style.json',
	customMapPath: 'file:///maps/my-map.smp',
	fallbackMapPath: 'file:///maps/fallback.smp',
	keyPair: deviceBKeyPair,
})

const { localPort } = await serverB.listen()

// Receive share offer from Device A
yourApp.onMessage(async (message) => {
	if (message.type !== 'map-share-offer') return

	const { share } = message

	// Ask user
	const accept = await askUser(
		`Accept "${share.mapName}"? (${formatBytes(share.estimatedSizeBytes)})`,
	)

	if (!accept) {
		// Decline via P2P connection
		await fetch(`${share.mapShareUrls[0]}/decline`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ reason: 'user_rejected' }),
		})
		return
	}

	// Start download
	const res = await fetch(`http://127.0.0.1:${localPort}/downloads`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			senderDeviceId: message.senderDeviceId,
			shareId: share.shareId,
			mapShareUrls: share.mapShareUrls,
			estimatedSizeBytes: share.estimatedSizeBytes,
		}),
	})

	const download = await res.json()

	// Monitor download
	const es = new EventSource(
		`http://127.0.0.1:${localPort}/downloads/${download.downloadId}/events`,
	)

	es.onmessage = (event) => {
		const state = JSON.parse(event.data)
		if (state.status === 'downloading') {
			updateUI((state.bytesDownloaded / state.estimatedSizeBytes) * 100)
		}
		if (state.status === 'completed') {
			console.log('Map ready! Available at /maps/custom/')
			es.close()
		}
	}
})
```

## Security Model

- **Localhost API**: Only accessible from `127.0.0.1` - your application code
- **Noise Protocol Encryption**: The network interface uses the [Noise protocol](http://www.noiseprotocol.org/) via [secret-stream-http](https://github.com/holepunchto/secret-stream-http)
- **Public Key Authentication**: Client and server public keys from the Noise handshake are used to authenticate connections - no TLS certificates needed
- **Device Authorization**: Each share is tied to a specific receiver device ID (public key)
- **Access Validation**: Remote requests are rejected unless the authenticated client public key matches the share's `receiverDeviceId`

## Errors

All error responses follow this format:

```json
{
	"code": "ERROR_CODE",
	"error": "Human-readable error message"
}
```

### Map Errors

| Code               | Status | Description                               |
| ------------------ | ------ | ----------------------------------------- |
| `MAP_NOT_FOUND`    | 404    | The requested map does not exist          |
| `INVALID_MAP_FILE` | 400    | The uploaded file is not a valid SMP file |

### Map Share Errors (Sender-side)

| Code                          | Status | Description                                              |
| ----------------------------- | ------ | -------------------------------------------------------- |
| `MAP_SHARE_NOT_FOUND`         | 404    | The requested map share does not exist                   |
| `CANCEL_SHARE_NOT_CANCELABLE` | 409    | Cannot cancel a share that is not pending or downloading |
| `DECLINE_SHARE_NOT_PENDING`   | 409    | Cannot decline a share that is not pending               |
| `DECLINE_CANNOT_CONNECT`      | 502    | Unable to connect to the sender to decline the share     |

### Download Errors (Receiver-side)

| Code                         | Status | Description                                                |
| ---------------------------- | ------ | ---------------------------------------------------------- |
| `DOWNLOAD_NOT_FOUND`         | 404    | The requested download does not exist                      |
| `DOWNLOAD_ERROR`             | 500    | The download failed unexpectedly                           |
| `DOWNLOAD_SHARE_CANCELED`    | 409    | The sender canceled the share before download completed    |
| `DOWNLOAD_SHARE_DECLINED`    | 409    | Cannot download a share that was declined                  |
| `DOWNLOAD_SHARE_NOT_PENDING` | 409    | Cannot download a share that is not pending                |
| `ABORT_NOT_DOWNLOADING`      | 409    | Cannot abort a download that is not in progress            |
| `INVALID_SENDER_DEVICE_ID`   | 400    | The sender device ID is not a valid z32-encoded public key |

### Generic Errors

| Code              | Status | Description                                                 |
| ----------------- | ------ | ----------------------------------------------------------- |
| `FORBIDDEN`       | 403    | Access denied (remote request without valid authentication) |
| `INVALID_REQUEST` | 400    | The request body is missing or malformed                    |

## Network Discovery

This library **does not** handle peer discovery. You need to implement that separately:

- **mDNS/Bonjour** - Discover devices on local network
- **Hyperswarm** - DHT-based peer discovery
- **QR codes** - Scan to exchange device IDs and IP addresses
- **Manual entry** - Let users type IP addresses

The sender provides all their local IP addresses in `mapShareUrls`. The receiver tries each until one connects.

## Use Cases

- **CoMapeo** - Offline mapping for Indigenous communities and land defenders
- **Field data collection** - ODK, Kobo Collect, Terrastories
- **Offline navigation** - Apps needing offline vector maps
- **Emergency response** - Maps in areas with poor/no connectivity
- **Research expeditions** - Scientific fieldwork in remote areas

## Related Projects

- [CoMapeo](https://comapeo.app/) - Offline-first mapping for territorial monitoring
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/) - Open-source vector map rendering
- [Styled Map Package](https://github.com/digidem/styled-map-package) - SMP format specification
- [CoMapeo Fallback Map](https://github.com/digidem/comapeo-fallback-smp) - Basic global map with country outlines and major cities
- [secret-stream-http](https://github.com/holepunchto/secret-stream-http) - Encrypted HTTP over TCP

## License

MIT

---

**Sources:**

- [CoMapeo: Introducing CoMapeo](https://awana.digital/blog/introducing-comapeo----a-next-gen-territorial-monitoring-mapping-collaboration-tool)
- [MapLibre GL JS Documentation](https://maplibre.org/maplibre-gl-js/docs/)
- [Styled Map Package on GitHub](https://github.com/digidem/styled-map-package)
- [SMP Downloader Tool](https://styled-map-package.fly.dev/)
- [MapGL Tile Renderer](https://github.com/ConservationMetrics/mapgl-tile-renderer)
