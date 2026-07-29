import type {
  CreateShipmentInput,
  DocumentResult,
  DocumentType,
  HealthResult,
  ListResult,
  OcuSource,
  Shipment,
} from "./types.js";

/**
 * DbSource — the intended PRODUCTION driver, to be implemented by OPAL once they
 * adopt this project. It talks directly to OPAL's own shipment database instead
 * of driving their web portal with a headless browser.
 *
 * This is an honest stub: it satisfies the OcuSource interface so the rest of
 * the system (server, auth, routing, OpenAPI contract) already compiles and
 * runs against it, but every method throws until OPAL wires in their schema.
 * Selecting it (DRIVER=db) starts the API cleanly; calls then surface a clear
 * "not implemented" error rather than pretending to work.
 *
 * ─── SQL MAPPING SKETCH (for whoever implements this) ────────────────────────
 * The Shipment fields map 1:1 onto columns of the portal's order tables. The
 * scraper reverse-engineered these from the rendered detail page; the DB has
 * them first-hand. A plausible mapping (rename to your real schema):
 *
 *   Shipment field        ← source column (guessed OPAL names)
 *   ─────────────────────────────────────────────────────────────
 *   ocu_number            ← auftrag.sendungsnr            (canonical id)
 *   tracking_number       ← auftrag.sendungsnr            (same value)
 *   hwb_number            ← auftrag.hwb
 *   product_type          ← auftrag.auftragsart
 *   reference             ← auftrag.referenz
 *   created_at            ← auftrag.erfasst_am
 *   created_by            ← auftrag.erfasst_durch
 *   pickup_*              ← adresse WHERE rolle = 'abholung'
 *     _name/_name2          adresse.name1 / name2
 *     _contact              adresse.ansprechpartner
 *     _phone/_email         adresse.telefon / mail
 *     _street               adresse.strasse || ' ' || adresse.hausnr
 *     _zip/_city/_country   adresse.plz / ort / lkz
 *     _note                 adresse.hinweis
 *     _date/_time_from/_to  termin.datum / zeit_von / zeit_bis (typ='abholung')
 *     _vehicle              termin.fahrzeug
 *   delivery_*            ← adresse WHERE rolle = 'zustellung' (+ termin typ='zustellung')
 *   package_count         ← pack.colli
 *   weight                ← pack.gewicht
 *   value                 ← pack.wert
 *   description           ← pack.beschreibung
 *   dimensions            ← concat(pack.laenge,'x',pack.breite,'x',pack.hoehe)
 *   status/_date/_time    ← status.code / datum / zeit (latest event)
 *   receiver              ← status.empfaenger
 *
 * Implementation notes:
 *   • listShipments: ORDER BY erfasst_am DESC; translate the opaque cursor into
 *     a keyset (e.g. (erfasst_am, sendungsnr) < decoded tuple) — keyset beats
 *     OFFSET at scale. Encode the next tuple back into next_cursor (base64url).
 *   • getShipment: WHERE sendungsnr = $1 — a real primary-key lookup, no scan.
 *   • createShipment: INSERT into the order tables inside a transaction and
 *     return the freshly assigned sendungsnr as ocu_number/tracking_number.
 *   • health: SELECT 1 — cheap connectivity check; keep it side-effect free.
 *   • On any DB failure, throw UpstreamPortalError so the API returns 502 with
 *     code "upstream_portal_error", identical to the scraper driver.
 */
export class DbSource implements OcuSource {
  private notImplemented(method: string): never {
    throw new Error(
      `DbSource.${method} is not implemented — the native OPAL database driver ` +
        `is a stub. Run with DRIVER=scraper, or implement DbSource against the ` +
        `OPAL schema (see the SQL mapping sketch in src/drivers/db.ts).`,
    );
  }

  async health(): Promise<HealthResult> {
    return { driver: "db" };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async listShipments(_limit: number, _cursor?: string): Promise<ListResult> {
    return this.notImplemented("listShipments");
  }

  async getShipment(_id: string): Promise<Shipment | null> {
    return this.notImplemented("getShipment");
  }

  async createShipment(_input: CreateShipmentInput): Promise<Shipment> {
    return this.notImplemented("createShipment");
  }

  async getDocument(_id: string, _type: DocumentType): Promise<DocumentResult> {
    // In the native driver a document would be produced from the order tables
    // (e.g. a stored/rendered label blob), not scraped through a browser.
    return this.notImplemented("getDocument");
  }
}
