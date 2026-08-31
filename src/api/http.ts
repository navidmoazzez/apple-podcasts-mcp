/**
 * The one HTTP path every network call goes through.
 *
 * Four hosts, one set of rules: a deadline, a spacing gap, bounded retries with
 * jitter, and a short in-memory cache.
 *
 * **The spacing gap is the important one.** Apple throttles the Search API by
 * IP at roughly twenty calls a minute, with no header announcing it and no
 * quota endpoint to check. A model asked "where does this show rank" will
 * happily fan out eight storefronts at once, trip the limit, and get 403s that
 * look like the show not existing. Requests are therefore serialised behind a
 * minimum interval, so a burst of parallel tool calls becomes a queue instead
 * of a thundering herd.
 *
 * **The cache is small and short on purpose.** Charts move hourly and the
 * catalog moves daily, so five minutes is generous. Its real job is not speed:
 * it is that answering "compare these six shows" pulls the same chart six
 * times, and one cached copy is the difference between one request and six
 * against a limit this tight.
 *
 * `fetchImpl` is injectable so tests exercise all of this without a network.
 * A test that needs the internet is a test nobody runs.
 */

import type { Config } from "../config.js";
import { AppleError, TimeoutError, errorFor, isRetryable } from "./errors.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type CacheEntry = { at: number; value: unknown };

export type RequestOptions = {
  /** Query parameters. Undefined and empty values are dropped, not sent blank. */
  params?: Record<string, string | number | undefined>;
  /** Skip the cache for this call. */
  fresh?: boolean;
  /** Parse as text rather than JSON, for RSS. */
  text?: boolean;
  /** Named in error messages so a failure says which source it came from. */
  surface?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
};

export class HttpClient {
  private readonly config: Config;
  private readonly fetchImpl: FetchLike;
  private readonly cache = new Map<string, CacheEntry>();
  /** Tail of the request queue. Each call waits for the one before it. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(config: Config, fetchImpl: FetchLike = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Fetch a URL, cached and throttled.
   *
   * Returns parsed JSON, or the raw string when `text` is set.
   */
  async get<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const full = withParams(url, options.params);
    const key = `${options.method ?? "GET"} ${full}`;

    if (!options.fresh && !options.method) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < this.config.cacheTtlMs) return hit.value as T;
    }

    const value = await this.enqueue(() => this.attempt<T>(full, options));

    if (!options.method) {
      this.cache.set(key, { at: Date.now(), value });
      // Unbounded growth would be a slow leak in a long-lived server. The cap is
      // far above any single conversation's working set.
      if (this.cache.size > 500) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) this.cache.delete(oldest.value);
      }
    }
    return value;
  }

  /** Serialise every request behind the configured minimum interval. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const gap = this.config.minRequestIntervalMs - (Date.now() - this.lastRequestAt);
      if (gap > 0) await sleep(gap);
      this.lastRequestAt = Date.now();
      return task();
    });
    // The queue must keep moving even when a call rejects, or one failure
    // deadlocks every request behind it for the life of the process.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async attempt<T>(url: string, options: RequestOptions): Promise<T> {
    let lastError: unknown;

    for (let tryNumber = 0; tryNumber <= this.config.maxRetries; tryNumber++) {
      if (tryNumber > 0) {
        // Exponential with jitter. Without the jitter, several tools that
        // started together retry together and trip the same limit again.
        const base = Math.min(1000 * 2 ** (tryNumber - 1), 8000);
        await sleep(base + Math.random() * 250);
      }

      try {
        return await this.once<T>(url, options);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) throw error;
      }
    }
    throw lastError;
  }

  private async once<T>(url: string, options: RequestOptions): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        signal: controller.signal,
        body: options.body,
        headers: {
          "User-Agent": this.config.userAgent,
          Accept: options.text ? "application/rss+xml, application/xml, text/xml, */*" : "application/json",
          ...options.headers,
        },
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        throw new TimeoutError(
          `No response from ${hostOf(url)} within ${this.config.requestTimeoutMs}ms. Raise APPLE_PODCASTS_REQUEST_TIMEOUT_MS if the host is simply slow.`,
          0,
          hostOf(url),
          { surface: options.surface },
        );
      }
      throw new AppleError(
        `Could not reach ${hostOf(url)}: ${(error as Error)?.message ?? String(error)}`,
        0,
        hostOf(url),
        { surface: options.surface },
      );
    } finally {
      clearTimeout(timer);
    }

    const body = await response.text();

    if (!response.ok) {
      throw errorFor(response.status, hostOf(url), body, options.surface);
    }

    if (options.text) return body as unknown as T;

    try {
      return JSON.parse(body) as T;
    } catch {
      // Apple's reviews RSS answers with an HTML error page under a JSON path
      // when the show id is not a podcast, so this is a real case rather than a
      // defensive branch that never fires.
      throw new AppleError(
        `${hostOf(url)} returned a response that is not JSON. This usually means the id is not an Apple Podcasts show, or Apple served an error page.`,
        response.status,
        hostOf(url),
        { surface: options.surface, detail: body.slice(0, 200) },
      );
    }
  }
}

function withParams(url: string, params?: Record<string, string | number | undefined>): string {
  if (!params) return url;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  if (!parts.length) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
