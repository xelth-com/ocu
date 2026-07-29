/**
 * The stable data contract shared by every backend driver.
 *
 * The `Shipment` shape is derived directly from what the existing production
 * scraper extracts (see `parseOpalDetail` in the original scraper) — no field
 * was invented. The only addition is `ocu_number`, a canonical alias for the
 * portal's "SendungsNr" (which the scraper stores in `tracking_number`); it
 * exists so the REST path `/v1/shipments/{ocu_number}` has a stable key.
 */

export interface Shipment {
  // ── Identity ──────────────────────────────────────────────────────────────
  /** Canonical OPAL shipment number ("SendungsNr", e.g. "OCU-123456"). Alias of
   *  `tracking_number`; used as the resource id in the REST path. */
  ocu_number: string;
  /** SendungsNr exactly as the portal emits it (regex OCU[-\d]+). */
  tracking_number: string;
  /** House waybill number ("HWB"): a 12-digit code or an OCU-prefixed code. */
  hwb_number: string;
  /** Order type ("Auftragsart"). */
  product_type: string;
  /** Customer reference ("Referenz"). */
  reference: string;
  /** Creation timestamp ("erfasst am … Uhr"), portal-formatted string. */
  created_at: string;
  /** Creating user ("erfasst durch"). */
  created_by: string;

  // ── Pickup ("Abholung") ─────────────────────────────────────────────────────
  pickup_name: string;
  pickup_name2: string;
  /** Contact person ("Ansprechpartner"). */
  pickup_contact: string;
  /** Phone ("Telefon"). */
  pickup_phone: string;
  /** Email ("Mail"). */
  pickup_email: string;
  /** Street + house number ("Straße/Hs"). */
  pickup_street: string;
  pickup_zip: string;
  pickup_city: string;
  /** ISO-ish 2-letter country code parsed from "LKZ-Land"; defaults to "DE". */
  pickup_country: string;
  /** Free-text note ("Hinweis"). */
  pickup_note: string;
  /** Pickup date ("Abholtermin"), DD.MM.YYYY. */
  pickup_date: string;
  /** Pickup window start (HH:MM). */
  pickup_time_from: string;
  /** Pickup window end (HH:MM). */
  pickup_time_to: string;
  /** Vehicle type ("Fahrzeug"). */
  pickup_vehicle: string;

  // ── Delivery ("Zustellung") ─────────────────────────────────────────────────
  delivery_name: string;
  delivery_name2: string;
  delivery_contact: string;
  delivery_phone: string;
  delivery_email: string;
  delivery_street: string;
  delivery_zip: string;
  delivery_city: string;
  delivery_country: string;
  delivery_note: string;
  /** Delivery date ("Zustelltermin"), DD.MM.YYYY. */
  delivery_date: string;
  delivery_time_from: string;
  delivery_time_to: string;

  // ── Package & value ─────────────────────────────────────────────────────────
  /** Number of packages ("colli"); null if not parsed. */
  package_count: number | null;
  /** Weight in kg; null if not parsed. */
  weight: number | null;
  /** Declared value in EUR ("Wert … EUR"); null if not parsed. */
  value: number | null;
  /** Goods description. */
  description: string;
  /** Dimensions "LxBxH" (cm), assembled from "L: … B: … H: …". */
  dimensions: string;

  // ── Status ────────────────────────────────────────────────────────────────
  /** Last status ("Zugestellt", "Abgeholt", "Storniert", "AKTIV", …). */
  status: string;
  /** Status date (DD.MM.YY). */
  status_date: string;
  /** Status time (HH:MM). */
  status_time: string;
  /** Receiver / signer captured with the status, if any. */
  receiver: string;
}

/**
 * Input accepted by `POST /v1/shipments`. Fields mirror what the portal's
 * "Neuer Auftrag" form needs (see the original `/api/opal/create` handler).
 */
export interface Address {
  name1: string;
  street?: string;
  house_number?: string;
  zip: string;
  city: string;
}

export interface CreateShipmentInput {
  sender_address: Address;
  receiver_address: Address;
  /** Weight in kg. Defaults to 1.0 if omitted. */
  weight?: number;
  /** Customer reference to stamp on the order ("Ref"). */
  ref_number?: string;
  /** Internal order number; used as reference fallback and in the echo. */
  order_number?: string;
}

export interface ListResult {
  shipments: Shipment[];
  next_cursor: string | null;
}

export interface HealthResult {
  driver: "scraper" | "db";
}

/**
 * The one interface the whole product hangs on. Today implemented by
 * `ScraperSource` (Playwright against the portal); tomorrow by `DbSource`
 * (direct SQL against OPAL's own database). The REST contract never changes
 * when the implementation does — that separation is the entire pitch.
 */
export interface OcuSource {
  /** List shipments, newest first. `limit` is already clamped by the caller;
   *  `cursor` is an opaque pagination token (see src/cursor.ts). */
  listShipments(limit: number, cursor?: string): Promise<ListResult>;
  /** Fetch a single shipment by its ocu_number/tracking_number, or null. */
  getShipment(id: string): Promise<Shipment | null>;
  /** Create a shipment; returns the created shipment (at minimum its numbers). */
  createShipment(input: CreateShipmentInput): Promise<Shipment>;
  /** Cheap liveness signal — reports which driver is active. Must not require a
   *  live upstream round-trip. */
  health(): Promise<HealthResult>;
  /** Release any held resources (browser, DB pool). Optional. */
  close?(): Promise<void>;
}
