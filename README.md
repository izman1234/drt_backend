# DRT Backend

The server component of the Discord Replacement Tool — a self-hosted, privacy-focused chat platform with real-time messaging, voice channels, and end-to-end identity verification.

## Features

- **Passwordless Authentication** — Ed25519 challenge-response identity system (no passwords sent to server)
- **Recovery Key System** — 256-bit recovery keys for account recovery and identity key rotation
- **Encrypted Backup** — Client-encrypted identity backups stored server-side, restorable via recovery key
- **Text Channels** — Create, rename, reorder, and delete channels with unread tracking
- **Voice Channels** — WebRTC signaling relay via Socket.IO (offer/answer/ICE candidates, speaking status, mute/deafen)
- **Real-time Messaging** — Socket.IO for live message create/update/delete and channel events
- **Message Attachments** — Text and base64 image attachments with reply threading
- **Message Signatures** — Optional Ed25519 message signing with server-side verification
- **Emoji Reactions** — Add and remove emoji reactions on messages
- **GIF Integration** — Klipy API integration for GIF search, trending, and categories
- **User Profiles** — Display names, profile pictures, and custom name colors
- **User Presence** — Real-time online/offline/away status broadcasting
- **Database Encryption** — AES-256-GCM field-level encryption for message content and images at rest
- **Auto TLS** — Self-signed certificate generation with SAN entries for localhost and all machine network addresses; remote clients connect via Trust-On-First-Use certificate pinning
- **Rate Limiting** — Per-IP rate limiting on authentication endpoints
- **Portable Build** — Compiles to a single Windows executable via `pkg` with custom icon injection

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: SQLite3
- **Real-time**: Socket.IO
- **Auth**: JWT (jsonwebtoken) + Ed25519 (libsodium)
- **Encryption**: AES-256-GCM (Node.js crypto) + libsodium
- **TLS**: Self-signed certificates (selfsigned)
- **Build**: pkg + rcedit + sharp (for icon generation)

## Setup

If you only care about using it and not actually contributing go to the tags tab and download the .exe and .sha256 of the desired version. 
Else:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```

   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

The server will start on port `5000` by default (configurable via `server-config.json`).

## Configuration

The server uses `server-config.json` (auto-created with defaults on first run):

| Key | Default | Description |
|-----|---------|-------------|
| `serverName` | `"DRT Server"` | Display name shown to clients |
| `serverIcon` | `null` | Server icon — filename, URL, or data URI |
| `port` | `5000` | Primary listening port |
| `dualProtocol` | `false` | `true` = HTTP on PORT + HTTPS on PORT+1 (for development) |
| `databasePath` | `"./data/database.db"` | SQLite database file path |
| `klipyApiKey` | `""` | Klipy GIF API key (optional). You must provide your own klipy API Key |

Secrets (JWT secret and database encryption key) are auto-generated and stored encrypted in `secrets.dat`.

## Protocol Modes

- **Production** (`dualProtocol: false`): HTTPS only on PORT; falls back to HTTP if TLS generation fails
- **Development** (`dualProtocol: true`): HTTP on PORT, HTTPS on PORT+1; Socket.IO attached to both

## Building

To compile to a standalone Windows executable:
```bash
npm run build
```

This produces a portable `.exe` in the `dist/` directory with an embedded database engine and custom icon.

## TODO

- Linux support
- Roles and permissions
- Ping (@) users
- Video / Screen Sharing
- Custom Server Emojis
- Banning / Kicking
- More I can't think of right now

## API Endpoints

### Identity / Auth (`/api/auth/identity`)
- `POST /register` — Register new identity
- `POST /challenge` — Request a challenge nonce
- `POST /verify` — Verify signed challenge (issues JWT)
- `GET /check/:username` — Check if user exists
- `PUT /backup-blob` — Upload encrypted backup blob
- `POST /backup-blob/download` — Download backup blob via recovery key
- `POST /rotate-key` — Rotate identity key

### Users (`/api/users`)
- `GET /profile` — Get current user profile
- `PUT /displayName` — Update display name
- `PUT /profilePicture` — Update profile picture
- `PUT /nameColor` — Update name color
- `GET /all` — Get all users
- `DELETE /leave` — Leave server (soft-delete)

### Channels (`/api/channels`)
- `POST /` — Create channel
- `GET /` — Get all channels
- `GET /unread/list` — Get channels with unread messages
- `GET /:channelId` — Get channel details
- `POST /:channelId/join` — Join channel
- `POST /:channelId/leave` — Leave channel
- `GET /:channelId/members` — Get channel members
- `PUT /:channelId` — Update channel
- `PUT /:channelId/reorder` — Reorder channel
- `DELETE /:channelId` — Delete channel
- `PUT /:channelId/read` — Mark channel as read

### Messages (`/api/messages`)
- `POST /` — Send message
- `GET /channel/:channelId` — Get messages (paginated)
- `PUT /:messageId` — Edit message
- `DELETE /:messageId` — Delete message

### Reactions (`/api/reactions`)
- `POST /:messageId` — Add reaction
- `DELETE /:messageId/:emoji` — Remove reaction

### GIFs (`/api/gifs`)
- `GET /search` — Search GIFs
- `GET /trending` — Trending GIFs
- `GET /categories` — GIF categories
- `GET /category/:categoryName` — GIFs by category

### Server
- `GET /api/health` — Health check
- `GET /api/server/info` — Server name, icon, TLS status

## Database

SQLite with the following tables:
- `users` — User accounts and identity keys
- `channels` — Text and voice channels
- `messages` — Messages with encrypted content/images
- `channel_members` — Channel membership
- `reactions` — Emoji reactions
- `channel_reads` — Per-user read tracking
- `auth_challenges` — Challenge-response nonces (5-min TTL)
- `key_audit_log` — Identity key rotation audit trail

A default `#general` text channel is auto-created on first run.

## License

See [LICENSE](LICENSE) for details.
