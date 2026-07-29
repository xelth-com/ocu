# OCU — an API for the OPAL courier portal

**OCU** ("OPAL Courier Unified") is a clean, versioned REST API in front of the
OPAL courier portal ([opal-kurier.de](https://opal-kurier.de)), which today has
no API of its own.

It is built around one idea: a **swappable backend driver** behind a fixed REST
contract.

- **Today** the `scraper` driver drives the OPAL web portal with a headless
  browser (Playwright). It is a faithful port of a scraper we already run in
  production against the live portal, every day.
- **Tomorrow** a `db` driver talks directly to OPAL's own database.

Switching drivers **does not change the API**. Consumers integrate once against
`/v1/...`; the backend can be upgraded from "headless browser" to "native SQL"
underneath them with zero client changes. That separation is the whole pitch —
and it doubles as a proposal to OPAL: *here is your missing API, already
battle-tested by a real customer; plug it into your database and it becomes
first-class.*

---

## Why Fastify (and not Express)?

Fastify was chosen over Express for three concrete reasons:

1. **First-class async/await error flow.** Route handlers are `async`; a thrown
   `ApiError` is rendered by one central error handler into the
   `{ error: { code, message } }` envelope. No `next(err)` plumbing.
2. **Testability without a live server.** `app.inject()` exercises the full
   routing/auth/error stack in-process — the entire HTTP contract is unit-tested
   with a fake driver and **no live portal**.
3. **Encapsulated plugin scopes.** The authenticated routes live in a registered
   scope with a single `onRequest` auth hook, while `/v1/health` stays public —
   cleanly, without per-route guards.

---

## API contract (v1)

Auth: every endpoint except `/v1/health` requires `Authorization: Bearer <key>`.
Valid keys come from the `OCU_API_KEYS` env var (comma-separated). See
[`openapi.yaml`](./openapi.yaml) for the full contract and the complete
`Shipment` schema with per-field descriptions.

| Method & path | Description |
| --- | --- |
| `GET /v1/health` | Liveness + `{ driver, version }` (unauthenticated). |
| `GET /v1/shipments?limit=50&cursor=<opaque>` | List shipments, newest first. `limit` default 50, max 200. Returns `{ shipments, next_cursor }`. |
| `GET /v1/shipments/{ocu_number}` | One shipment, or 404. |
| `POST /v1/shipments` | Create a shipment; returns `201` with the created `Shipment`. |
| `GET /v1/shipments/{ocu_number}/documents/{type}` | Retrieve a document PDF (`type` ∈ `label`, `order`, `confirmation`). |
| `GET /v1/shipments/{ocu_number}/label` | Convenience alias for `documents/label`. |

**Errors** are always `{ "error": { "code", "message" } }` with the matching
HTTP status. Driver failures (portal down, login failed, layout changed) map to
`502` with code `upstream_portal_error`.

---

## Quickstart

### Requirements
- Node.js 20+
- For the `scraper` driver: Chromium via Playwright
  (`npx playwright install chromium`), or just use Docker (below).

### Local
```bash
cp .env.example .env      # then edit .env with your keys + portal credentials
npm install
npm run build
npm start                 # listens on :38300 by default
```

Development with hot reload:
```bash
npm run dev
```

### Docker
The image is based on the official Playwright image, so Chromium and its system
libraries are already present.
```bash
cp .env.example .env      # fill in OCU_API_KEYS, OPAL_USERNAME, OPAL_PASSWORD
docker compose up --build
```

### Configuration (environment)

| Variable | Default | Description |
| --- | --- | --- |
| `OCU_API_KEYS` | — | **Required.** Comma-separated list of accepted API keys. |
| `DRIVER` | `scraper` | Backend driver: `scraper` or `db`. |
| `PORT` | `38300` | HTTP listen port. |
| `OPAL_URL` | `https://opal-kurier.de` | Portal base URL (scraper driver). |
| `OPAL_USERNAME` | — | Portal login (scraper driver). |
| `OPAL_PASSWORD` | — | Portal password (scraper driver). |
| `OPAL_USER_DATA_DIR` | `.browser-data` | Playwright persistent profile dir. |
| `OPAL_MANDANT` | — | Optional account "ma" id; only needed to fetch documents by a raw internal orderval. |
| `OPAL_CLIENT` | — | Optional account "cl" id; pairs with `OPAL_MANDANT`. |

Never commit `.env`. Configuration is strictly via environment.

---

## API examples

```bash
KEY="your-api-key"

# Health (no auth)
curl -s http://localhost:38300/v1/health
# {"ok":true,"service":"ocu-api","driver":"scraper","version":"1.0.0"}

# List the 10 most recent shipments
curl -s -H "Authorization: Bearer $KEY" \
  "http://localhost:38300/v1/shipments?limit=10"

# Follow the cursor for the next page
curl -s -H "Authorization: Bearer $KEY" \
  "http://localhost:38300/v1/shipments?limit=10&cursor=<next_cursor>"

# One shipment by its ocu_number
curl -s -H "Authorization: Bearer $KEY" \
  "http://localhost:38300/v1/shipments/OCU-123456"

# Create a shipment
curl -s -X POST -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "sender_address":   {"name1":"Sender GmbH","street":"Hauptstr","house_number":"1","zip":"10115","city":"Berlin"},
        "receiver_address": {"name1":"Receiver AG","street":"Nebenstr","house_number":"2","zip":"80331","city":"München"},
        "weight": 2.5,
        "ref_number": "REF-123"
      }' \
  http://localhost:38300/v1/shipments
```

### Documents (PDF)

Each shipment can produce a PDF: its **label** (Versandlabel), the **order**
printout, or the **confirmation** (Auftragsbestätigung).

```bash
# Fetch the label as a PDF (inline) and save it
curl -s -H "Authorization: Bearer $KEY" \
  "http://localhost:38300/v1/shipments/OCU-123456/label" \
  -o label.pdf

# Same, via the generic endpoint (type ∈ label | order | confirmation)
curl -s -H "Authorization: Bearer $KEY" \
  "http://localhost:38300/v1/shipments/OCU-123456/documents/confirmation" \
  -o confirmation.pdf
```

The response is `Content-Type: application/pdf` with
`Content-Disposition: inline; filename="OCU-123456-label.pdf"`. Unknown shipment
→ `404`; portal failure → `502 upstream_portal_error`.

**This path runs over plain HTTP — no headless browser.** The `scraper` driver
logs in and walks the portal's three-hop print chain (cookie-authenticated GETs
only) with Node's built-in `fetch` and a small cookie jar. It is concrete
evidence that the driver layer can shrink toward pure HTTP as more of the portal
is reverse-engineered — exactly the migration path toward the native `db`
driver. (Resolving an `ocu_number` to its internal order id still uses the
scraper today; fetching by a raw internal orderval is fully browser-free.)

```
HTTP (Fastify)  →  auth (Bearer)  →  route  →  OcuSource driver
                                                 ├── ScraperSource  (Playwright → OPAL portal)   [today]
                                                 └── DbSource       (SQL → OPAL database)         [intended production]
```

The one interface everything hangs on is
[`OcuSource`](./src/drivers/types.ts):

```ts
interface OcuSource {
  listShipments(limit: number, cursor?: string): Promise<ListResult>;
  getShipment(id: string): Promise<Shipment | null>;
  createShipment(input: CreateShipmentInput): Promise<Shipment>;
  getDocument(id: string, type: DocumentType): Promise<DocumentResult>;
  health(): Promise<HealthResult>;
}
```

| Path | Purpose |
| --- | --- |
| `openapi.yaml` | The full OpenAPI 3.1 contract + `Shipment` schema. |
| `src/server.ts` | Fastify app, routes, error envelope. |
| `src/auth.ts` | Bearer-key auth (hook + pure helpers). |
| `src/cursor.ts` | Opaque cursor + `limit` validation. |
| `src/drivers/types.ts` | The `OcuSource` interface + `Shipment` types. |
| `src/drivers/scraper.ts` | The Playwright port (today's backend). |
| `src/drivers/opal-parse.ts` | Detail-page parser (`parseOpalDetail`), ported verbatim. |
| `src/drivers/db.ts` | Honest stub for the native DB driver, with a SQL mapping sketch. |

### A note on the current backend (be honest)

The current backend is a **headless-browser adapter**: it logs into the OPAL
portal and reads/writes through the same forms and pages a human would. It is
robust enough to run in production, but it inherits the portal's quirks — it is
slower than a database and sensitive to portal layout changes (which surface
cleanly as `502 upstream_portal_error`). The **native `db` driver is the
intended production mode**; it is stubbed here (interface-complete, throws "not
implemented") with an inline SQL mapping for OPAL to fill in. When it lands, the
REST contract above stays byte-for-byte identical.

---

## Scripts

| Script | Action |
| --- | --- |
| `npm run dev` | Run with hot reload (tsx). |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm start` | Run the compiled server. |
| `npm run typecheck` | Type-check without emitting. |
| `npm test` | Run the test suite (vitest). |

Tests cover the parts that do **not** need a live portal: auth middleware,
cursor/limit validation, driver selection, and the error envelope (via
`app.inject()` with a fake driver).

---

## Warum dieses Projekt? (für OPAL)

**OCU ist die REST-API, die dem OPAL-Portal bislang fehlt.**

Wir (xelth) nutzen OPAL täglich und haben unsere bewährte Portal-Automatisierung
zu einer sauberen, versionierten REST-API verpackt. Der Clou ist ein
**austauschbarer Backend-Treiber** hinter einem festen API-Vertrag:

- **Heute:** Treiber `scraper` — ein Headless-Browser (Playwright), der das
  Portal bedient. Bereits im echten Kundeneinsatz erprobt.
- **Morgen:** Treiber `db` — direkter Zugriff auf die OPAL-Datenbank.

**Der API-Vertrag ändert sich beim Treiberwechsel nicht.** Sie erhalten also
eine sofort einsatzbereite API und können sie später — ohne dass Ihre Nutzer
etwas umstellen müssen — direkt an Ihre Datenbank anbinden. Aus dem
Browser-Adapter wird ein nativer Datenbank-Treiber; die Endpunkte, das
`Shipment`-Schema und die Fehlerstruktur bleiben identisch.

Der Vertrag ist vollständig in [`openapi.yaml`](./openapi.yaml) dokumentiert.
Der Platzhalter für den Datenbank-Treiber inklusive SQL-Mapping-Skizze liegt in
[`src/drivers/db.ts`](./src/drivers/db.ts) — genau die Stelle, die OPAL
ausfüllen würde.
