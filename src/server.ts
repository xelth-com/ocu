import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { loadConfig, loadDotEnv } from "./config.js";
import { makeAuthHook } from "./auth.js";
import { ApiError, InvalidRequestError, NotFoundError } from "./errors.js";
import { parseLimit } from "./cursor.js";
import { createDriver } from "./drivers/index.js";
import type { CreateShipmentInput, DocumentType, OcuSource } from "./drivers/types.js";

export interface ServerDeps {
  driver: OcuSource;
  apiKeys: readonly string[];
  version: string;
}

/** Validate the POST /v1/shipments body into a CreateShipmentInput. */
function validateCreateInput(body: unknown): CreateShipmentInput {
  if (typeof body !== "object" || body === null) {
    throw new InvalidRequestError("Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;

  const address = (value: unknown, field: string) => {
    if (typeof value !== "object" || value === null) {
      throw new InvalidRequestError(`"${field}" is required and must be an object.`);
    }
    const a = value as Record<string, unknown>;
    for (const key of ["name1", "zip", "city"] as const) {
      if (typeof a[key] !== "string" || (a[key] as string).length === 0) {
        throw new InvalidRequestError(`"${field}.${key}" is required and must be a non-empty string.`);
      }
    }
    return {
      name1: a.name1 as string,
      street: typeof a.street === "string" ? a.street : undefined,
      house_number: typeof a.house_number === "string" ? a.house_number : undefined,
      zip: a.zip as string,
      city: a.city as string,
    };
  };

  if (b.weight !== undefined && typeof b.weight !== "number") {
    throw new InvalidRequestError(`"weight" must be a number (kg).`);
  }

  return {
    sender_address: address(b.sender_address, "sender_address"),
    receiver_address: address(b.receiver_address, "receiver_address"),
    weight: b.weight as number | undefined,
    ref_number: typeof b.ref_number === "string" ? b.ref_number : undefined,
    order_number: typeof b.order_number === "string" ? b.order_number : undefined,
  };
}

const DOCUMENT_TYPES = ["label", "order", "confirmation"] as const;

/** Validate the `:type` path segment into a DocumentType (→ 400 otherwise). */
function parseDocumentType(raw: string): DocumentType {
  if ((DOCUMENT_TYPES as readonly string[]).includes(raw)) {
    return raw as DocumentType;
  }
  throw new InvalidRequestError(
    `Invalid document type "${raw}" — expected one of ${DOCUMENT_TYPES.join(", ")}.`,
  );
}

/** Header-safe filename token: keep only benign characters. */
function safeFilenamePart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/**
 * Resolve a shipment document via the driver and stream it as a PDF, with the
 * standard inline Content-Disposition. Driver errors (NotFound / Upstream) keep
 * the JSON envelope because they are thrown, not caught, here.
 */
async function sendDocument(
  driver: OcuSource,
  reply: FastifyReply,
  ocu_number: string,
  type: DocumentType,
): Promise<void> {
  const doc = await driver.getDocument(ocu_number, type);
  const filename = `${safeFilenamePart(ocu_number)}-${type}.pdf`;
  reply
    .status(200)
    .header("Content-Type", doc.contentType || "application/pdf")
    .header("Content-Disposition", `inline; filename="${filename}"`)
    .send(doc.bytes);
}

/**
 * Build the Fastify app around an injected driver + key set. Kept dependency-
 * injected so tests can drive it with a fake OcuSource and no live portal.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    // Trust proxy is off by default; enable via env only where a reverse proxy
    // terminates TLS in front of the service.
    trustProxy: process.env.TRUST_PROXY === "1",
  });

  // ── central error envelope: { error: { code, message } } ────────────────
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      reply.status(err.statusCode).send(err.toBody());
      return;
    }
    // Fastify validation / body-parse errors carry a 4xx statusCode.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      reply.status(status).send({
        error: { code: "invalid_request", message: err.message },
      });
      return;
    }
    req.log.error(err);
    reply.status(500).send({
      error: { code: "internal_error", message: "Internal server error." },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: "not_found", message: `Route ${req.method} ${req.url} not found.` },
    });
  });

  // ── public: health ───────────────────────────────────────────────────────
  app.get("/v1/health", async () => {
    const { driver } = await deps.driver.health();
    return { ok: true, service: "ocu-api", driver, version: deps.version };
  });

  // ── authenticated scope ────────────────────────────────────────────────
  app.register(async (scope) => {
    scope.addHook("onRequest", makeAuthHook(deps.apiKeys));

    scope.get("/v1/shipments", async (req, reply) => {
      const q = req.query as { limit?: string; cursor?: string };
      const limit = parseLimit(q.limit);
      const cursor = q.cursor && q.cursor.length > 0 ? q.cursor : undefined;
      const result = await deps.driver.listShipments(limit, cursor);
      reply.status(200).send(result);
    });

    scope.get("/v1/shipments/:ocu_number", async (req, reply) => {
      const { ocu_number } = req.params as { ocu_number: string };
      const shipment = await deps.driver.getShipment(ocu_number);
      if (!shipment) throw new NotFoundError(`No shipment with ocu_number "${ocu_number}".`);
      reply.status(200).send(shipment);
    });

    scope.post("/v1/shipments", async (req, reply) => {
      const input = validateCreateInput(req.body);
      const shipment = await deps.driver.createShipment(input);
      reply.status(201).send(shipment);
    });

    // Document (PDF) retrieval. `type` ∈ label | order | confirmation.
    scope.get("/v1/shipments/:ocu_number/documents/:type", async (req, reply) => {
      const { ocu_number, type } = req.params as { ocu_number: string; type: string };
      await sendDocument(deps.driver, reply, ocu_number, parseDocumentType(type));
    });

    // Convenience alias: the label is the document most callers want.
    scope.get("/v1/shipments/:ocu_number/label", async (req, reply) => {
      const { ocu_number } = req.params as { ocu_number: string };
      await sendDocument(deps.driver, reply, ocu_number, "label");
    });
  });

  return app;
}

/** Process entry point: load env, build config + driver, listen. */
async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();

  if (cfg.apiKeys.length === 0) {
    // Fail loud: an empty key set would reject every request.
    throw new Error(
      "OCU_API_KEYS is empty — set at least one API key (comma-separated).",
    );
  }

  const driver = createDriver(cfg);
  const app = buildServer({
    driver,
    apiKeys: cfg.apiKeys,
    version: cfg.version,
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    if (driver.close) await driver.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  app.log.info(
    `ocu-api v${cfg.version} listening on :${cfg.port} (driver=${cfg.driver})`,
  );
}

// Run only when executed directly (not when imported by tests).
const isMain = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;

if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("fatal:", err);
    process.exit(1);
  });
}
