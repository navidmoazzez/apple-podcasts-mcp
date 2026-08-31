/**
 * The command that says what is actually broken.
 *
 * Integrations fail for about six reasons and all of them look identical from
 * inside an MCP client, which reports "the tool errored" and nothing else. This
 * probes each of the four sources separately, so the answer is "the library
 * needs Full Disk Access" rather than "something went wrong".
 *
 * Two probes here earn their place because they test assumptions this server
 * makes but cannot guarantee.
 *
 * The library probe reads the actual columns rather than only opening the file.
 * The schema is Apple's private Core Data store and it changes between releases
 * of the Podcasts app, so a database that opens fine can still be missing the
 * transcript column this server's best feature depends on. Finding that out
 * here beats finding it out through an empty search result.
 *
 * The rate-limit probe is deliberately a single request. Checking a rate limit
 * by exercising it would be the one diagnostic that causes the fault it is
 * looking for.
 */

import { existsSync } from "node:fs";
import { hasReporterCredentials, loadConfig, type Config } from "./config.js";
import { makeClients } from "./clients.js";
import { buildServer } from "./server.js";
import { openDatabase } from "./library/db.js";

type Check = {
  name: string;
  state: "ok" | "warn" | "fail" | "skip";
  detail: string;
};

const MARK: Record<Check["state"], string> = {
  ok: "  ok  ",
  warn: " warn ",
  fail: " fail ",
  skip: " skip ",
};

export async function runDoctor(): Promise<number> {
  const config = loadConfig();
  const checks: Check[] = [];

  const out = (line = ""): void => {
    process.stdout.write(`${line}\n`);
  };

  out(`apple-podcasts-mcp doctor`);
  out();

  checks.push(checkNode());
  checks.push(checkServer(config));
  checks.push(...(await checkCatalog(config)));
  checks.push(await checkCharts(config));
  checks.push(await checkReviews(config));
  checks.push(...(await checkLibrary(config)));
  checks.push(...(await checkAnalytics(config)));

  for (const check of checks) {
    out(`[${MARK[check.state]}] ${check.name}`);
    if (check.detail) {
      for (const line of check.detail.split("\n")) out(`         ${line}`);
    }
  }

  const failed = checks.filter((c) => c.state === "fail");
  const warned = checks.filter((c) => c.state === "warn");

  out();
  if (failed.length) {
    out(`${failed.length} check(s) failed, ${warned.length} warning(s).`);
    return 1;
  }
  out(
    warned.length
      ? `Everything essential works. ${warned.length} warning(s) above are optional features that are not configured.`
      : `Everything works.`,
  );
  return 0;
}

function checkNode(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    return {
      name: "Node version",
      state: "fail",
      detail: `Node ${process.versions.node}. This server needs Node 20 or newer.`,
    };
  }
  const minor = Number(process.versions.node.split(".")[1]);
  const hasNodeSqlite = major > 22 || (major === 22 && minor >= 5);
  return {
    name: "Node version",
    state: "ok",
    detail: hasNodeSqlite
      ? `Node ${process.versions.node}, which has built-in SQLite for reading the local library.`
      : `Node ${process.versions.node}. Below 22.5, so the local library is read through the sqlite3 command instead of built-in SQLite. Both work on macOS.`,
  };
}

function checkServer(config: Config): Check {
  try {
    const built = buildServer(config);
    return {
      name: "Server builds",
      state: "ok",
      detail: `${built.toolCount} tools registered.${
        config.libraryEnabled ? "" : " Library tools are hidden by APPLE_PODCASTS_LIBRARY=0."
      }${config.readOnly ? " Writes are hidden by APPLE_PODCASTS_READ_ONLY=1." : ""}`,
    };
  } catch (error) {
    return {
      name: "Server builds",
      state: "fail",
      detail: (error as Error).message,
    };
  }
}

async function checkCatalog(config: Config): Promise<Check[]> {
  const clients = makeClients(config);
  const checks: Check[] = [];

  try {
    const rows = await clients.itunes.search({
      term: "the daily",
      entity: "podcast",
      storefront: config.storefront,
      limit: 1,
    });
    checks.push({
      name: `Apple catalog (${config.storefront})`,
      state: rows.length ? "ok" : "warn",
      detail: rows.length
        ? `Reachable. Search returned "${rows[0]?.collectionName ?? "a result"}".`
        : `Reachable, but the test search returned nothing, which is unexpected for this storefront.`,
    });
  } catch (error) {
    const message = (error as Error).message;
    checks.push({
      name: `Apple catalog (${config.storefront})`,
      state: "fail",
      detail: /rate limit/i.test(message)
        ? `Rate limited. Apple allows roughly 20 requests a minute per IP. Wait a minute and run doctor again.\n${message}`
        : message,
    });
  }

  try {
    const tree = await clients.itunes.genres(config.storefront);
    checks.push({
      name: "Genre tree",
      state: tree?.subgenres.length ? "ok" : "warn",
      detail: tree?.subgenres.length
        ? `${tree.subgenres.length} top-level podcast genres.`
        : `Apple returned no genre tree for storefront "${config.storefront}".`,
    });
  } catch (error) {
    checks.push({ name: "Genre tree", state: "warn", detail: (error as Error).message });
  }

  return checks;
}

async function checkCharts(config: Config): Promise<Check> {
  const clients = makeClients(config);
  try {
    const chart = await clients.charts.chart({
      storefront: config.storefront,
      kind: "podcasts",
      limit: 5,
    });
    return {
      name: `Charts (${config.storefront})`,
      state: chart.entries.length ? "ok" : "warn",
      detail: chart.entries.length
        ? `Top Shows reachable. Number 1 is "${chart.entries[0]?.name}". Chart updated ${chart.updated ?? "unknown"}.`
        : `The chart came back empty, which usually means "${config.storefront}" is not a storefront Apple operates.`,
    };
  } catch (error) {
    return { name: `Charts (${config.storefront})`, state: "fail", detail: (error as Error).message };
  }
}

async function checkReviews(config: Config): Promise<Check> {
  const clients = makeClients(config);
  try {
    // The New York Times' The Daily. A show that exists in every storefront and
    // has reviews everywhere, so an empty result here means the endpoint, not
    // the show.
    const reviews = await clients.reviews.forShow({
      showId: "1200361736",
      storefront: config.storefront,
      limit: 3,
    });
    return {
      name: `Reviews (${config.storefront})`,
      state: reviews.length ? "ok" : "warn",
      detail: reviews.length
        ? `Reachable. Pulled ${reviews.length} review(s) from the test show.`
        : `The reviews endpoint answered but returned nothing for a show that should have reviews in every storefront.`,
    };
  } catch (error) {
    return {
      name: `Reviews (${config.storefront})`,
      state: "warn",
      detail: `${(error as Error).message}\nThe reviews feed is an older Apple endpoint and is flakier than the rest. Everything else still works.`,
    };
  }
}

async function checkLibrary(config: Config): Promise<Check[]> {
  if (!config.libraryEnabled) {
    return [
      {
        name: "Local library",
        state: "skip",
        detail: "Switched off with APPLE_PODCASTS_LIBRARY=0.",
      },
    ];
  }

  if (process.platform !== "darwin") {
    return [
      {
        name: "Local library",
        state: "skip",
        detail: `The Apple Podcasts library exists only on macOS, and this is ${process.platform}. Everything else in this server works here.`,
      },
    ];
  }

  if (!existsSync(config.libraryPath)) {
    return [
      {
        name: "Local library",
        state: "warn",
        detail: `No database at ${config.libraryPath}\nIt is created the first time the Podcasts app runs and follows a show. Set APPLE_PODCASTS_LIBRARY_PATH if yours is elsewhere, or APPLE_PODCASTS_LIBRARY=0 to hide these tools.`,
      },
    ];
  }

  const checks: Check[] = [];

  try {
    const db = await openDatabase(config.libraryPath);
    try {
      const shows = db.query("select count(*) as n from ZMTPODCAST")[0]?.n ?? 0;
      const episodes = db.query("select count(*) as n from ZMTEPISODE")[0]?.n ?? 0;

      checks.push({
        name: "Local library",
        state: "ok",
        detail: `${shows} show(s), ${episodes} episode(s) at ${config.libraryPath}`,
      });

      // The schema is Apple's private store and changes between app releases.
      // A library that opens but has lost this column would silently return no
      // transcript matches, which is the worst kind of failure.
      try {
        const withSnippet =
          db.query(
            "select count(*) as n from ZMTEPISODE where ZFREETRANSCRIPTSNIPPET is not null",
          )[0]?.n ?? 0;
        checks.push({
          name: "Cached transcript excerpts",
          state: Number(withSnippet) > 0 ? "ok" : "warn",
          detail: Number(withSnippet) > 0
            ? `${withSnippet} episode(s) carry a cached transcript excerpt, which is what search_library searches.`
            : `The transcript column exists but nothing is in it. Apple populates these as the app syncs, so a new library may simply not have them yet.`,
        });
      } catch {
        checks.push({
          name: "Cached transcript excerpts",
          state: "warn",
          detail: `This Podcasts app version does not have the transcript column this server expects. Everything else in the library group still works, but search_library will not match on transcripts.`,
        });
      }

      // Reported rather than judged. An empty play table is normal on a Mac and
      // saying so here stops it being read as a bug later.
      try {
        const played =
          db.query("select count(*) as n from ZMTEPISODE where ZPLAYHEAD > 0")[0]?.n ?? 0;
        checks.push({
          name: "Play data",
          state: Number(played) > 0 ? "ok" : "warn",
          detail: Number(played) > 0
            ? `${played} episode(s) have a play position, so listening data can be reasoned about.`
            : `No episode in this library has a play position. That is normal: listening progress is tracked on the device you listen on and does not sync to the Mac. Nothing here can report what you have listened to, and the tools say so rather than reporting zeros.`,
        });
      } catch {
        // Not worth a line of its own if the column is gone.
      }
    } finally {
      db.close();
    }
  } catch (error) {
    checks.push({
      name: "Local library",
      state: "fail",
      detail: (error as Error).message,
    });
  }

  return checks;
}

async function checkAnalytics(config: Config): Promise<Check[]> {
  if (!hasReporterCredentials(config)) {
    return [
      {
        name: "Apple Podcasts Connect",
        state: "warn",
        detail: `Not configured, which is expected unless you own a show.\nSet APPLE_PODCASTS_VENDOR_NUMBER and APPLE_PODCASTS_REPORTER_TOKEN. Both come from Apple Podcasts Connect; the token is generated under the account's Reporter settings and expires after 180 days.\n${
          config.vendorNumber ? "Vendor number is set." : "Vendor number is not set."
        } ${config.reporterToken ? "Token is set." : "Token is not set."}`,
      },
    ];
  }

  const clients = makeClients(config);
  try {
    const vendors = await clients.reporter.vendors();
    const matches = vendors.length === 0 || vendors.includes(config.vendorNumber!);
    return [
      {
        name: "Apple Podcasts Connect",
        state: matches ? "ok" : "fail",
        detail: matches
          ? `Token accepted.${vendors.length ? ` Readable vendor number(s): ${vendors.join(", ")}.` : ""}\nReporting lags one to two days, so the newest date with data is usually two or three days back.`
          : `Token accepted, but it cannot read vendor number ${config.vendorNumber}. It can read: ${vendors.join(", ")}.`,
      },
    ];
  } catch (error) {
    return [
      {
        name: "Apple Podcasts Connect",
        state: "fail",
        detail: (error as Error).message,
      },
    ];
  }
}
