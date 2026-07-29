import { UpstreamPortalError } from "../src/errors.js";
import { decodeCursor } from "../src/cursor.js";
import { emptyShipment } from "../src/drivers/opal-parse.js";
import type {
  CreateShipmentInput,
  HealthResult,
  ListResult,
  OcuSource,
  Shipment,
} from "../src/drivers/types.js";

export function sampleShipment(ocu = "OCU-1001"): Shipment {
  const s = emptyShipment();
  s.ocu_number = ocu;
  s.tracking_number = ocu;
  s.hwb_number = "123456789012";
  s.delivery_name = "Muster GmbH";
  s.delivery_city = "Berlin";
  s.status = "AKTIV";
  return s;
}

export interface FakeOptions {
  driverName?: "scraper" | "db";
  failUpstream?: boolean;
  shipment?: Shipment | null;
}

/** In-memory OcuSource for exercising the HTTP layer without a live portal. */
export class FakeDriver implements OcuSource {
  constructor(private readonly opts: FakeOptions = {}) {}

  async health(): Promise<HealthResult> {
    return { driver: this.opts.driverName ?? "scraper" };
  }

  async listShipments(limit: number, cursor?: string): Promise<ListResult> {
    if (this.opts.failUpstream) throw new UpstreamPortalError("portal down");
    // Validate the opaque cursor exactly as a real driver does (→ 400 on bad).
    if (cursor) decodeCursor(cursor);
    return { shipments: [sampleShipment()].slice(0, limit), next_cursor: null };
  }

  async getShipment(id: string): Promise<Shipment | null> {
    if (this.opts.failUpstream) throw new UpstreamPortalError("portal down");
    if (this.opts.shipment !== undefined) return this.opts.shipment;
    return id === "OCU-1001" ? sampleShipment(id) : null;
  }

  async createShipment(input: CreateShipmentInput): Promise<Shipment> {
    if (this.opts.failUpstream) throw new UpstreamPortalError("login failed");
    const s = sampleShipment("OCU-2002");
    s.reference = input.ref_number ?? input.order_number ?? "";
    return s;
  }
}
