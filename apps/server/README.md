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
```

Open `http://localhost:8787/server` for the server dashboard and create a
pairing code there. Scan its QR code in the app under Settings → Synkronisering,
or enter the code manually. Before creating the code, use a server address the
scanning device can reach; `localhost` only works on the same device. Codes are
single-use and expire after 15 minutes. The dashboard also configures the
server-side AI provider, endpoint, model, output limit, and synchronized API
keys.

### Docker

```bash
cp apps/server/.env.example .env         # then edit
docker compose up -d --build
```

Open `http://localhost:8787/server` to create a pairing code. The CLI command
`docker compose exec kvitto node apps/server/dist/cli/pair.js` remains available
for headless installations.

The image serves the built PWA as well as the API, so one container is the
whole deployment. Everything persists under `/data` — that is the directory to
back up.

### GitHub Pages and HTTPS

When the PWA is hosted on GitHub Pages, its sync server must also use HTTPS.
Browsers block an HTTPS page from calling an `http://` API as mixed content;
this happens before the request reaches Fastify, so changing CORS cannot fix it.

The simplest production setup without installing local certificates or tunnel
software is to run the Docker image on a VPS or managed container host that
provides HTTPS and a persistent volume. Mount the volume at `/data`, then set:

```env
KVITTO_PUBLIC_URL=https://kvitto.example.com
KVITTO_CORS_ORIGINS=https://martengooz.github.io
KVITTO_TRUST_PROXY=true
KVITTO_STATIC_DIR=/app/web
```

`KVITTO_PUBLIC_URL` is the address encoded in pairing QR codes. It must be the
public HTTPS address reachable by the phone. `KVITTO_CORS_ORIGINS` is the Pages
origin only, without the repository path; for this repository that is
`https://martengooz.github.io`, not
`https://martengooz.github.io/KvittoApp/`.

After deployment, open `https://kvitto.example.com/server` and create a new QR
code. Codes created by a local dashboard may contain a private or HTTP address
and should not be reused by the Pages app.

Do not use an ephemeral serverless filesystem. `/data` holds the SQLite
database, receipt images, and `secrets.key`; losing that key makes synchronized
secrets unreadable. A managed container with a persistent disk, or a small VPS
behind managed TLS, is appropriate.

## Configuration

Every setting has a working default; see [`.env.example`](.env.example) for the
full list. The ones that matter:

| Variable | Default | Why you would change it |
|---|---|---|
| `KVITTO_PUBLIC_URL` | auto-detected | Public HTTPS origin encoded in pairing QR codes. Set this behind a proxy, in Docker, or when using GitHub Pages. |
| `KVITTO_CORS_ORIGINS` | *(unset)* | **Set this before exposing the server publicly.** Unset means any origin is reflected, so any website a paired user visits can use their token. The server logs a warning at startup while it is unset. |
| `KVITTO_DATA_DIR` | `./data` | Where the SQLite file and images live. |
| `KVITTO_SECRETS_KEY` | generated | Encryption key for synchronized secrets. When unset, `secrets.key` is created in the data directory and must be backed up. |
| `KVITTO_TRUST_PROXY` | `false` | Set behind nginx/Caddy/Traefik so rate limiting sees real client IPs. |
| `KVITTO_STATIC_DIR` | *(unset)* | Serve the built PWA from this server too. |
| `KVITTO_AI_PROVIDER` | *(unset)* | `anthropic` or `openai` to enable the extraction proxy. Leave unset to disable it. |
| `KVITTO_AI_ALLOWED_MODELS` | the configured model | Models a device may request. Without this, a device could run up a bill on a model you did not choose. |
| `KVITTO_LLM_ENABLED` | `false` | Turn on the local model (below). |

## The local model

Optionally, the server reads synced receipts itself with a vision model running
on the same machine. Nothing leaves your network, and no API key is involved.

```sh
KVITTO_LLM_ENABLED=1 npm start
```

It uses [Ollama](https://ollama.com) as the inference host — one binary that
covers CUDA, ROCm, Metal and plain CPU on both Linux and macOS, which is the
whole reason it is not a bundled runtime. The server will **start** Ollama if it
is installed and not already running, and stop it again on exit; it will never
install it for you. `GET /llm/status` says which of those situations you are in
and prints the install command for your platform.

The model is `qwen3-vl:4b` — about 3 GB, roughly 4 GB of RAM, and the smallest
vision model that reliably holds a JSON schema over a whole receipt. Fetch it
once with `ollama pull qwen3-vl:4b`, or `POST /llm/pull`, or set
`KVITTO_LLM_AUTO_PULL=1` to have the first pass fetch it.

| Variable | Default | Why you would change it |
|---|---|---|
| `KVITTO_LLM_BASE_URL` | `http://127.0.0.1:11434` | Ollama somewhere else — another container, another box. |
| `KVITTO_LLM_MODEL` | `qwen3-vl:4b` | A larger model if you have the memory. |
| `KVITTO_LLM_MANAGE_PROCESS` | `true` | `0` when something else owns the Ollama lifecycle (systemd, Docker, the Mac app). |
| `KVITTO_LLM_AUTO_PULL` | `false` | `1` to download the model on first use instead of on request. |
| `KVITTO_LLM_INTERVAL_SECONDS` | `60` | How often to look for work. The interval lengthens automatically while the queue is empty. |
| `KVITTO_LLM_BATCH_SIZE` | `4` | Receipts per pass. |
| `KVITTO_LLM_TIMEOUT_MS` | `300000` | Per-receipt deadline. CPU inference on a big receipt is slow. |
| `KVITTO_LLM_MAX_ATTEMPTS` | `3` | Attempts before a receipt is parked as failed. |

### What it is allowed to change

A background writer is not a peer of the person holding the phone, so it does
not play by last-write-wins:

- **A receipt marked confirmed is never touched.** A human accepted it; that
  closes it.
- **Blank fields are filled; filled ones are left alone**, whoever filled them.
- **Line items are all-or-nothing.** A receipt that already has lines keeps
  them, because half-merging a model's list into a hand-edited one produces
  duplicates that are worse than no extraction at all.
- **An organisation number the device verified outranks the model's reading of
  the same pixels** — it passed a Luhn checksum and a registry lookup, and the
  model did not.

The reverse case is handled on the device: an extraction that lands after an
edit the server never saw is merged field by field, with the human's value
winning, rather than replacing the record because its timestamp is newer.

Results are **not** delivered on a channel of their own. The server writes them
with an ordinary revision, so every device collects them on the pull it was
going to make anyway.

## Security model

Single account, many devices. There is no signup, no password and no reset
flow, because there is nothing to sign up to — the server belongs to one
household.

- **Device tokens** are 32 bytes of CSPRNG output. Only their SHA-256 is
  stored, so a leaked database hands out no working credentials.
- **Synchronized API keys** are encrypted with AES-256-GCM before entering
  SQLite. Every paired device can receive them by design; revoke devices that
  should no longer have access.
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

All endpoints except `/health`, `/auth/pair`, and the local dashboard bootstrap
require `Authorization: Bearer <device token>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness, protocol version, whether the AI proxy is on. |
| `POST` | `/auth/dashboard` | Establish a server-dashboard session from localhost. |
| `POST` | `/auth/pairing-code` | Mint a one-time pairing code. |
| `POST` | `/auth/pair` | Exchange a pairing code for a device token. |
| `GET` | `/auth/me` | Who this token belongs to, and proxy capabilities. |
| `GET` | `/auth/devices` | List the account's devices. |
| `DELETE` | `/auth/devices/:id` | Revoke another device. |
| `GET` | `/server/config` | Read effective server AI settings without secret values. |
| `PUT` | `/server/config` | Update persistent server AI settings. |
| `GET` | `/debug/logs?limit=N` | Read up to 500 recent redacted HTTP exchanges, including request and response bodies. |
| `DELETE` | `/debug/logs` | Clear the server request log. |
| `GET` | `/secrets` | List whether each supported API key is configured. Values are never returned here. |
| `PUT` | `/secrets/:id` | Set or clear an API key from the server dashboard. |
| `POST` | `/sync/push` | Upload changed records. |
| `GET` | `/sync/pull?since=N` | Download everything with `rev > N`. |
| `GET` | `/sync/status?since=N` | **The cheap probe.** Current revision, the history's epoch, and how many records are waiting — with no payload. Add `&counts=1` for full row counts. |
| `POST` | `/blobs/status` | Which of these digests do you already have? |
| `PUT` | `/blobs/:sha256` | Upload an image. |
| `GET` | `/blobs/:sha256` | Download an image. |
| `POST` | `/ai/parse` | Extract a receipt from an uploaded image. |
| `GET` | `/llm/status` | Local model state, queue depth, recent failures. |
| `POST` | `/llm/start` | Bring the runtime up now. |
| `POST` | `/llm/pull` | Start downloading the model; watch `/llm/status` for progress. |
| `POST` | `/llm/scan` | Run a pass over the queue immediately. |
| `POST` | `/llm/requeue` | Requeue one receipt, or every parked one. |

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

`GET /sync/status?since=N` answers "is there anything for me?" without sending
any records, so an idle device's five-minute heartbeat costs a few hundred bytes
instead of a page of data it already has.

Every sync response also carries an **epoch** identifying this server's revision
history. Revision numbers only mean anything within one history: restore the
database from a backup, move it to a new volume, or point the same hostname at a
fresh instance, and the counter restarts while every device still holds a cursor
from before. Each of them would then ask for `rev > 400` of a history that has
reached 12, be told nothing has changed, and quietly stop syncing forever. A
changed epoch — or a cursor above the server's own counter, which `/sync/status`
reports as `diverged` — tells the client to reset to zero and reconcile from
scratch. Nothing is lost: a full pull merges rather than replaces.

Clients retry a failed request three times with exponential backoff and full
jitter, honouring `Retry-After` when the server sends one. After five
consecutive failed passes a circuit breaker pauses the automatic schedule and
backs off up to thirty minutes, so a phone that has lost its server does not
spend its battery rediscovering that every five minutes. Reconnecting, changing
the server address, or pressing "Synka nu" all bypass the breaker.

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
