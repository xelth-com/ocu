import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { FakeDriver } from "./fakeDriver.js";

const AUTH = { authorization: "Bearer secret-key" };

function build(driver = new FakeDriver()): FastifyInstance {
  return buildServer({ driver, apiKeys: ["secret-key"], version: "1.0.0" });
}

describe("GET /v1/shipments/:ocu_number/documents/:type", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("serves a PDF with inline Content-Disposition", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: "/v1/shipments/OCU-1001/documents/label",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toBe(
      'inline; filename="OCU-1001-label.pdf"',
    );
    expect(res.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("accepts the order and confirmation types", async () => {
    app = build();
    for (const type of ["order", "confirmation"] as const) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/shipments/OCU-1001/documents/${type}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-disposition"]).toBe(
        `inline; filename="OCU-1001-${type}.pdf"`,
      );
    }
  });

  it("the /label alias returns the label document", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: "/v1/shipments/OCU-1001/label",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toBe(
      'inline; filename="OCU-1001-label.pdf"',
    );
  });

  it("400 for an unknown document type", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: "/v1/shipments/OCU-1001/documents/invoice",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("404 envelope for an unknown shipment", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: "/v1/shipments/OCU-NOPE/documents/label",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("502 envelope when the driver fails", async () => {
    app = build(new FakeDriver({ failUpstream: true }));
    const res = await app.inject({
      method: "GET",
      url: "/v1/shipments/OCU-1001/documents/label",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("upstream_portal_error");
  });

  it("401 when unauthenticated", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: "/v1/shipments/OCU-1001/documents/label",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });
});
