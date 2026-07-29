import { describe, it, expect } from "vitest";
import type { AppConfig } from "../src/config.js";
import { createDriver, DbSource, ScraperSource } from "../src/drivers/index.js";

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 38300,
    driver: "scraper",
    apiKeys: ["k"],
    opal: {
      url: "https://example.invalid",
      username: "u",
      password: "p",
      userDataDir: ".browser-data",
    },
    version: "0.0.0",
    ...overrides,
  };
}

describe("createDriver", () => {
  it("returns ScraperSource for driver=scraper", () => {
    expect(createDriver(cfg({ driver: "scraper" }))).toBeInstanceOf(ScraperSource);
  });

  it("returns DbSource for driver=db", () => {
    expect(createDriver(cfg({ driver: "db" }))).toBeInstanceOf(DbSource);
  });
});

describe("DbSource stub", () => {
  const db = new DbSource();

  it("reports its driver name from health()", async () => {
    expect(await db.health()).toEqual({ driver: "db" });
  });

  it("throws not-implemented for every data method", async () => {
    await expect(db.listShipments(50)).rejects.toThrow(/not implemented/i);
    await expect(db.getShipment("OCU-1")).rejects.toThrow(/not implemented/i);
    await expect(
      db.createShipment({
        sender_address: { name1: "A", zip: "1", city: "X" },
        receiver_address: { name1: "B", zip: "2", city: "Y" },
      }),
    ).rejects.toThrow(/not implemented/i);
    await expect(db.getDocument("OCU-1", "label")).rejects.toThrow(/not implemented/i);
  });
});
