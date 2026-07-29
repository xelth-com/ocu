import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { extractBearer, isAuthorized } from "../src/auth.js";
import { buildServer } from "../src/server.js";
import { FakeDriver } from "./fakeDriver.js";

describe("extractBearer", () => {
  it("pulls the token from a well-formed header", () => {
    expect(extractBearer("Bearer abc123")).toBe("abc123");
    expect(extractBearer("bearer abc123")).toBe("abc123"); // case-insensitive
  });

  it("returns null for missing or malformed headers", () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer("")).toBeNull();
    expect(extractBearer("abc123")).toBeNull();
    expect(extractBearer("Basic abc123")).toBeNull();
    expect(extractBearer("Bearer ")).toBeNull();
  });
});

describe("isAuthorized", () => {
  const keys = new Set(["key-one", "key-two"]);
  it("accepts a known key and rejects the rest", () => {
    expect(isAuthorized("Bearer key-one", keys)).toBe(true);
    expect(isAuthorized("Bearer key-two", keys)).toBe(true);
    expect(isAuthorized("Bearer nope", keys)).toBe(false);
    expect(isAuthorized(undefined, keys)).toBe(false);
  });
});

describe("auth over HTTP", () => {
  let app: FastifyInstance;
  const build = () =>
    buildServer({ driver: new FakeDriver(), apiKeys: ["secret-key"], version: "9.9.9" });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("/v1/health is public (no key needed)", async () => {
    app = build();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      service: "ocu-api",
      driver: "scraper",
      version: "9.9.9",
    });
  });

  it("rejects an authenticated route without a key (401 envelope)", async () => {
    app = build();
    const res = await app.inject({ method: "GET", url: "/v1/shipments" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });

  it("rejects a wrong key", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: "/v1/shipments",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a valid key", async () => {
    app = build();
    const res = await app.inject({
      method: "GET",
      url: "/v1/shipments",
      headers: { authorization: "Bearer secret-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shipments).toHaveLength(1);
    expect(res.json().next_cursor).toBeNull();
  });
});
