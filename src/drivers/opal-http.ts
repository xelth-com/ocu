import { UpstreamPortalError } from "../errors.js";

/**
 * Plain-HTTP OPAL session — the browser-free path to a shipment's PDF.
 *
 * The recon in docs/VERSANDAUFTRAG_FLOW.md proved that PDF retrieval needs no
 * JavaScript engine: a cookie jar plus three sequential GETs, each following a
 * URL scraped out of the previous hop's HTML, returns the PDF bytes. This class
 * is that path — Node's built-in `fetch` with a hand-rolled cookie jar, no
 * Playwright, no extra runtime dependency.
 *
 * Login (§A of the recon) is a clean AJAX POST with no CSRF token; the session
 * rides a server-set cookie. We log in lazily on first use, reuse the session
 * across calls, and re-login exactly once if a hop comes back as a login page
 * (session expiry). See `getDocument`.
 */

export interface OpalHttpConfig {
  /** Portal base URL, e.g. "https://opal-kurier.de" (no trailing slash needed). */
  baseUrl: string;
  username: string;
  password: string;
}

export interface OpalDocumentRequest {
  /** Internal order id (`ref` / orderval), e.g. "17032005". */
  orderval: string;
  /** Account mandant (`ma`), e.g. "603". */
  ma: string;
  /** Account client (`cl`), e.g. "60952". */
  cl: string;
  /** Portal document type: "hwb" (label), "order", or "ab" (confirmation). */
  portalType: "hwb" | "order" | "ab";
}

export interface OpalPdf {
  contentType: string;
  bytes: Buffer;
  filename?: string;
}

// A recent, ordinary desktop UA — the portal is a plain PHP app and does not
// gate on this, but sending a real-looking UA avoids any lazy bot heuristics.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 30_000;

/** Internal sentinel: a hop returned a login page → the session expired. */
class SessionExpired extends Error {
  constructor() {
    super("OPAL session expired");
    this.name = "SessionExpired";
  }
}

/**
 * Minimal cookie jar: stores the latest value per cookie name and replays them
 * as a single `Cookie` header. Deliberately dumb — no domain/path/expiry logic,
 * because every request in this flow is same-origin against the one portal host
 * and the portal uses a single session cookie.
 */
export class CookieJar {
  private readonly jar = new Map<string, string>();

  /** Absorb every `Set-Cookie` from a response. */
  absorb(res: Response): void {
    for (const raw of readSetCookies(res)) {
      // A Set-Cookie is "name=value; Path=/; HttpOnly; ..." — keep name=value.
      const first = raw.split(";", 1)[0]?.trim();
      if (!first) continue;
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name) this.jar.set(name, value);
    }
  }

  /** The `Cookie` request-header value, or "" when the jar is empty. */
  header(): string {
    return Array.from(this.jar, ([k, v]) => `${k}=${v}`).join("; ");
  }

  get size(): number {
    return this.jar.size;
  }

  clear(): void {
    this.jar.clear();
  }
}

/** Read all Set-Cookie header values across Node versions. */
function readSetCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * Heuristic: does this HTML look like the login/landing page rather than a
 * portal content page? Used to detect an expired session on any hop.
 */
export function looksLikeLoginPage(html: string): boolean {
  const h = html.toLowerCase();
  return (
    h.includes("opal_submit_form") ||
    h.includes("fn=login") ||
    h.includes('type="password"') ||
    h.includes("type='password'")
  );
}

/**
 * Pull the `op_print_labels.php?...` URL out of hop-1's HTML and resolve it
 * against the hop-1 URL. The recon shows an inline `location = op_print_labels
 * .php?format=A4&ids=<...>` assignment; we match the bare relative URL wherever
 * it appears. Returns null when absent.
 */
export function extractLabelsUrl(html: string, refUrl: string): string | null {
  const m = html.match(/op_print_labels\.php\?[^"'\s<>\\)]+/i);
  if (!m) return null;
  return resolveUrl(m[0], refUrl);
}

/**
 * Pull the `../print/tmpprint/<...>.pdf` path out of hop-2's HTML and resolve
 * it against the hop-2 URL. Returns null when absent.
 */
export function extractPdfUrl(html: string, refUrl: string): string | null {
  const m = html.match(/(?:\.\.\/|\.\/|\/)?print\/tmpprint\/[\w.\-]+\.pdf/i);
  if (!m) return null;
  return resolveUrl(m[0], refUrl);
}

function resolveUrl(relative: string, base: string): string | null {
  try {
    return new URL(relative, base).toString();
  } catch {
    return null;
  }
}

export class OpalHttpSession {
  private readonly cfg: OpalHttpConfig;
  private readonly jar = new CookieJar();
  private loggedIn = false;
  /** Serialises access so a re-login mid-flight can't race a parallel caller. */
  private lock: Promise<void> = Promise.resolve();

  constructor(cfg: OpalHttpConfig) {
    this.cfg = cfg;
  }

  private base(): string {
    return this.cfg.baseUrl.replace(/\/+$/, "") || "https://opal-kurier.de";
  }

  /**
   * Fetch a document PDF via the verified 3-hop chain. Logs in lazily, reuses
   * the session, and on a login-page/expiry retries the whole chain once after
   * a fresh login before giving up. Any failure surfaces as UpstreamPortalError.
   */
  async getDocument(req: OpalDocumentRequest): Promise<OpalPdf> {
    return this.serialise(async () => {
      await this.ensureLogin(false);
      try {
        return await this.runHops(req);
      } catch (err) {
        if (!(err instanceof SessionExpired)) throw err;
        // Detected an expired session exactly once → re-login and retry once.
        await this.ensureLogin(true);
        try {
          return await this.runHops(req);
        } catch (retryErr) {
          if (retryErr instanceof SessionExpired) {
            throw new UpstreamPortalError(
              "OPAL portal rejected the session after re-login (login page returned).",
            );
          }
          throw retryErr;
        }
      }
    });
  }

  // ── the 3-hop chain (all GET, cookie-auth only) ───────────────────────────
  private async runHops(req: OpalDocumentRequest): Promise<OpalPdf> {
    const base = this.base();

    // Hop 1: op_print_docs.php → HTML wrapper linking op_print_labels.php.
    const hop1Url =
      `${base}/main/op_print_docs.php?type=${encodeURIComponent(req.portalType)}` +
      `&ma=${encodeURIComponent(req.ma)}&cl=${encodeURIComponent(req.cl)}` +
      `&ref=${encodeURIComponent(req.orderval)}&field=KEY`;
    const hop1Html = await this.getText(hop1Url);
    const labelsUrl = extractLabelsUrl(hop1Html, hop1Url);
    if (!labelsUrl) {
      throw new UpstreamPortalError(
        "OPAL print flow changed: no op_print_labels.php link in the print wrapper.",
      );
    }

    // Hop 2: op_print_labels.php → HTML referencing the generated temp PDF.
    const hop2Html = await this.getText(labelsUrl);
    const pdfUrl = extractPdfUrl(hop2Html, labelsUrl);
    if (!pdfUrl) {
      throw new UpstreamPortalError(
        "OPAL print flow changed: no print/tmpprint/*.pdf reference in the label page.",
      );
    }

    // Hop 3: the actual PDF bytes.
    const res = await this.rawGet(pdfUrl);
    const bytes = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "";
    const isPdf =
      contentType.toLowerCase().includes("pdf") ||
      bytes.subarray(0, 5).toString("latin1") === "%PDF-";
    if (!isPdf) {
      // A login page here also means the session died between hops.
      if (looksLikeLoginPage(bytes.subarray(0, 4096).toString("latin1"))) {
        throw new SessionExpired();
      }
      throw new UpstreamPortalError(
        `OPAL returned a non-PDF document (content-type "${contentType || "unknown"}").`,
      );
    }

    return {
      contentType: "application/pdf",
      bytes,
      filename: filenameFromUrl(pdfUrl),
    };
  }

  /** GET a URL, absorb cookies, return the body text; login page → SessionExpired. */
  private async getText(url: string): Promise<string> {
    const res = await this.rawGet(url);
    const text = await res.text();
    if (looksLikeLoginPage(text)) throw new SessionExpired();
    return text;
  }

  /** Low-level cookie-bearing GET. */
  private async rawGet(url: string): Promise<Response> {
    const res = await this.fetch(url, { method: "GET" });
    this.jar.absorb(res);
    return res;
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      ...(init.headers as Record<string, string> | undefined),
    };
    const cookie = this.jar.header();
    if (cookie) headers["Cookie"] = cookie;
    try {
      return await fetch(url, {
        ...init,
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new UpstreamPortalError(`OPAL request failed: ${message}`);
    }
  }

  /**
   * Ensure a live session. `force` re-logs even if we believe we are logged in
   * (used on the single expiry-retry). Login is the recon's §A sequence: POST
   * the credentials, replay the success handshake if the response exposes it,
   * then open the portal shell — capturing cookies at every step.
   */
  private async ensureLogin(force: boolean): Promise<void> {
    if (this.loggedIn && !force) return;
    const base = this.base();
    this.loggedIn = false;
    this.jar.clear();

    // Step 1 — POST the login form (url-encoded, no CSRF token).
    const body = new URLSearchParams({
      fn: "login",
      username: this.cfg.username,
      password: this.cfg.password,
    }).toString();
    const loginRes = await this.fetch(`${base}/ssl-load-opal.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    this.jar.absorb(loginRes);
    const loginHtml = await loginRes.text().catch(() => "");

    // Step 2 — replay the success handshake if the response revealed it. The
    // portal's login response is injected into the page and typically carries a
    // `ssl-load-opal.php?fn=success&id=<id>&sid=LE-<token>` follow-up. If we
    // can't find it we proceed on the cookie the POST already set.
    const successUrl = extractSuccessUrl(loginHtml, base);
    if (successUrl) {
      const r = await this.rawGet(successUrl);
      await r.arrayBuffer().catch(() => undefined);
    }

    // Step 3 — open the portal shell to finalise the session cookie.
    const shell = await this.rawGet(`${base}/op_start.php`);
    await shell.arrayBuffer().catch(() => undefined);

    if (this.jar.size === 0) {
      throw new UpstreamPortalError(
        "OPAL login did not set a session cookie — check OPAL credentials.",
      );
    }
    this.loggedIn = true;
  }

  /** Promise-chain lock: one portal conversation at a time. */
  private async serialise<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Extract the `fn=success` handshake URL from the login response, if present. */
export function extractSuccessUrl(html: string, base: string): string | null {
  const direct = html.match(/ssl-load-opal\.php\?fn=success[^"'\s<>\\)]*/i);
  if (direct) return resolveUrl(direct[0], `${base}/`);
  // Otherwise try to assemble it from separate id / sid tokens.
  const id = html.match(/[?&]id=(\d+)/i)?.[1];
  const sid = html.match(/[?&]sid=(LE-[^"'&\s<>\\)]+)/i)?.[1];
  if (id && sid) {
    return `${base}/ssl-load-opal.php?fn=success&id=${encodeURIComponent(id)}&sid=${encodeURIComponent(sid)}`;
  }
  return null;
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const name = path.slice(path.lastIndexOf("/") + 1);
    return name || undefined;
  } catch {
    return undefined;
  }
}
