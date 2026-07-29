import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { FakeDriver } from "./fakeDriver.js";

const AUTH = { authorization: "Bearer secret-key" };

function build(driver = new FakeDriver()): FastifyInstance {
  return buildServer({ driver, apiKeys: ["secret-key"], version: "1.0.0" });
}

describe("error envelope { error: { code, message } }", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("404 for a known shipment id that does not exist", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: "/v1/shipments/OCU-DOES-NOT-EXIST",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("200 for a shipment that exists", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: "/v1/shipments/OCU-1001",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ocu_number).toBe("OCU-1001");
  });

  it("404 for an unknown route", async () => {
    app = build();
    const res = await app.inject({ method: "GET", url: "/nope", headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("400 for a missing create body", async () => {
    app = build();
    const res = await app.inject({ method: "POST", url: "/v1/shipments", headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("400 for an incomplete create body", async () => {
    app = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/shipments",
      headers: AUTH,
      payload: { sender_address: { name1: "A", zip: "1", city: "X" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("201 for a valid create body", async () => {
    app = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/shipments",
      headers: AUTH,
      payload: {
        sender_address: { name1: "Sender GmbH", street: "Hauptstr", house_number: "1", zip: "10115", city: "Berlin" },
        receiver_address: { name1: "Receiver AG", street: "Nebenstr", house_number: "2", zip: "80331", city: "München" },
        weight: 2.5,
        ref_number: "REF-123",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ocu_number).toBe("OCU-2002");
    expect(res.json().reference).toBe("REF-123");
  });

  it("400 for a malformed cursor (driver-owned validation)", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: "/v1/shipments?cursor=not-a-valid-cursor",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("502 upstream_portal_error when the driver fails", async () => {
    app = build(new FakeDriver({ failUpstream: true }));
    const res = await app.inject({ method: "GET", url: "/v1/shipments", headers: AUTH });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("upstream_portal_error");
  });

  it("health reflects the driver name", async () => {
    app = build(new FakeDriver({ driverName: "db" }));
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.json().driver).toBe("db");
  });
});
