import type { AppConfig, DriverName } from "../config.js";
import { DbSource } from "./db.js";
import { ScraperSource } from "./scraper.js";
import type { OcuSource } from "./types.js";

export { DbSource } from "./db.js";
export { ScraperSource } from "./scraper.js";
export type * from "./types.js";

/**
 * Build the active backend driver from config. This is the single point where
 * the API decides between the headless-browser adapter and the (future) native
 * DB driver — nothing downstream knows or cares which one it got.
 */
export function createDriver(cfg: AppConfig): OcuSource {
  const name: DriverName = cfg.driver;
  switch (name) {
    case "scraper":
      return new ScraperSource({
        url: cfg.opal.url,
        username: cfg.opal.username,
        password: cfg.opal.password,
        userDataDir: cfg.opal.userDataDir,
        debug: process.env.OPAL_DEBUG === "1",
      });
    case "db":
      return new DbSource();
    default: {
      // exhaustiveness guard — TS will error here if DriverName grows a case
      const _never: never = name;
      throw new Error(`Unknown driver: ${String(_never)}`);
    }
  }
}
