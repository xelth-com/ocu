import type { Shipment } from "./types.js";

/**
 * Build a Shipment with every field defaulted, matching the exact field set the
 * production scraper produces. `ocu_number` is added as a canonical alias of
 * `tracking_number` (the portal's SendungsNr).
 */
export function emptyShipment(): Shipment {
  return {
    ocu_number: "",
    tracking_number: "",
    hwb_number: "",
    product_type: "",
    reference: "",
    created_at: "",
    created_by: "",

    pickup_name: "",
    pickup_name2: "",
    pickup_contact: "",
    pickup_phone: "",
    pickup_email: "",
    pickup_street: "",
    pickup_zip: "",
    pickup_city: "",
    pickup_country: "DE",
    pickup_note: "",
    pickup_date: "",
    pickup_time_from: "",
    pickup_time_to: "",
    pickup_vehicle: "",

    delivery_name: "",
    delivery_name2: "",
    delivery_contact: "",
    delivery_phone: "",
    delivery_email: "",
    delivery_street: "",
    delivery_zip: "",
    delivery_city: "",
    delivery_country: "DE",
    delivery_note: "",
    delivery_date: "",
    delivery_time_from: "",
    delivery_time_to: "",

    package_count: null,
    weight: null,
    value: null,
    description: "",
    dimensions: "",

    status: "",
    status_date: "",
    status_time: "",
    receiver: "",
  };
}

/** The three internal portal ids carried by a `PrintDocs(...)` call. */
export interface PrintDocsIds {
  /** `ref` argument — the internal orderval (e.g. "17032005"). */
  orderval?: string;
  /** `ma` argument — the account mandant (e.g. "603"). */
  mandant?: string;
  /** `cl` argument — the account client (e.g. "60952"). */
  client_id?: string;
}

/**
 * Extract the internal portal ids from a detail page's print link. The detail
 * page carries three `PrintDocs(type, ma, cl, ref, 'KEY')` calls (order / hwb /
 * ab) that all share the same `ma`/`cl`/`ref`; we read them off the `hwb`
 * (Versandlabel) one. The match tolerates single or double quotes and arbitrary
 * whitespace between arguments. Returns an empty object when no such call is
 * present (e.g. the input is plain innerText, which carries no attributes) —
 * this never throws.
 *
 * NB: `PrintDocs` lives in element attributes/scripts, so this only finds
 * anything when fed raw HTML, not rendered innerText.
 */
export function extractPrintDocsIds(source: string): PrintDocsIds {
  const m = source.match(
    /PrintDocs\(\s*['"]hwb['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]KEY['"]\s*\)/i,
  );
  if (!m) return {};
  return { mandant: m[1], client_id: m[2], orderval: m[3] };
}

/**
 * Parse the innerText of an OPAL shipment detail page into a Shipment.
 *
 * PORTED VERBATIM from the production scraper's `parseOpalDetail`: the regexes,
 * German section anchors ("Abholung"/"Zustellung"/"Abholtermin"/…) and window
 * offsets are proven against the live portal and MUST NOT be "cleaned up".
 *
 * Additions over the verbatim port:
 *   • `ocu_number` is set to `tracking_number` at the end.
 *   • the optional `html` argument is scanned for the `PrintDocs(...)` call to
 *     recover the internal `orderval`/`mandant`/`client_id` (needed to address
 *     the shipment's PDFs). innerText alone carries no attributes, so pass the
 *     page HTML when these ids are wanted; absence leaves them undefined.
 */
export function parseOpalDetail(text: string, html?: string): Shipment {
  const order = emptyShipment();

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l);

  // Parse SendungsNr, HWB, Auftragsart, Referenz
  for (const line of lines) {
    if (line.includes("SendungsNr")) {
      const m = line.match(/SendungsNr\s+(OCU[-\d]+)/);
      if (m) order.tracking_number = m[1];
    }
    if (line.includes("HWB") && !order.hwb_number) {
      const m = line.match(/HWB\s+(\d{12}|OCU-[\d-]+)/);
      if (m) order.hwb_number = m[1];
    }
    if (line.includes("Auftragsart")) {
      const m = line.match(/Auftragsart\s+(\S+)/);
      if (m) order.product_type = m[1];
    }
    if (line.includes("Referenz") && !line.includes("Ref/KST")) {
      const m = line.match(/Referenz\s+(\S+)/);
      if (m) order.reference = m[1];
    }
  }

  // Parse created info
  const createdMatch = text.match(/erfasst am\s+([\d\.\-\s:]+Uhr)/);
  if (createdMatch) order.created_at = createdMatch[1].trim();
  const createdByMatch = text.match(/erfasst durch\s+(\S+)/);
  if (createdByMatch) order.created_by = createdByMatch[1];

  // Parse Abholung section
  const abholungIdx = lines.findIndex((l) => l === "Abholung");
  if (abholungIdx >= 0) {
    for (let i = abholungIdx + 1; i < Math.min(abholungIdx + 15, lines.length); i++) {
      const line = lines[i];
      if (line.startsWith("Name1")) order.pickup_name = line.replace("Name1", "").trim();
      if (line.startsWith("Name2")) order.pickup_name2 = line.replace("Name2", "").trim();
      if (line.startsWith("Ansprechpartner"))
        order.pickup_contact = line.replace("Ansprechpartner", "").trim();
      if (line.startsWith("Telefon")) order.pickup_phone = line.replace("Telefon", "").trim();
      if (line.startsWith("Mail")) order.pickup_email = line.replace("Mail", "").trim();
      if (line.startsWith("Straße/Hs")) order.pickup_street = line.replace("Straße/Hs", "").trim();
      if (line.startsWith("LKZ-Land")) {
        const addr = line.replace("LKZ-Land", "").trim();
        const m = addr.match(/([A-Z]{2})-(\d{4,5})\s+(.+)/);
        if (m) {
          order.pickup_country = m[1];
          order.pickup_zip = m[2];
          order.pickup_city = m[3];
        }
      }
      if (line.startsWith("Hinweis") && !order.pickup_note)
        order.pickup_note = line.replace("Hinweis", "").trim();
      if (line === "Zustellung") break;
    }
  }

  // Parse Zustellung section
  const zustellungIdx = lines.findIndex((l) => l === "Zustellung");
  if (zustellungIdx >= 0) {
    for (let i = zustellungIdx + 1; i < Math.min(zustellungIdx + 15, lines.length); i++) {
      const line = lines[i];
      if (line.startsWith("Name1")) order.delivery_name = line.replace("Name1", "").trim();
      if (line.startsWith("Name2")) order.delivery_name2 = line.replace("Name2", "").trim();
      if (line.startsWith("Ansprechpartner"))
        order.delivery_contact = line.replace("Ansprechpartner", "").trim();
      if (line.startsWith("Telefon")) order.delivery_phone = line.replace("Telefon", "").trim();
      if (line.startsWith("Mail")) order.delivery_email = line.replace("Mail", "").trim();
      if (line.startsWith("Straße/Hs"))
        order.delivery_street = line.replace("Straße/Hs", "").trim();
      if (line.startsWith("LKZ-Land")) {
        const addr = line.replace("LKZ-Land", "").trim();
        const m = addr.match(/([A-Z]{2})-(\d{4,5})\s+(.+)/);
        if (m) {
          order.delivery_country = m[1];
          order.delivery_zip = m[2];
          order.delivery_city = m[3];
        }
      }
      if (line.startsWith("Hinweis") && !order.delivery_note)
        order.delivery_note = line.replace("Hinweis", "").trim();
      if (line.includes("Abholtermin") || line.includes("Frühtermine")) break;
    }
  }

  // Parse pickup date/time
  const abholTerminIdx = lines.findIndex((l) => l.includes("Abholtermin"));
  if (abholTerminIdx >= 0) {
    for (let i = abholTerminIdx + 1; i < Math.min(abholTerminIdx + 5, lines.length); i++) {
      const line = lines[i];
      const dateMatch = line.match(/(\d{2}\.\d{2}\.\d{4})/);
      if (dateMatch) order.pickup_date = dateMatch[1];
      const timeMatch = line.match(/Zeit\s+(\d{2}:\d{2})\s+-\s+(\d{2}:\d{2})/);
      if (timeMatch) {
        order.pickup_time_from = timeMatch[1];
        order.pickup_time_to = timeMatch[2];
      }
      if (line.includes("Fahrzeug")) {
        const vehicleMatch = line.match(/Fahrzeug\s+(\S+)/);
        if (vehicleMatch) order.pickup_vehicle = vehicleMatch[1];
      }
      if (line.includes("Zustelltermin")) break;
    }
  }

  // Parse delivery date/time
  const zustellTerminIdx = lines.findIndex((l) => l.includes("Zustelltermin"));
  if (zustellTerminIdx >= 0) {
    for (let i = zustellTerminIdx + 1; i < Math.min(zustellTerminIdx + 3, lines.length); i++) {
      const line = lines[i];
      const dateMatch = line.match(/(\d{2}\.\d{2}\.\d{4})/);
      if (dateMatch) order.delivery_date = dateMatch[1];
      const timeMatch = line.match(/Zeit\s+(\d{2}:\d{2})\s+-\s+(\d{2}:\d{2})/);
      if (timeMatch) {
        order.delivery_time_from = timeMatch[1];
        order.delivery_time_to = timeMatch[2];
      }
      if (line.includes("Sendung & Pack")) break;
    }
  }

  // Parse package value
  const wertMatch = text.match(/Wert\s+([\d\.,]+)\s*EUR/);
  if (wertMatch) order.value = parseFloat(wertMatch[1].replace(".", "").replace(",", "."));

  // Parse weight, package count, description
  const weightMatch = text.match(/(\d+)\s+([\d,]+)\s+([A-Za-z_][\w\s]+?)(?:\s+VolG|$)/m);
  if (weightMatch) {
    order.package_count = parseInt(weightMatch[1]);
    order.weight = parseFloat(weightMatch[2].replace(",", "."));
    order.description = weightMatch[3].trim();
  }

  // Parse dimensions
  const dimMatch = text.match(/L:\s*([\d,]+)\s*B:\s*([\d,]+)\s*H:\s*([\d,]+)/);
  if (dimMatch) order.dimensions = `${dimMatch[1]}x${dimMatch[2]}x${dimMatch[3]}`;

  // Parse status
  const statusMatch = text.match(
    /(\d{12}|OCU-[\d-]+)\s+(\d{2}\.\d{2}\.\d{2})\s+(\d{2}:\d{2})\s+(Zugestellt|Abgeholt|Storniert|AKTIV|geliefert|ausgeliefert|Fehlanfahrt)\s*(\S*)/i,
  );
  if (statusMatch) {
    order.status = statusMatch[4];
    order.status_date = statusMatch[2];
    order.status_time = statusMatch[3];
    order.receiver = statusMatch[5] || "";
  }

  // Canonical id alias: the portal's SendungsNr is our ocu_number.
  order.ocu_number = order.tracking_number;

  // Internal ids for PDF retrieval — read from the raw HTML's PrintDocs call
  // (falls back to `text` so a caller can pass a single HTML string). Absent →
  // stays undefined, never throws.
  const ids = extractPrintDocsIds(html ?? text);
  if (ids.orderval) order.orderval = ids.orderval;
  if (ids.mandant) order.mandant = ids.mandant;
  if (ids.client_id) order.client_id = ids.client_id;

  return order;
}
