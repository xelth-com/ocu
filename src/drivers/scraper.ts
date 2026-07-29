import { chromium } from "playwright";
import type { BrowserContext, Frame, Page } from "playwright";
import { UpstreamPortalError } from "../errors.js";
import { decodeCursor, encodeCursor } from "../cursor.js";
import { emptyShipment, parseOpalDetail } from "./opal-parse.js";
import type {
  CreateShipmentInput,
  HealthResult,
  ListResult,
  OcuSource,
  Shipment,
} from "./types.js";

export interface ScraperConfig {
  url: string;
  username: string;
  password: string;
  userDataDir: string;
  /** Run the browser headed with slowMo — for local debugging only. */
  debug?: boolean;
}

/** Upper bound on how many recent shipments getShipment() will scan when the
 *  portal offers no direct by-id lookup. Mirrors the API's MAX_LIMIT. */
const GET_SCAN_CAP = 200;

function matchesId(s: Shipment, id: string): boolean {
  return s.ocu_number === id || s.tracking_number === id || s.hwb_number === id;
}

/**
 * ScraperSource — the OcuSource driver backed by Playwright automation of the
 * OPAL portal (opal-kurier.de). This is the faithful port of the production
 * scraper: the browser launch options, login flow, frame handling
 * ("optop"/"opmain"), row iteration (`tr[onmouseover]`) and ">" pagination are
 * preserved exactly, because they are proven against the live portal.
 *
 * When OPAL adopts this project, swap this for DbSource — the OcuSource
 * contract (and therefore the REST API) does not change.
 */
export class ScraperSource implements OcuSource {
  private readonly cfg: ScraperConfig;
  /** Serialises browser access — one portal session at a time, exactly like the
   *  original `browserLock`. */
  private lock: Promise<void> = Promise.resolve();

  constructor(cfg: ScraperConfig) {
    this.cfg = cfg;
  }

  async health(): Promise<HealthResult> {
    // Cheap by design: reports the active driver without a portal round-trip so
    // the unauthenticated /v1/health endpoint stays fast and side-effect free.
    return { driver: "scraper" };
  }

  async listShipments(limit: number, cursor?: string): Promise<ListResult> {
    // The cursor is opaque to the API layer; this driver owns its meaning and
    // validates it here (malformed → InvalidRequestError → 400).
    const offset = cursor ? decodeCursor(cursor).offset : 0;
    const target = offset + limit;
    const collected = await this.runFetch({ target });
    const shipments = collected.slice(offset, offset + limit);
    // If we filled the whole target the portal had at least that many rows, so
    // there may be more — hand back a cursor. Otherwise the list is exhausted.
    const next_cursor =
      collected.length >= target ? encodeCursor({ offset: offset + limit }) : null;
    return { shipments, next_cursor };
  }

  async getShipment(id: string): Promise<Shipment | null> {
    // The portal exposes no direct by-id view in the proven flow, so we scan the
    // recent list (bounded) and early-exit on the first match.
    const collected = await this.runFetch({ target: GET_SCAN_CAP, findId: id });
    return collected.find((s) => matchesId(s, id)) ?? null;
  }

  async createShipment(input: CreateShipmentInput): Promise<Shipment> {
    return this.run(async (page) => {
      const { url, username, password } = this.cfg;
      const targetUrl = url || "https://opal-kurier.de";
      const order_number = input.order_number ?? "";

      // ── login (create flow, ported exactly) ──────────────────────────────
      await page.goto(targetUrl, { waitUntil: "networkidle" });
      await page.fill("input[name='username']", username);
      await page.fill("input[type='password']", password);
      await page.locator("input[type='submit'], button[type='submit']").first().click();
      await page.waitForLoadState("networkidle");

      const topFrame = page.frame({ name: "optop" });
      if (!topFrame) throw new Error("Frame 'optop' not found");
      await topFrame
        .locator("a:has-text('Neuer Auftrag'), a[href*='new']")
        .first()
        .click();
      await page.waitForTimeout(2000);

      const mainFrame = page.frame({ name: "opmain" });
      if (!mainFrame) throw new Error("Frame 'opmain' not found");

      const fillArray = async (sel: string, idx: number, val: string) => {
        const locs = mainFrame.locator(sel);
        if ((await locs.count()) > idx) await locs.nth(idx).fill(val || "");
      };

      const sender = input.sender_address;
      const receiver = input.receiver_address;
      const senderStreet = `${sender.street || ""} ${sender.house_number || ""}`.trim();
      const receiverStreet = `${receiver.street || ""} ${receiver.house_number || ""}`.trim();

      await fillArray("input[name='address_name1[]']", 0, sender.name1);
      await fillArray("input[name='address_str[]']", 0, senderStreet);
      await fillArray("input[name='address_plz[]']", 0, sender.zip);
      await fillArray("input[name='address_ort[]']", 0, sender.city);
      await fillArray("input[name='address_name1[]']", 1, receiver.name1);
      await fillArray("input[name='address_str[]']", 1, receiverStreet);
      await fillArray("input[name='address_plz[]']", 1, receiver.zip);
      await fillArray("input[name='address_ort[]']", 1, receiver.city);

      const weightVal = Number(input.weight) || 1.0;
      await mainFrame.fill("input#segewicht", weightVal.toFixed(1).replace(".", ","));
      await mainFrame.fill("input#seclref", input.ref_number || order_number);

      await mainFrame.locator("input[type='submit'], button[type='submit']").first().click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2000);

      const bodyText = await mainFrame
        .innerText("body")
        .catch(() => page.innerText("body"));
      const match = bodyText.match(/Sendungsnummer[:\s]*([A-Z0-9-]+)/i);
      const tracking_number = match ? match[1] : `OPAL-UNKNOWN-${order_number}`;

      // Build the response Shipment. Identity comes from the portal
      // confirmation; the remaining fields are echoed from the submitted input
      // (the confirmation page only reliably returns the number).
      const shipment = emptyShipment();
      shipment.tracking_number = tracking_number;
      shipment.ocu_number = tracking_number;
      shipment.reference = input.ref_number || order_number;
      shipment.weight = weightVal;
      shipment.pickup_name = sender.name1;
      shipment.pickup_street = senderStreet;
      shipment.pickup_zip = sender.zip;
      shipment.pickup_city = sender.city;
      shipment.delivery_name = receiver.name1;
      shipment.delivery_street = receiverStreet;
      shipment.delivery_zip = receiver.zip;
      shipment.delivery_city = receiver.city;
      shipment.status = match ? "created" : "";
      return shipment;
    });
  }

  // ── internal: fetch/iterate the Auftragsliste (ported exactly) ────────────
  private runFetch(opts: { target: number; findId?: string }): Promise<Shipment[]> {
    const { target, findId } = opts;
    return this.run(async (page) => {
      const { url, username, password } = this.cfg;
      const targetUrl = url || "https://opal-kurier.de";

      // Navigate and login (list flow, ported exactly)
      await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 });
      const hasLoginForm = await page.locator('input[type="password"]').count();
      if (hasLoginForm > 0) {
        await page.locator('input[name="username"], input[type="text"]').first().fill(username);
        await page.locator('input[type="password"]').first().fill(password);
        await page.locator('button[type="submit"], input[type="submit"]').first().click();
        await page.waitForLoadState("networkidle", { timeout: 30000 });
      }

      // Wait for frameset
      await page.waitForSelector('frameset, frame[name="optop"]', { timeout: 30000 });

      const getFrame = async (name: string): Promise<Frame> => {
        for (let i = 0; i < 20; i++) {
          const f = page.frames().find((fr) => fr.name() === name);
          if (f) return f;
          await page.waitForTimeout(500);
        }
        throw new Error(`Frame '${name}' not found`);
      };

      const headerFrame = await getFrame("optop");
      await headerFrame.waitForSelector("a", { timeout: 10000 });

      // Click Auftragsliste
      for (const sel of [
        'a:has-text("Auftragsliste")',
        'a:has-text("Liste")',
        'a[href*="list"]',
      ]) {
        try {
          await headerFrame.click(sel, { timeout: 5000 });
          break;
        } catch {
          /* try next */
        }
      }
      await page.waitForTimeout(3000);

      const mainFrame = await getFrame("opmain");
      await mainFrame.waitForSelector("tr[onmouseover]", { timeout: 30000 });

      const orders: Shipment[] = [];
      let currentRow = 0;

      while (orders.length < target) {
        const rowCount = await mainFrame.evaluate(
          () => document.querySelectorAll("tr[onmouseover]").length,
        );

        if (currentRow >= rowCount) {
          // Try next page
          const hasNext = await mainFrame.evaluate(() => {
            for (const el of document.querySelectorAll("a, td[onclick]")) {
              if (el.textContent?.trim() === ">") {
                (el as HTMLElement).click();
                return true;
              }
            }
            return false;
          });
          if (!hasNext) break;
          await page.waitForTimeout(2000);
          currentRow = 0;
          continue;
        }

        const clicked = await mainFrame.evaluate((idx: number) => {
          const rows = document.querySelectorAll("tr[onmouseover]");
          const td = rows[idx]?.querySelector("td[onclick]");
          if (td) {
            (td as HTMLElement).click();
            return true;
          }
          return false;
        }, currentRow);

        if (!clicked) {
          currentRow++;
          continue;
        }

        try {
          await mainFrame.waitForFunction(
            () =>
              document.body.innerText.includes("SendungsNr") &&
              document.body.innerText.includes("zur Liste zurück"),
            { timeout: 10000 },
          );
        } catch {
          currentRow++;
          continue;
        }

        const text = await mainFrame.evaluate(() => document.body.innerText);
        if (!text.includes("zur Liste zurück")) {
          currentRow++;
          continue;
        }

        const order = parseOpalDetail(text);
        if (order.tracking_number || order.hwb_number) {
          orders.push(order);
          // Early exit for getShipment(): stop as soon as we see the target id.
          if (findId && matchesId(order, findId)) break;
        }

        // Go back to list
        const wentBack = await mainFrame.evaluate(() => {
          for (const el of document.querySelectorAll("a, button")) {
            if (el.textContent?.includes("zur Liste")) {
              (el as HTMLElement).click();
              return true;
            }
          }
          return false;
        });
        if (!wentBack) break;

        try {
          await mainFrame.waitForFunction(
            () =>
              document.body.innerText.includes("Datensätzen") &&
              !document.body.innerText.includes("SendungsNr"),
            { timeout: 10000 },
          );
        } catch {
          await page.waitForTimeout(2000);
        }

        currentRow++;
      }

      return orders;
    });
  }

  /**
   * Browser lifecycle harness — the port of `runScraper`. Serialises access via
   * a promise lock, launches a persistent Chromium context with the exact same
   * hardening/locale options, runs `logicFn(page)`, and always tears the
   * context down. Any failure is normalised to UpstreamPortalError (→ 502).
   */
  private async run<T>(logicFn: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
    const headless = !this.cfg.debug;
    const slowMo = this.cfg.debug ? 600 : 0;

    // Serialise requests to avoid concurrent browser conflicts.
    const prevLock = this.lock;
    let releaseLock!: () => void;
    this.lock = new Promise<void>((r) => (releaseLock = r));
    await prevLock;

    let context: BrowserContext | null = null;
    let page: Page | null = null;
    try {
      context = await chromium.launchPersistentContext(this.cfg.userDataDir, {
        headless,
        slowMo,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
        viewport: { width: 1920, height: 1080 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        acceptDownloads: true,
      });
      page = await context.newPage();
      return await logicFn(page, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new UpstreamPortalError(`OPAL portal automation failed: ${message}`);
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      releaseLock();
    }
  }
}
