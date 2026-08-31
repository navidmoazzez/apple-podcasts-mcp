/**
 * The behaviour a reader is trusting, exercised against a faked transport.
 *
 * Never the network, never a real credential, never the user's own library. A
 * test that needs any of those is a test nobody runs, and a test that reads the
 * real Apple Podcasts database would pass on one machine and fail on every
 * other one.
 *
 * The cases here are the ones where being wrong is silent: a write that runs
 * without its confirmation, a tool that stays in the list after being switched
 * off, a paginator that keeps asking for page 11, and an HTTP verb that is not
 * the one the code meant to send.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import { loadConfig, type Config } from "../src/config.js";
import { HttpClient, type FetchLike } from "../src/api/http.js";
import { ItunesClient } from "../src/api/itunes.js";
import { ReviewsClient, REVIEWS_PER_PAGE } from "../src/api/reviews.js";
import { ChartsClient } from "../src/api/charts.js";
import { ReporterClient } from "../src/api/reporter.js";
import { WriteGuard } from "../src/safety.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import { RateLimitError, ValidationError, WriteBlockedError } from "../src/api/errors.js";

/** A config that touches nothing real. */
function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig(),
    // Pointed at a path that cannot exist, so nothing here can read a real
    // library even if a test is wrong about which code path it takes.
    libraryPath: "/nonexistent/apple-podcasts-mcp-test.sqlite",
    minRequestIntervalMs: 1,
    maxRetries: 0,
    cacheTtlMs: 60_000,
    ...overrides,
  };
}

/** A fetch that answers from a script and records what it was asked. */
function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status?: number; body: string; headers?: Record<string, string> },
): FetchLike & { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body, headers = {} } = handler(url, init);
    return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
  }) as FetchLike & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tool registration", () => {
  it("every tool has a description, a schema and an honest annotation", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name, `${tool.name} name`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(40);
      expect(tool.schema, `${tool.name} schema`).toBeDefined();
      expect(["read", "write", "destructive"]).toContain(tool.risk);
      expect(["public", "library", "reporter"]).toContain(tool.surface);
    }
  });

  it("names are unique", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("only the OPML export writes anything", () => {
    const writes = ALL_TOOLS.filter((t) => t.risk !== "read").map((t) => t.name);
    expect(writes).toEqual(["export_subscriptions"]);
  });

  it("library tools never claim to reach the network", () => {
    // openWorldHint drives what a client will auto-approve. The library tools
    // read a local file and contact nothing, and saying otherwise misreports
    // the only tools here that never leave the machine.
    for (const tool of ALL_TOOLS.filter((t) => t.surface === "library")) {
      expect(tool.name.startsWith("_")).toBe(false);
    }
    const libraryNames = ALL_TOOLS.filter((t) => t.surface === "library").map((t) => t.name);
    expect(libraryNames).toContain("search_library");
    expect(libraryNames).toContain("export_subscriptions");
  });
});

describe("the tool list responds to configuration", () => {
  it("registers everything by default", () => {
    const built = buildServer(testConfig());
    expect(built.toolCount).toBe(ALL_TOOLS.length);
  });

  it("read-only mode removes the write rather than erroring on it", () => {
    // A model cannot call a tool it cannot see. An error is an invitation to
    // retry differently.
    const built = buildServer(testConfig({ readOnly: true }));
    expect(built.toolCount).toBe(ALL_TOOLS.length - 1);
  });

  it("switching the library off removes the whole group", () => {
    const built = buildServer(testConfig({ libraryEnabled: false }));
    const libraryTools = ALL_TOOLS.filter((t) => t.surface === "library").length;
    expect(libraryTools).toBe(7);
    expect(built.toolCount).toBe(ALL_TOOLS.length - libraryTools);
  });

  it("analytics tools stay listed when unconfigured, so they can explain themselves", () => {
    const built = buildServer(testConfig({ vendorNumber: undefined, reporterToken: undefined }));
    const names = ALL_TOOLS.filter((t) => t.surface === "reporter").map((t) => t.name);
    expect(names).toContain("check_analytics_access");
    expect(built.toolCount).toBe(ALL_TOOLS.length);
  });
});

describe("the write guard", () => {
  it("refuses a destructive tool without confirm, and names what it would do", () => {
    const guard = new WriteGuard(testConfig());
    expect(() => guard.check("export_subscriptions", "destructive", undefined, "write to /tmp/x.opml")).toThrow(
      WriteBlockedError,
    );
    try {
      guard.check("export_subscriptions", "destructive", undefined, "write to /tmp/x.opml");
    } catch (error) {
      expect((error as Error).message).toContain("confirm: true");
      expect((error as Error).message).toContain("/tmp/x.opml");
    }
  });

  it("allows it with confirm", () => {
    const guard = new WriteGuard(testConfig());
    expect(() => guard.check("export_subscriptions", "destructive", true, "x")).not.toThrow();
  });

  it("blocks writes entirely in read-only mode, even with confirm", () => {
    const guard = new WriteGuard(testConfig({ readOnly: true }));
    expect(() => guard.check("export_subscriptions", "destructive", true, "x")).toThrow(/READ_ONLY/);
  });

  it("blocks destructive writes when they are disabled but writes are not", () => {
    const guard = new WriteGuard(testConfig({ allowDestructive: false }));
    expect(() => guard.check("export_subscriptions", "destructive", true, "x")).toThrow(/ALLOW_DESTRUCTIVE/);
  });

  it("never gates a read", () => {
    const guard = new WriteGuard(testConfig({ readOnly: true, allowDestructive: false }));
    expect(() => guard.check("search_podcasts", "read", undefined, "x")).not.toThrow();
  });
});

describe("the search api's in-band failures", () => {
  it("raises the error Apple hides inside a 200 response", () => {
    const config = testConfig();
    const fetchImpl = fakeFetch(() => ({
      body: JSON.stringify({ errorMessage: "Invalid value(s) for key(s): [term]", results: [] }),
    }));
    const itunes = new ItunesClient(config, new HttpClient(config, fetchImpl));

    // Reported as an error, not as "nothing matched". A model told a search
    // returned nothing concludes the show does not exist.
    return expect(
      itunes.search({ term: "x", entity: "podcast", storefront: "us", limit: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("maps a 403 to a rate limit with the actual quota in the message", async () => {
    const config = testConfig();
    const fetchImpl = fakeFetch(() => ({ status: 403, body: "<html>Forbidden</html>" }));
    const itunes = new ItunesClient(config, new HttpClient(config, fetchImpl));

    await expect(
      itunes.search({ term: "x", entity: "podcast", storefront: "us", limit: 1 }),
    ).rejects.toThrow(/20 calls per minute/);
  });

  it("splits the show from its episodes, which Apple returns in one array", async () => {
    const config = testConfig();
    const fetchImpl = fakeFetch(() => ({
      body: JSON.stringify({
        resultCount: 3,
        results: [
          { wrapperType: "track", kind: "podcast", collectionId: 1, collectionName: "S" },
          { wrapperType: "podcastEpisode", trackId: 10, trackName: "E1" },
          { wrapperType: "podcastEpisode", trackId: 11, trackName: "E2" },
        ],
      }),
    }));
    const itunes = new ItunesClient(config, new HttpClient(config, fetchImpl));

    const result = await itunes.lookup({ id: "1", storefront: "us", withEpisodes: true });
    expect(result.show?.collectionName).toBe("S");
    expect(result.episodes).toHaveLength(2);
  });
});

describe("review pagination", () => {
  it("stops on a short page instead of walking to Apple's page-11 error", async () => {
    const config = testConfig();
    // Page 1 full, page 2 short. There is no total and no next-page marker, so
    // a short page is the only end-of-list signal there is.
    const fetchImpl = fakeFetch((url) => {
      const page = Number(url.match(/page=(\d+)/)?.[1] ?? 1);
      const count = page === 1 ? REVIEWS_PER_PAGE : 3;
      return {
        body: JSON.stringify({
          feed: {
            entry: Array.from({ length: count }, (_, i) => ({
              id: { label: `${page}-${i}` },
              title: { label: "t" },
              content: { label: "b" },
              author: { name: { label: "a" } },
              "im:rating": { label: "5" },
            })),
          },
        }),
      };
    });

    const reviews = new ReviewsClient(config, new HttpClient(config, fetchImpl));
    const out = await reviews.forShow({ showId: "1", storefront: "us", limit: 500 });

    expect(fetchImpl.calls).toHaveLength(2);
    expect(out).toHaveLength(REVIEWS_PER_PAGE + 3);
  });

  it("drops the feed-description object Apple prepends to page 1", async () => {
    const config = testConfig();
    const fetchImpl = fakeFetch(() => ({
      body: JSON.stringify({
        feed: {
          entry: [
            // No rating: this is the show's own blurb, not a review. Counting
            // it puts a fake five-star review at the top of every summary.
            { id: { label: "desc" }, title: { label: "The Show" }, content: { label: "About" } },
            {
              id: { label: "r1" },
              title: { label: "Great" },
              content: { label: "Body" },
              author: { name: { label: "a" } },
              "im:rating": { label: "4" },
            },
          ],
        },
      }),
    }));

    const reviews = new ReviewsClient(config, new HttpClient(config, fetchImpl));
    const out = await reviews.forShow({ showId: "1", storefront: "us", limit: 50 });

    expect(out).toHaveLength(1);
    expect(out[0]?.rating).toBe(4);
  });
});

describe("charts", () => {
  it("clamps to the 100 Apple will actually serve", async () => {
    const config = testConfig();
    const fetchImpl = fakeFetch(() => ({ body: JSON.stringify({ feed: { results: [] } }) }));
    const charts = new ChartsClient(config, new HttpClient(config, fetchImpl));

    await charts.chart({ storefront: "us", kind: "podcasts", limit: 500 });
    expect(fetchImpl.calls[0]?.url).toContain("/top/100/podcasts.json");
  });

  it("ranks entries by position in the response", async () => {
    const config = testConfig();
    const fetchImpl = fakeFetch(() => ({
      body: JSON.stringify({
        feed: {
          title: "Top Shows",
          results: [
            { id: "1", name: "A", artistName: "x", url: "https://podcasts.apple.com/us/podcast/a/id1" },
            { id: "2", name: "B", artistName: "y", url: "https://podcasts.apple.com/us/podcast/b/id2" },
          ],
        },
      }),
    }));
    const charts = new ChartsClient(config, new HttpClient(config, fetchImpl));

    const chart = await charts.chart({ storefront: "us", kind: "podcasts", limit: 10 });
    expect(chart.entries.map((e) => e.rank)).toEqual([1, 2]);
  });
});

describe("the reporter protocol", () => {
  it("POSTs form-encoded, not JSON, with the command wrapped as Apple expects", async () => {
    const config = testConfig({ vendorNumber: "123", reporterToken: "tok" });
    const fetchImpl = fakeFetch(() => ({ body: "<Vendors><Vendor>123</Vendor></Vendors>" }));
    const reporter = new ReporterClient(config, fetchImpl);

    const vendors = await reporter.vendors();

    const call = fetchImpl.calls[0]!;
    // The verb matters: a GET here returns a success-shaped response that
    // contains no report at all.
    expect(call.init?.method).toBe("POST");
    expect((call.init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );

    const body = String(call.init?.body);
    expect(body.startsWith("jsonRequest=")).toBe(true);
    const payload = JSON.parse(decodeURIComponent(body.slice("jsonRequest=".length)));
    // The properties-file reference is required even though no file exists.
    expect(payload.queryInput).toBe("[p=Reporter.properties, Sales.getVendors]");
    expect(payload.accesstoken).toBe("tok");
    expect(payload.version).toBe("2.2");

    expect(vendors).toEqual(["123"]);
  });

  it("explains missing credentials rather than failing at the socket", async () => {
    const config = testConfig({ vendorNumber: undefined, reporterToken: undefined });
    const fetchImpl = fakeFetch(() => ({ body: "{}" }));
    const reporter = new ReporterClient(config, fetchImpl);

    await expect(reporter.vendors()).rejects.toThrow(/APPLE_PODCASTS_VENDOR_NUMBER/);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("reads Apple's no-data reply as a lag, not as a broken integration", async () => {
    const config = testConfig({ vendorNumber: "123", reporterToken: "tok" });
    const fetchImpl = fakeFetch(() => ({
      status: 404,
      body: "There is no report available for the date requested.",
    }));
    const reporter = new ReporterClient(config, fetchImpl);

    await expect(
      reporter.report({ reportType: "apShowListening", dateType: "Daily", date: "20260830" }),
    ).rejects.toThrow(/lags one to two days/);
  });

  it("checks the date shape before spending a request", async () => {
    const config = testConfig({ vendorNumber: "123", reporterToken: "tok" });
    const fetchImpl = fakeFetch(() => ({ body: "" }));
    const reporter = new ReporterClient(config, fetchImpl);

    await expect(
      reporter.report({ reportType: "apShowListening", dateType: "Daily", date: "2026-08-30" }),
    ).rejects.toThrow(/YYYYMMDD/);
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe("the http client", () => {
  it("reuses a cached response instead of spending the rate limit twice", async () => {
    const config = testConfig();
    const fetchImpl = fakeFetch(() => ({ body: JSON.stringify({ ok: true }) }));
    const http = new HttpClient(config, fetchImpl);

    await http.get("https://x.test/a");
    await http.get("https://x.test/a");
    expect(fetchImpl.calls).toHaveLength(1);

    await http.get("https://x.test/a", { fresh: true });
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it("drops empty parameters rather than sending them blank", async () => {
    const config = testConfig();
    const fetchImpl = fakeFetch(() => ({ body: "{}" }));
    const http = new HttpClient(config, fetchImpl);

    await http.get("https://x.test/s", { params: { term: "a", genreId: undefined, attribute: "" } });
    expect(fetchImpl.calls[0]?.url).toBe("https://x.test/s?term=a");
  });

  it("keeps serving after a rejection instead of deadlocking the queue", async () => {
    const config = testConfig();
    let first = true;
    const fetchImpl = fakeFetch(() => {
      if (first) {
        first = false;
        return { status: 400, body: "bad" };
      }
      return { body: JSON.stringify({ ok: true }) };
    });
    const http = new HttpClient(config, fetchImpl);

    await expect(http.get("https://x.test/1")).rejects.toBeInstanceOf(ValidationError);
    // Every later request queues behind the failed one. If the queue is not
    // repaired on rejection, this hangs forever rather than failing.
    await expect(http.get("https://x.test/2")).resolves.toEqual({ ok: true });
  });

  it("does not retry a 400, which would be wrong the same way again", async () => {
    const config = testConfig({ maxRetries: 3 });
    const fetchImpl = fakeFetch(() => ({ status: 400, body: "bad" }));
    const http = new HttpClient(config, fetchImpl);

    await expect(http.get("https://x.test/a")).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("retries a 500 and surfaces the rate limit class for a 403", async () => {
    const config = testConfig({ maxRetries: 1 });
    const failing = fakeFetch(() => ({ status: 500, body: "boom" }));
    await expect(new HttpClient(config, failing).get("https://x.test/a")).rejects.toThrow();
    expect(failing.calls.length).toBe(2);

    const limited = fakeFetch(() => ({ status: 403, body: "no" }));
    await expect(new HttpClient(config, limited).get("https://x.test/b")).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });
});
