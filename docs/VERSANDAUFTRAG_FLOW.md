# OPAL Versandauftrag — Create + PDF Retrieval Flow

Live recon of the OPAL courier portal (`opal-kurier.de`) performed 2026-07-29 against the
production `<OPAL_USERNAME>` account, to specify two capabilities OCU must gain next:

1. **Create a Versandauftrag** programmatically (`POST /v1/shipments` → real order).
2. **Retrieve the resulting PDF** (waybill/label) back.

No order was submitted during this recon. All findings below were gathered by inspecting
the live DOM/JS and by *read-only* GETs of an existing order's print endpoints.

Credentials live in `9eck.com/config.env` as `OPAL_USERNAME` / `OPAL_PASSWORD`
(referred to here as `<OPAL_USERNAME>` / `<OPAL_PASSWORD>`; never inline them).
Account-scoped constants for `<OPAL_USERNAME>`: **mandant `ma=603`**, **client `cl=60952`**
(these appear in the login graphics `FL_603.gif` / `CL_603_60952.gif` and in every
`PrintDocs(...)` call — they are the account's fixed ids, not secrets).

---

## A. Login + session mechanics (HTTP level)

The public landing page is a WordPress site; the login widget is **not** a normal form
POST. `<form action="javascript:" onsubmit="return opal_submit_form()">` carries a hidden
`fn=login` plus `username` / `password`. `opal_submit_form()` is a 3-line jQuery call:

```js
// jQuery('#opal-login-result').load('ssl-load-opal.php', f.serializeArray())
```

i.e. it AJAX-POSTs the serialized login form to `ssl-load-opal.php` and injects the
response. Observed request sequence (captured via network log):

| # | Method | URL | Notes |
|---|--------|-----|-------|
| 1 | POST | `/ssl-load-opal.php` | body: `fn=login&username=<OPAL_USERNAME>&password=<OPAL_PASSWORD>` (url-encoded) |
| 2 | GET | `/ssl-load-opal.php?fn=success&id=44455&sid=LE-<token>` | session handshake; `id`=user id (44455), `sid`=`LE-<opaque>` app token |
| 3 | GET | `/op_start.php` | the frameset (the real portal shell) |

**Session carrier: a server-set session cookie.** After step 2, every subsequent request
(`op_start.php`, all `/main/*.php`, and the PDF endpoints below) succeeds with
`credentials:'include'` and **no `sid` in the URL** — proving the session rides a cookie,
not the URL. (Cookie *name* not captured: the browser tool blocks `document.cookie`; it is
a standard PHP session cookie — assume `PHPSESSID` unless the login `Set-Cookie` says
otherwise. Confirm the exact `Set-Cookie` name when implementing with a raw HTTP client.)
The `sid=LE-...` token is used only in the handshake redirect; it was not needed on any
later request.

**No CSRF token anywhere** in the login form or the order form (see B) — good for a plain
HTTP client, but note it as a portal weakness.

### Frameset (`/op_start.php`)
Same-origin frames. The two the drivers care about (names match the existing scraper):

- `optop` → `/main/op_header.php` — the menu.
- `opmain` → `/main/op_welcome.php` — the content pane (where forms/lists render).
- others: `opsysaction`, `opfunc`, `ophide` (`/sys/op_js_funcs.php` — hosts shared JS
  like `PrintDocs`, `ResetOrder`), `opmaintop`, `opfuss`, `opsound`.

### Menu (`optop`)
| Label | href (relative to `/main/`) | Purpose |
|-------|------|---------|
| Neuer Auftrag | `op_master_select.php` → forwards to `op_auftrag.php` | **create order** |
| Auftragsliste | `op_scr_auftraglist.php` → `op_auftraglist.php` | order list |
| Adressbuch | `op_scr_adresslist.php` | address book |
| Tagesliste | `op_scr_tageslist.php` | day list |
| Mein OP@L | `op_my_opal.php` | account |
| Abmelden | `../sys/logout.php` | logout |

---

## B. Create form — `/main/op_auftrag.php`

"Neuer Auftrag" → `op_master_select.php`, which **JS-forwards to `/main/op_auftrag.php`**.
Hitting `op_master_select.php` is what initializes a fresh order session (empty address
rows, computed hidden defaults). A plain-HTTP client MUST fetch it first to obtain the
form's 133 server-populated hidden fields before POSTing.

Form: **`<form name="OPORDER" method="post">`**, action = self (`op_auftrag.php`).
257 total controls — but ~133 are hidden computed/limit fields and ~a dozen are `list[...]`
filter noise carried from the list screen. The order-bearing fields:

### Addresses (array fields, one entry per address row)
`count_min_addresses = count_max_addresses = 2` → **exactly two address rows are required:
row 0 = pickup (Abholung), row 1 = delivery (Zustellung).** (The DOM shows 3 copies of each
`address_*[]`; the 3rd is a hidden JS *template* row — ignore it. The existing scraper's
index-0/index-1 fill is therefore correct.)

| Field name | Type | Label | Notes |
|------------|------|-------|-------|
| `address_type[]` | select | (row type) | `1`=Abholung, `2`=Zustellung, `3`=Abh.+Zust. Set row0=`1`, row1=`2`. |
| `address_name1[]` | text | Name1 | primary name **(required)** |
| `address_name2[]` | text | Name2 | |
| `address_name3[]` | text | (Ansprechpartner/Name3) | |
| `address_str[]` | text | Straße | street name |
| `address_hsnr[]` | text | Hausnr | house number (portal has a **separate** field — the scraper wrongly concatenates street+house into `address_str[]`; see gap below) |
| `address_lkz[]` | text | LKZ | country code (e.g. `DE`) |
| `address_plz[]` | text | PLZ | postal code **(required)** |
| `address_ort[]` | text | Ort | city **(required)** |
| `address_number[]` | text | (address-book id) | hidden linkage to Adressbuch entry |
| `address_save[]` | checkbox×3/row | Adressbuch speichern (nein/ja/neu) | leave default "nein" |
| `address_lkz_region[]` | select | region | usually empty |
| plus per-row phone/email/Tag(date)/Zeit(time von–bis)/Hinweis text fields |

### Shipment options (`Sendungsoptionen`)
| Field | Type | Label | Options (value=label) |
|-------|------|-------|-----------------------|
| `seordertype` | **select, REQUIRED** | Auftragsart | `2001`=Overnight, `2004`=International, `2007`=Direktfahrt, `2003`=German Letter, `2009`=X-Change/Swap, `8`=OV Pickup National |
| `sefztype` | select | Fahrzeug | `SEL`=(bitte wählen), `3`=PKW, `5`=CADDY, `4`=BUS, `1`=Bike, `2`=Lasten-Rad |
| `segewicht` | text | Gewicht (kg) | weight; portal expects **German decimal** `1,0` (comma) |
| `seclref` | text | Referenz | customer reference |
| `sewert` | text | Wert | declared value |
| `sewertcu` | select | Wert-Währung | `1`=EUR (default), 4=CHF, 2=USD, 6=GBP, 5=CND, 7=CNY, 3=YEN |
| `so_<id>` | checkbox | service options | account-specific option ids (e.g. `so_278`, `so_279`, `so_84837`) — leave default |
| `nnww`/`nnfw`/`nnwwc`/`nnfwc`/`nnpay` | text/select | Nachnahme (COD) | optional |
| `freight_load_and_count`, `freight_packing_list_enclosed`, `booking_confirmation_number` | | freight extras | optional |

`MustFields` (hidden) = bitmask `"100111001101100000"` — the portal's own client-side
required-field map (18 bits). Drives JS validation; not required to replicate server-side,
but the server re-validates on save.

### Form action / method — **the real submit is NOT a plain form POST**
The `OPORDER` form contains **no submit button**. Two links drive it (in `opmain`):

- **"AGB akzeptieren und Auftrag erteilen"** → `onclick="OrderSave()"` — **this creates the
  order. DO NOT trigger it in recon.**
- "Zurücksetzen" → `window.parent.ophide.ResetOrder()`.

`OrderSave()` (defined in `opmain`) is a Prototype.js call:

```js
// new Ajax.Updater(<target>, '../subs/op_order_save.php',
//                  { parameters: $('OPORDER').serialize(), ... })
```

**→ Create endpoint: `POST /subs/op_order_save.php`, body = the fully serialized OPORDER
form.** The response HTML is injected into the page and carries the confirmation (the new
`SendungsNr`, matched by the scraper as `Sendungsnummer[:\s]*([A-Z0-9-]+)` — note the real
list shows numbers like `OCU-998-520133`).

> ⚠️ **The existing scraper create flow (`ScraperSource.createShipment`) is incomplete and
> almost certainly does not create valid orders:**
> 1. it never selects `seordertype` (a REQUIRED field);
> 2. it never sets `address_type[]`;
> 3. it clicks the first `input[type=submit]` ("OK", an **address-book** sub-dialog button)
>    instead of invoking `OrderSave()`;
> 4. it concatenates street+house into `address_str[]` although the portal has a distinct
>    `address_hsnr[]`.
> The create path must be rewritten around `OrderSave()` / `op_order_save.php`.

---

## C. PDF retrieval (verified read-only on existing order `OCU-998-520133`, orderval `17032005`)

### Where the ids come from
Open a row in `op_auftraglist.php` (row `onclick` = `ophide.ZeilenLinkAct3('/main/op_auftraglist.php?...&orderval=<id>&...')`).
The **detail page** exposes three print links, each calling `ophide.PrintDocs(...)`:

| Link label | `PrintDocs(type, ma, cl, ref, field)` |
|------------|----------------------------------------|
| Auftrag drucken | `PrintDocs('order','603','60952','17032005','KEY')` |
| **Versandlabel** (the waybill/label) | `PrintDocs('hwb','603','60952','17032005','KEY')` |
| Auftragsbestätigung | `PrintDocs('ab','603','60952','17032005','KEY')` |

Args: `type` ∈ {`order`,`hwb`,`ab`}; `ma`=mandant (603); `cl`=client (60952);
`ref`=**internal orderval** (`17032005`, NOT the `OCU-...` tracking number); `field`=literal
`'KEY'`. `PrintDocs` (in `ophide`) simply does
`window.open('../main/op_print_docs.php?type=&ma=&cl=&ref=&field=')`.

### The 3-hop PDF chain (all GET, cookie-auth only — confirmed status 200 each)
1. `GET /main/op_print_docs.php?type=hwb&ma=603&cl=60952&ref=<orderval>&field=KEY`
   → **HTML** wrapper (~3.2 KB). Its inline script does `location = op_print_labels.php?format=A4&ids=<...>`.
2. `GET /main/op_print_labels.php?format=A4&ids=<id>`
   → **HTML** (~112 B). Server generates the PDF on the fly and the page references a temp
   file: `../print/tmpprint/<YYYYMMDD-HHMMSS-ma-cl>.pdf`
   (observed: `20260729-132419-603-60952.pdf`).
3. `GET /print/tmpprint/<YYYYMMDD-HHMMSS-ma-cl>.pdf`
   → **the actual PDF** — `Content-Type: application/pdf`, ~181 KB, `%PDF` magic verified.

So a client cannot guess the final URL: it must **follow hops 1→2→3**, scraping the
`op_print_labels.php` URL out of hop 1's script and the `tmpprint/*.pdf` path out of hop 2's
script. All three requests need only the session cookie. `type=order` and `type=ab` follow
the same wrapper pattern (untested end-to-end but structurally identical).

### Create-confirmation PDF (inferred, OPEN)
Could not verify without creating an order. The confirmation returned by `op_order_save.php`
most likely surfaces the same `PrintDocs('hwb', ma, cl, <new orderval>, 'KEY')` affordance,
so the label is retrievable immediately after create using the new orderval. **Confirm on
the first real create.**

---

## D. Plain-HTTP feasibility verdict

**PDF retrieval: YES — trivially. Drop the browser for this path.** A cookie jar +
three sequential GETs (following the two script-embedded URLs) returns the PDF bytes. No JS
engine needed — the URLs to follow are plain strings inside the returned HTML
(`op_print_labels\.php\?\S+` then `\.\./print/tmpprint/\S+\.pdf`). Inputs required:
`ma`,`cl` (account constants) + `ref`=orderval (per shipment) + `type` + `field=KEY`.

**Create: FEASIBLE but fragile — recommend keeping the browser driver initially.** Path:
`POST /ssl-load-opal.php` (login, capture cookie) → `GET /main/op_master_select.php` (get a
fresh OPORDER with its 133 hidden fields) → build a POST body = *all* returned hidden fields
overlaid with the address/type/weight/ref values → `POST /subs/op_order_save.php` → parse
`SendungsNr` from the HTML. No CSRF blocks it. Fragile parts:
- Must faithfully replay 133 server-computed hidden fields (`help*`, `mtc*`, timing/limit
  constraints, `MustFields`, `DUO`/`CAS`, address-count guards). Miss one the server-side
  validator wants and the save is rejected.
- `so_<id>` service-option ids and the `seordertype` value list are **account-specific** —
  hardcoding them will break for another OPAL account.
- German decimal formatting (`segewicht` = `1,0`).
- Session cookie name must be read from the real `Set-Cookie` (tool couldn't).

### Recommended architecture
- **Now:** implement PDF retrieval as a **cookie-jar HTTP path in the `scraper` driver**
  (no Playwright) — fast, cheap, robust. Reuse the browser only for the login if a raw HTTP
  login proves finicky, but login is a clean POST so raw HTTP should work.
- **Create:** rewrite the browser flow around `OrderSave()` (select `seordertype` +
  `address_type[]`, split house number, click "AGB akzeptieren und Auftrag erteilen").
  A raw-HTTP create can follow later once the hidden-field replay is proven against a real
  save. Either way, the driver must **also capture `orderval` + `ma` + `cl`** (from the
  detail page's `PrintDocs(...)` call, or `orderval` from the list-row `onclick`) so PDF
  retrieval has its inputs.

### Schema/contract impact for OCU
- `Shipment` needs three new machine ids to make PDFs addressable:
  `orderval` (internal order id, e.g. `17032005`), `ma` (`603`), `cl` (`60952`).
  The current parser extracts none of them.
- New capability surface (suggested): `GET /v1/shipments/{ocu_number}/label` (and maybe
  `.../document?type=order|hwb|ab`) returning `application/pdf`. Driver method e.g.
  `getDocument(id, type): Promise<{contentType, bytes}>` on `OcuSource`.

---

## Open questions
1. Exact **session cookie name** (`Set-Cookie` from `/ssl-load-opal.php`) — read with a raw
   HTTP client; the browser tool blocked `document.cookie`.
2. Does the **create confirmation** expose the label immediately (new orderval)? Verify on
   first real create.
3. Mapping of the **`MustFields` bitmask** to concrete fields, and whether the server
   rejects a save missing any of the 133 hidden fields — determines raw-HTTP create effort.
4. `field=KEY` semantics — literal constant in all three `PrintDocs` calls; confirm it is
   not a per-session key.
5. `/print/tmpprint/*.pdf` lifetime — are temp PDFs short-lived (must be fetched right after
   generation) or persistent? Affects whether OCU must stream hop-3 immediately.
6. `type=order` / `type=ab` end-to-end (only `type=hwb` was fully walked to a PDF).
