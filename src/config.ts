import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * Minimal `.env` loader. Reads KEY=VALUE lines from a `.env` file in the current
 * working directory into process.env WITHOUT overriding variables that are
 * already set (so real container/systemd env always wins). No external
 * dependency — deliberately tiny.
 */
export function loadDotEnv(file = ".env"): void {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return; // no .env file — that's fine, rely on real env
  }
  for (const line of contents.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    // strip surrounding matched quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export type DriverName = "scraper" | "db";

export interface AppConfig {
  port: number;
  driver: DriverName;
  apiKeys: string[];
  opal: {
    url: string;
    username: string;
    password: string;
    userDataDir: string;
    /** Account mandant ("ma") — optional; enables raw-orderval document lookups. */
    mandant?: string;
    /** Account client ("cl") — optional; enables raw-orderval document lookups. */
    client?: string;
  };
  version: string;
}

function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // dist/config.js and src/config.ts both sit one level below the package root
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Build the application config from process.env. Call after loadDotEnv(). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const driverRaw = (env.DRIVER ?? "scraper").trim().toLowerCase();
  if (driverRaw !== "scraper" && driverRaw !== "db") {
    throw new Error(
      `Invalid DRIVER "${driverRaw}" — expected "scraper" or "db".`,
    );
  }

  const apiKeys = (env.OCU_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  const port = Number.parseInt(env.PORT ?? "38300", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT "${env.PORT}".`);
  }

  return {
    port,
    driver: driverRaw,
    apiKeys,
    opal: {
      url: env.OPAL_URL ?? "https://opal-kurier.de",
      username: env.OPAL_USERNAME ?? "",
      password: env.OPAL_PASSWORD ?? "",
      userDataDir: env.OPAL_USER_DATA_DIR ?? ".browser-data",
      mandant: env.OPAL_MANDANT || undefined,
      client: env.OPAL_CLIENT || undefined,
    },
    version: readPackageVersion(),
  };
}
