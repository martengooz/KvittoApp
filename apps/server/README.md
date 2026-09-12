# KvittoApp companion server

A small sync relay for [KvittoApp](../../README.md). It stores what the devices
send, hands back what changed, keeps the images, and optionally proxies AI
extraction so a provider key never has to live on a phone.

It is deliberately **not** a second source of truth. Every device holds the
complete archive, so the server can be thrown away and rebuilt from any one of
them.

## Running it

```bash
npm install                              # from the repository root
npm run build --workspace @kvitto/shared
npm run dev --workspace @kvitto/server   # http://localhost:8787
npm run pair --workspace @kvitto/server  # prints a one-time pairing code
```

Type the code into the app under Settings → Synkronisering, together with the
server address. Codes are single-use and expire after 15 minutes.

### Docker

```bash
cp apps/server/.env.example .env         # then edit
docker compose up -d --build
docker compose exec kvitto node apps/server/dist/cli/pair.js
```

The image serves the built PWA as well as the API, so one container is the
whole deployment. Everything persists under `/data` — that is the directory to
back up.

## Configuration

Every setting has a working default; see [`.env.example`](.env.example) for the
full list. The ones that matter:

| Variable | Default | Why you would change it |
|---|---|---|
| `KVITTO_CORS_ORIGINS` | *(unset)* | **Set this before exposing the server publicly.** Unset means any origin is reflected, so any website a paired user visits can use their token. The server logs a warning at startup while it is unset. |
| `KVITTO_DATA_DIR` | `./data` | Where the SQLite file and images live. |
| `KVITTO_TRUST_PROXY` | `false` | Set behind nginx/Caddy/Traefik so rate limiting sees real client IPs. |
| `KVITTO_STATIC_DIR` | *(unset)* | Serve the built PWA from this server too. |
| `KVITTO_AI_PROVIDER` | *(unset)* | `anthropic` or `openai` to enable the extraction proxy. Leave unset to disable it. |
| `KVITTO_AI_ALLOWED_MODELS` | the configured model | Models a device may request. Without this, a device could run up a bill on a model you did not choose. |

## Security model

Single account, many devices. There is no signup, no password and no reset
flow, because there is nothing to sign up to — the server belongs to one
household.

- **Device tokens** are 32 bytes of CSPRNG output. Only their SHA-256 is
  stored, so a leaked database hands out no working credentials.
- **Pairing codes** are single-use, short-lived, and rate-limited to 10
  attempts per 10 minutes. All failure modes return the same error, so a
  guesser learns nothing about which codes exist.
- **Blobs are verified against their own digest** on upload. Without that check
  a client could overwrite one image's bytes under another's digest, and every
  device that later pulled it would get the wrong picture. Blob ids are
  validated as 64 hex characters before they are ever used in a path.
- **The AI proxy never forwards an upstream error body** — those can echo
  request headers — and reports an auth failure as a generic "contact the
  administrator" rather than leaking whether the operator's key is wrong or
  merely unauthorised for that model.
- **Internal errors are not surfaced** to clients; they carry paths and
  configuration detail.

## API

All endpoints except `/health` and `/auth/pair` require
`Authorization: Bearer <device token>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness, protocol version, whether the AI proxy is on. |
| `POST` | `/auth/pair` | Exchange a pairing code for a device token. |
| `GET` | `/auth/me` | Who this token belongs to, and proxy capabilities. |
| `GET` | `/auth/devices` | List the account's devices. |
| `DELETE` | `/auth/devices/:id` | Revoke another device. |
| `POST` | `/sync/push` | Upload changed records. |
| `GET` | `/sync/pull?since=N` | Download everything with `rev > N`. |
| `GET` | `/sync/status` | Current revision and row counts. |
| `POST` | `/blobs/status` | Which of these digests do you already have? |
| `PUT` | `/blobs/:sha256` | Upload an image. |
| `GET` | `/blobs/:sha256` | Download an image. |
| `POST` | `/ai/parse` | Extract a receipt from an uploaded image. |

### How sync works

Every record carries a client `updatedAt` and a server-assigned `rev`. Clients
push everything dirty, then pull everything with `rev > cursor`. Because `rev`
is a gap-free per-account counter assigned inside the push transaction, that
single integer is the entire sync cursor, and paging by revision means a record
written mid-pull cannot cause another to be skipped.

Conflicts resolve last-write-wins on `updatedAt`, with a deterministic
tie-break. Both the client and the server run the *same* `resolveConflict`
function from `@kvitto/shared`, so they reach the same answer independently
without another round-trip. A record the server already holds a newer version
of comes back marked `stale` rather than being force-written, and the client
picks up the newer version on its next pull.

Deletes are tombstones, so a delete made offline still propagates to other
devices instead of the record simply reappearing.

## Storage

- **SQLite** (WAL, `synchronous = FULL`) for records. Schema is created at boot
  as idempotent DDL rather than through a migration tool: for a single-file
  self-hosted database that means there is no separate step to forget on
  upgrade, and no migration state to drift out of step with the binary.
- **The filesystem** for images, sharded two levels deep by the first four
  characters of the digest. They are large, immutable and never queried, so
  keeping them out of the database keeps the WAL small and makes a backup a
  plain file copy.

## Tests

```bash
npm test --workspace @kvitto/server
```

Covers pairing (including single-use enforcement), authentication, push/pull
round-trips, both conflict directions, partial-batch rejection, revision
paging, tombstone propagation, blob round-trips, digest-mismatch rejection,
path-traversal rejection, and the protocol-version handshake.
