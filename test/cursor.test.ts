import { describe, it, expect } from "vitest";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  parseCursor,
  parseLimit,
} from "../src/cursor.js";
import { ApiError } from "../src/errors.js";

describe("parseLimit", () => {
  it("defaults when missing or empty", () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(parseLimit("")).toBe(DEFAULT_LIMIT);
  });

  it("accepts a valid positive integer", () => {
    expect(parseLimit("10")).toBe(10);
  });

  it("caps at MAX_LIMIT", () => {
    expect(parseLimit("1000")).toBe(MAX_LIMIT);
  });

  it("rejects non-numeric, zero, negative, and fractional values", () => {
    for (const bad of ["abc", "0", "-5", "1.5", "50x"]) {
      expect(() => parseLimit(bad)).toThrow(ApiError);
    }
  });
});

describe("cursor encode/decode", () => {
  it("round-trips an offset", () => {
    const c = encodeCursor({ offset: 42 });
    expect(typeof c).toBe("string");
    expect(decodeCursor(c)).toEqual({ offset: 42 });
  });

  it("is opaque (not the raw number)", () => {
    const c = encodeCursor({ offset: 100 });
    expect(c).not.toContain("100");
  });

  it("parseCursor returns 0 when absent", () => {
    expect(parseCursor(undefined)).toBe(0);
    expect(parseCursor("")).toBe(0);
  });

  it("parseCursor decodes a valid cursor", () => {
    expect(parseCursor(encodeCursor({ offset: 7 }))).toBe(7);
  });

  it("rejects malformed cursors with a 400 ApiError", () => {
    for (const bad of ["not-base64!!", Buffer.from('{"o":-1}').toString("base64url"), Buffer.from('{"x":1}').toString("base64url"), Buffer.from("garbage").toString("base64url")]) {
      let thrown: unknown;
      try {
        decodeCursor(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).statusCode).toBe(400);
    }
  });
});
