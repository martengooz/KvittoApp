# KvittoApp

An offline-first PWA for scanning, reading and searching receipts — tuned for
Swedish ones — with an optional companion server for syncing between devices.

Point the camera at a receipt. OpenCV finds the paper, deskews it and flattens
out the shadows; an AI model of your choosing reads the merchant, date, totals,
VAT table and every line item; everything lands in IndexedDB on the device. The
app works with no network at all. When a server is configured, it syncs in the
background — and if it never is, nothing is lost.

```
packages/shared   Domain model, sync contracts, Swedish parsers, extraction prompt
apps/web          The PWA (vanilla TypeScript + Vite)
apps/server       Companion sync server (Fastify + SQLite)
fixtures/receipts Real receipt photographs used by the verification harness
```

## Quick start

```bash
npm install
npm run build --workspace @kvitto/shared   # the other workspaces import its types
npm run dev --workspace @kvitto/web        # http://localhost:5173
```

The app is fully usable at this point: scan receipts, edit them by hand, search
your purchases. Two things are optional and independent of each other — AI
reading, and syncing.

### Turn on AI reading

Settings → AI-tolkning. Pick one of:

| Provider | Where the API key lives | Notes |
|---|---|---|
| **Anthropic** | On the device | Uses the official SDK, loaded only if you pick this provider. |
| **OpenAI** | On the device | |
| **OpenAI-compatible** | On the device | OpenRouter, Groq, LM Studio, vLLM — anything speaking `/chat/completions`. |
| **Ollama** | Nowhere | Fully local. Start Ollama with `OLLAMA_ORIGINS="http://localhost:5173"`. |
| **Via my own server** | On the server | The phone never holds a key. Needs the companion server. |

"Testa anslutningen" verifies the credentials and tells you whether the model
you named actually exists, rather than letting you find out on your next scan.

### Turn on syncing

```bash
npm run dev --workspace @kvitto/server   # http://localhost:8787
npm run pair --workspace @kvitto/server  # prints a one-time pairing code
```

Then in the app: Settings → Synkronisering, enter the server address and the
code. See [`apps/server/README.md`](apps/server/README.md) for deployment.

## How it works

### The image pipeline

This is where most of the quality comes from, and it runs entirely on-device in
a Web Worker. OpenCV (~11 MB) is fetched on first use from a stable URL and
cached by the service worker, so it costs nothing until the first scan and
works offline forever after. If it cannot load at all, a canvas-only fallback
still produces a usable scan — scanning never hard-fails.

1. **Find the paper.** Three strategies, tried in order of how much they know
   about receipts:
   - *Paper mask* — bright **and** unsaturated. Plain brightness segmentation
     happily swallows the hand holding the receipt; skin and wood carry
     saturation that thermal paper does not, so intersecting the two isolates
     the paper itself. This is what fires on almost every real photo.
   - *Auto-Canny contours* — a morphological close first erases the print so
     the only strong edge left is the outline of the receipt, with Canny
     thresholds derived from the image's own median so a dim shop and a sunlit
     table both work.
   - *Otsu* — last resort, for a white receipt on a white table.

   The outline is reduced to four corners via the **convex hull** (a creased,
   dog-eared receipt with a thumb over one edge is full of concave notches that
   would otherwise stop it ever reducing to four points), and any candidate
   quadrilateral that does not contain all the detected paper is rejected —
   Douglas–Peucker minimises vertex count, not area, and will happily cut a
   chord across a bulge and slice the price column off the side. The accepted
   outline is then grown 4 %: cropping slightly wide costs nothing, cropping
   slightly tight loses data permanently.

2. **Deskew** with a four-point perspective transform, sized from the longest
   opposing edges so a receipt shot at an angle is not squashed.

3. **Flatten the illumination** by dividing the image by a blurred estimate of
   its own background. This is the single biggest win for phone photos — it
   turns a receipt with your shadow across one corner into an evenly lit page.
   The estimate is computed on a 256 px copy, which is visually identical
   (illumination is low-frequency by definition) and ~450× faster: measured at
   16 ms against 7.1 s for the full-resolution equivalent.

4. **CLAHE + unsharp mask**, then downscale to 1568 px on the long edge.

The output is deliberately **not** binarised by default. Hard thresholding
looks crisp to a human but throws away the faint, half-printed characters
thermal receipts are full of, and vision models read those better from
grayscale with its anti-aliasing intact. Black-and-white is available as an
option.

Every stage is adjustable in Settings, and the review screen has a
drag-the-corners editor for the photos where detection gets it wrong.

### Reading the receipt

The model is asked to **transcribe, not calculate**: every amount comes back as
a string exactly as printed (`"1 234,50"`, `"25,00-"`), and the app parses it
with a Swedish number parser that understands decimal commas, thousands
spaces, the `:-` suffix and the trailing minus sign cash registers print for a
credit. Asking a model to also do locale conversion is where silent off-by-100
errors come from.

The prompt is built around what actually goes wrong on Swedish receipts: `Pant`
and `Rabatt` rows being folded into the product above, the `Moms` summary table
being mistaken for line items, `Öresavrundning`, and `Att betala` versus
`Totalt`. Structured output (JSON Schema) is used where the provider supports
it, with automatic fallback to prompt-only JSON where it does not.

Everything the model produces is then checked for arithmetic consistency — do
the lines add up to the total, does the VAT table agree — and anything
suspicious is surfaced as a "worth checking" prompt rather than silently
trusted. Every field is editable.

### Storage and sync

All data lives in IndexedDB. Images are content-addressed by SHA-256, so the
same photo is stored once no matter how many receipts point at it.

Sync is last-write-wins on a client timestamp, with both sides running the
*same* conflict resolution function so they converge without a round-trip.
Deletes are tombstones, so a delete made offline still propagates. Metadata
syncs before images, so a slow connection delays photos rather than the data
that makes the app useful.

## Verification

```bash
# Against the production bundle, driving the UI as a user would
npm run build --workspace @kvitto/web
npx vite preview --port 4179 --host 127.0.0.1   # in apps/web
npm run verify --workspace @kvitto/web

# Against the dev server: pushes every fixture receipt through the real
# pipeline and writes the processed images to apps/web/e2e/output/
npm run dev --workspace @kvitto/web
npm run verify:pipeline --workspace @kvitto/web
```

The pipeline sweep reports which detection strategy fired, its confidence and
the timing per receipt, and **fails if the pipeline quietly degrades to the
canvas fallback** — which is how the four real bugs found during development
were caught.

Unit tests cover the Swedish parsers, extraction normalisation and validation
(`npm test --workspace @kvitto/shared`), and the server's auth, sync,
conflict-resolution and blob handling (`npm test --workspace @kvitto/server`).

```bash
npm run typecheck   # all workspaces
npm test            # all workspaces
npm run build       # all workspaces
```

Chromium is required for `verify`. Either `npx playwright install chromium` or
set `CHROMIUM_PATH` to an existing Chrome binary.

## Notes and limitations

- **Camera access needs a secure context.** `localhost` counts; testing on a
  phone over the LAN does not, so use `vite --https` or a tunnel. Where
  `getUserMedia` is unavailable or denied, the app silently falls back to a
  file input with `capture="environment"`, which opens the native camera on
  every mobile browser — the scan button always does something.
- **Detection is good, not perfect.** On the hand-held, crumpled receipts in
  `fixtures/` it finds the paper in all nine, but a receipt curled in the hand
  is genuinely not a quadrilateral. The review screen flags low confidence and
  offers manual corners.
- **An on-device API key is visible to anyone with the device.** That is stated
  in Settings. The `server` provider exists for people who would rather not.
- **Swedish first.** The parsers and prompt are tuned for Swedish receipts;
  English and other Nordic ones work, but are less thoroughly exercised.

## Licence

MIT
