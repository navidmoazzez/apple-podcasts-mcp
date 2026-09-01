/**
 * Settings, and the four surfaces this server reaches.
 *
 * Apple Podcasts is not one API. It is four sources that share a brand and
 * nothing else, and the shape of this file follows from that:
 *
 *   1. the public catalog        itunes.apple.com, no credential at all
 *   2. charts and reviews        rss.marketingtools.apple.com and the reviews
 *                                RSS, also no credential
 *   3. your own library          a SQLite file on this Mac, no credential, and
 *                                unreachable from anywhere else
 *   4. Apple Podcasts Connect    a vendor number and a Reporter access token,
 *                                only if you own a show
 *
 * So there is no single "am I connected" state. Most of the server works the
 * instant it starts, the library group works on a Mac that has the app, and the
 * analytics group works only for a show owner. Each tool reports which of those
 * it needed rather than the server refusing to start.
 *
 * The storefront is the one setting worth understanding. Apple's catalog,
 * charts and reviews are all per-country, and the same show has a different
 * rank and a different review pool in each. A default that silently means "us"
 * would quietly answer the wrong question for anyone outside it, so the
 * storefront is explicit everywhere and every result says which one it came
 * from.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  /** Two-letter storefront used when a tool does not name one. */
  storefront: string;
  /** Extra storefronts scanned by the cross-market tools. */
  storefronts: string[];

  /** Read the local Apple Podcasts library. Off removes the whole group. */
  libraryEnabled: boolean;
  /** The Core Data store the Podcasts app keeps its library in. */
  libraryPath: string;

  /** Apple Podcasts Connect vendor number, e.g. "1234567". */
  vendorNumber?: string;
  /** Reporter access token. Rotates every 180 days. */
  reporterToken?: string;

  readOnly: boolean;
  allowDestructive: boolean;

  requestTimeoutMs: number;
  minRequestIntervalMs: number;
  maxRetries: number;
  /** How long a catalog or chart response stays reusable in memory. */
  cacheTtlMs: number;

  itunesHost: string;
  chartsHost: string;
  reporterHost: string;
  userAgent: string;
  auditPath?: string;
};

export const DEFAULT_ITUNES_HOST = "https://itunes.apple.com";
export const DEFAULT_CHARTS_HOST = "https://rss.marketingtools.apple.com";
export const DEFAULT_REPORTER_HOST = "https://reportingitc-reporter.apple.com";

/**
 * Where the Podcasts app keeps its library.
 *
 * The group container id is Apple's and has been stable for years. It is not
 * derived from anything, so it is written out rather than guessed at.
 */
export function defaultLibraryPath(): string {
  return (
    process.env.APPLE_PODCASTS_LIBRARY_PATH ||
    join(
      homedir(),
      "Library",
      "Group Containers",
      "243LU875E5.groups.com.apple.podcasts",
      "Documents",
      "MTLibrary.sqlite",
    )
  );
}

/**
 * Storefronts are ISO 3166-1 alpha-2, lowercased.
 *
 * Apple accepts either case on the search API and only lowercase on the charts
 * host, so everything is normalized down rather than passed through.
 */
export function normalizeStorefront(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(t)) {
    throw new Error(
      `"${raw}" is not a storefront. Apple storefronts are two-letter country codes such as us, gb, se or de. Call list_storefronts for the ones this server knows.`,
    );
  }
  return t;
}

function normalizeHost(raw: string | undefined, fallback: string): string {
  const t = (raw ?? "").trim();
  if (!t) return fallback;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  return withScheme.replace(/\/+$/, "");
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(
      `[apple-podcasts-mcp] ${name}="${raw}" is not a positive number. Using ${fallback}.\n`,
    );
    return fallback;
  }
  return n;
}

/**
 * The extra markets the cross-storefront tools sweep.
 *
 * Apple publishes a chart for every storefront it operates, which is upwards of
 * 170. Sweeping all of them for one question is a minute of requests for an
 * answer nobody wanted that wide, so the default is the handful of markets that
 * carry most English-language podcast attention, and the list is replaceable.
 */
const DEFAULT_SWEEP = ["us", "gb", "ca", "au", "ie", "se", "de", "nl"];

function envStorefronts(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    if (!/^[a-z]{2}$/.test(t)) {
      process.stderr.write(
        `[apple-podcasts-mcp] ${name} contains "${part}", which is not a two-letter storefront. Skipping it.\n`,
      );
      continue;
    }
    if (!out.includes(t)) out.push(t);
  }
  return out.length ? out : fallback;
}

export function loadConfig(): Config {
  const storefront = (process.env.APPLE_PODCASTS_STOREFRONT || "us").trim().toLowerCase();

  return {
    storefront: /^[a-z]{2}$/.test(storefront) ? storefront : "us",
    storefronts: envStorefronts("APPLE_PODCASTS_STOREFRONTS", DEFAULT_SWEEP),

    libraryEnabled: envFlag("APPLE_PODCASTS_LIBRARY", true),
    libraryPath: defaultLibraryPath(),

    vendorNumber: process.env.APPLE_PODCASTS_VENDOR_NUMBER?.trim() || undefined,
    reporterToken: process.env.APPLE_PODCASTS_REPORTER_TOKEN?.trim() || undefined,

    readOnly: envFlag("APPLE_PODCASTS_READ_ONLY", false),
    allowDestructive: envFlag("APPLE_PODCASTS_ALLOW_DESTRUCTIVE", true),

    requestTimeoutMs: envInt("APPLE_PODCASTS_REQUEST_TIMEOUT_MS", 30_000),
    minRequestIntervalMs: envInt("APPLE_PODCASTS_MIN_REQUEST_INTERVAL_MS", 220),
    maxRetries: envInt("APPLE_PODCASTS_MAX_RETRIES", 3),
    cacheTtlMs: envInt("APPLE_PODCASTS_CACHE_TTL_MS", 300_000),

    itunesHost: normalizeHost(process.env.APPLE_PODCASTS_ITUNES_HOST, DEFAULT_ITUNES_HOST),
    chartsHost: normalizeHost(process.env.APPLE_PODCASTS_CHARTS_HOST, DEFAULT_CHARTS_HOST),
    reporterHost: normalizeHost(process.env.APPLE_PODCASTS_REPORTER_HOST, DEFAULT_REPORTER_HOST),
    userAgent: process.env.APPLE_PODCASTS_USER_AGENT || "apple-podcasts-mcp",
    auditPath: process.env.APPLE_PODCASTS_AUDIT_LOG || undefined,
  };
}

/** True when both halves of the Reporter credential are present. */
export function hasReporterCredentials(config: Config): boolean {
  return Boolean(config.vendorNumber && config.reporterToken);
}
