/**
 * Error taxonomy for the OCU API. Every error surfaced to a client is one of
 * these, rendered as the JSON envelope { error: { code, message } } with the
 * matching HTTP status.
 */

export type ErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "not_found"
  | "upstream_portal_error"
  | "internal_error";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(statusCode: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }

  /** The wire representation: { error: { code, message } }. */
  toBody(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Missing or invalid API key.") {
    super(401, "unauthorized", message);
  }
}

export class InvalidRequestError extends ApiError {
  constructor(message: string) {
    super(400, "invalid_request", message);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "Resource not found.") {
    super(404, "not_found", message);
  }
}

/**
 * Raised by a backend driver when the upstream data source fails in a way the
 * caller cannot fix: portal unreachable, login rejected, page layout changed,
 * DB unavailable, etc. Always surfaces as HTTP 502.
 */
export class UpstreamPortalError extends ApiError {
  constructor(message: string) {
    super(502, "upstream_portal_error", message);
  }
}
