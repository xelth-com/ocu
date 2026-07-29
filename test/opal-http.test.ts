import { describe, it, expect } from "vitest";
import {
  CookieJar,
  extractLabelsUrl,
  extractPdfUrl,
  extractSuccessUrl,
  looksLikeLoginPage,
} from "../src/drivers/opal-http.js";

const BASE = "https://opal-kurier.de";
const HOP1_URL = `${BASE}/main/op_print_docs.php?type=hwb&ma=603&cl=60952&ref=17032005&field=KEY`;
const HOP2_URL = `${BASE}/main/op_print_labels.php?format=A4&ids=abc123`;

describe("extractLabelsUrl (hop 1 → hop 2)", () => {
  it("pulls the op_print_labels.php URL out of the inline location assignment", () => {
    // Shape per VERSANDAUFTRAG_FLOW.md §C hop 1: script sets
    //   location = op_print_labels.php?format=A4&ids=<...>
    const html = `<html><head><script>location = "op_print_labels.php?format=A4&ids=abc123";</script></head></html>`;
    expect(extractLabelsUrl(html, HOP1_URL)).toBe(
      `${BASE}/main/op_print_labels.php?format=A4&ids=abc123`,
    );
  });

  it("returns null when the labels link is absent", () => {
    expect(extractLabelsUrl("<html>nothing here</html>", HOP1_URL)).toBeNull();
  });
});

describe("extractPdfUrl (hop 2 → hop 3)", () => {
  it("resolves the ../print/tmpprint/*.pdf reference against the label page", () => {
    // Shape per §C hop 2: references ../print/tmpprint/<YYYYMMDD-HHMMSS-ma-cl>.pdf
    const html = `<html><body><a href="../print/tmpprint/20260729-132419-603-60952.pdf">open</a></body></html>`;
    expect(extractPdfUrl(html, HOP2_URL)).toBe(
      `${BASE}/print/tmpprint/20260729-132419-603-60952.pdf`,
    );
  });

  it("returns null when no tmpprint pdf is referenced", () => {
    expect(extractPdfUrl("<html>no pdf</html>", HOP2_URL)).toBeNull();
  });
});

describe("extractSuccessUrl (login handshake)", () => {
  it("finds a direct fn=success handshake URL", () => {
    const html = `<script>location.href='ssl-load-opal.php?fn=success&id=44455&sid=LE-abc123';</script>`;
    expect(extractSuccessUrl(html, BASE)).toBe(
      `${BASE}/ssl-load-opal.php?fn=success&id=44455&sid=LE-abc123`,
    );
  });

  it("assembles the URL from separate query-style id / sid tokens", () => {
    // Fragmented response: no contiguous fn=success URL, but the params exist.
    const html = `<a href="op_start.php?id=44455">go</a><script>var s="?sid=LE-xyz789";</script>`;
    expect(extractSuccessUrl(html, BASE)).toBe(
      `${BASE}/ssl-load-opal.php?fn=success&id=44455&sid=LE-xyz789`,
    );
  });

  it("returns null when neither is present", () => {
    expect(extractSuccessUrl("<html>logged in</html>", BASE)).toBeNull();
  });
});

describe("looksLikeLoginPage", () => {
  it("flags the login/landing page", () => {
    expect(looksLikeLoginPage(`<form onsubmit="return opal_submit_form()">`)).toBe(true);
    expect(looksLikeLoginPage(`<input type="password" name="password">`)).toBe(true);
    expect(looksLikeLoginPage(`<input type='password'>`)).toBe(true);
  });

  it("does not flag a normal print wrapper", () => {
    expect(looksLikeLoginPage(`<script>location = "op_print_labels.php?ids=1";</script>`)).toBe(
      false,
    );
  });
});

describe("CookieJar", () => {
  it("absorbs Set-Cookie and replays name=value pairs", () => {
    const jar = new CookieJar();
    jar.absorb(
      new Response(null, {
        headers: [["set-cookie", "PHPSESSID=abc123; Path=/; HttpOnly"]],
      }),
    );
    expect(jar.header()).toBe("PHPSESSID=abc123");
    expect(jar.size).toBe(1);
  });

  it("accumulates distinct cookies and overwrites same-name values", () => {
    const jar = new CookieJar();
    jar.absorb(
      new Response(null, {
        headers: [
          ["set-cookie", "PHPSESSID=one; Path=/"],
          ["set-cookie", "extra=yes"],
        ],
      }),
    );
    jar.absorb(new Response(null, { headers: [["set-cookie", "PHPSESSID=two"]] }));
    expect(jar.size).toBe(2);
    expect(jar.header()).toContain("PHPSESSID=two");
    expect(jar.header()).toContain("extra=yes");
  });

  it("clears", () => {
    const jar = new CookieJar();
    jar.absorb(new Response(null, { headers: [["set-cookie", "a=1"]] }));
    jar.clear();
    expect(jar.size).toBe(0);
    expect(jar.header()).toBe("");
  });
});
