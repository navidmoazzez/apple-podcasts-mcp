/**
 * One class per way this server can fail, each carrying the fix.
 *
 * Four sources fail in four different dialects, and none of them is REST-shaped
 * in the way an error handler usually assumes:
 *
 * **The iTunes Search API answers 200 for failures.** A malformed query returns
 * HTTP 200 with `{"errorMessage": "Invalid value(s) for key(s): [term]"}` and no
 * results. Status-only handling reads that as an empty result set, and a model
 * told "no podcasts matched" concludes the show does not exist rather than that
 * the query was wrong. So the body is inspected on success, not only on failure.
 *
 * **It rate limits by IP with no header saying so.** Roughly twenty calls a
 * minute, answered with 403 and an HTML body. There is no `Retry-After` and no
 * quota endpoint, so the only honest thing is to name the limit in the message
 * and back off.
 *
 * **The charts host answers 404 for a storefront that does not exist**, which is
 * indistinguishable from a chart that is simply empty unless the code knows
 * which one it asked for.
 *
 * **A podcast's RSS feed is somebody else's server.** It can be slow, gone,
 * behind Cloudflare, or serving HTML with an XML content type. That failure is
 * not Apple's and the message should not imply it is.
 *
 * The point of all of this: a model that is told "you are rate limited, wait a
 * minute" retries correctly, and a model handed a bare string gives up.
 */

export class AppleError extends Error {
  readonly status: number;
  readonly endpoint: string;
  /** Which of the four sources produced this. */
  readonly surface: string;
  readonly detail: string;

  constructor(
    message: string,
    status: number,
    endpoint: string,
    parts: Partial<{ surface: string; detail: string }> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.endpoint = endpoint;
    this.surface = parts.surface ?? "apple";
    this.detail = parts.detail ?? "";
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      type: this.name,
      ...(this.status ? { status: this.status } : {}),
      endpoint: this.endpoint,
      surface: this.surface,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

/** Apple is throttling this IP. Unauthenticated and undocumented, but real. */
export class RateLimitError extends AppleError {}

/** The arguments were wrong. Retrying the same call will fail the same way. */
export class ValidationError extends AppleError {}

/** No such show, episode, storefront or chart. */
export class NotFoundError extends AppleError {}

/** 5xx from Apple, or from a podcast host. Usually transient. */
export class ServerError extends AppleError {}

/** Nothing arrived before our own deadline. */
export class TimeoutError extends AppleError {}

/** A podcast's own RSS host failed, or served something that is not a feed. */
export class FeedError extends AppleError {
  constructor(message: string, status: number, endpoint: string, detail = "") {
    super(message, status, endpoint, { surface: "feed", detail });
  }
}

/** The Apple Podcasts database is missing, locked, or unreadable. */
export class LibraryError extends AppleError {
  constructor(message: string, detail = "") {
    super(message, 0, "(local)", { surface: "library", detail });
  }
}

/** Apple Podcasts Connect rejected the vendor number or the Reporter token. */
export class ReporterError extends AppleError {
  constructor(message: string, status: number, detail = "") {
    super(message, status, "reporter", { surface: "reporter", detail });
  }
}

/** A guarded tool was called without `confirm`, or writes are switched off. */
export class WriteBlockedError extends AppleError {
  constructor(message: string) {
    super(message, 0, "(local)", { surface: "local" });
  }
}

/**
 * The iTunes Search API's in-band error, which arrives with HTTP 200.
 *
 * Returns the message when the body carries one, so the caller can fail loudly
 * instead of reporting an empty result set as an answer.
 */
export function inBandError(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as Record<string, unknown>).errorMessage;
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 300) : undefined;
}

/** Map a failed HTTP response from an Apple host onto the right class. */
export function errorFor(
  status: number,
  endpoint: string,
  body: string,
  surface = "apple",
): AppleError {
  const detail = body.trim().replace(/\s+/g, " ").slice(0, 300);

  // Apple throttles the Search API by IP and says so with a 403 and an HTML
  // body, never with 429 and never with a Retry-After header.
  if (status === 429 || status === 403) {
    return new RateLimitError(
      `Apple is rate limiting this IP address on ${endpoint}. The Search API allows roughly 20 calls per minute and does not publish a quota or a reset time. Wait about a minute, then retry. Batching several lookups into one call, or narrowing the storefront sweep, avoids it entirely.`,
      status,
      endpoint,
      { surface, detail },
    );
  }

  if (status === 404) {
    return new NotFoundError(
      `Not found at ${endpoint}. For a show, check the Apple id. For a chart or a review list, check the storefront: Apple returns 404 for a country it does not operate in, which looks the same as an empty chart.`,
      status,
      endpoint,
      { surface, detail },
    );
  }

  if (status === 400) {
    return new ValidationError(
      `Apple rejected the request to ${endpoint}. One of the arguments is not a shape it accepts.`,
      status,
      endpoint,
      { surface, detail },
    );
  }

  if (status >= 500) {
    return new ServerError(
      `Apple returned ${status} for ${endpoint}. This is upstream and usually transient.`,
      status,
      endpoint,
      { surface, detail },
    );
  }

  return new AppleError(
    `Apple returned ${status} for ${endpoint}.`,
    status,
    endpoint,
    { surface, detail },
  );
}

/** True when a failure is worth sending again. */
export function isRetryable(error: unknown): boolean {
  return (
    error instanceof ServerError ||
    error instanceof TimeoutError ||
    error instanceof RateLimitError
  );
}
