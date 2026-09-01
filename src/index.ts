#!/usr/bin/env node
/**
 * Entry point.
 *
 * `apple-podcasts-mcp`          stdio, which is what MCP clients launch
 * `apple-podcasts-mcp doctor`   check the setup and say what is wrong
 * `apple-podcasts-mcp --http`   HTTP, for running it somewhere always on
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, VERSION } from "./server.js";
import { loadConfig } from "./config.js";
import { httpOptionsFromEnv, startHttpServer } from "./transport/http.js";

const HELP = `apple-podcasts-mcp ${VERSION}

  apple-podcasts-mcp                     Run over stdio. This is what an MCP client launches.
  apple-podcasts-mcp doctor              Check the setup and report what is wrong.
  apple-podcasts-mcp --http [--port=N]   Run over HTTP, for a machine that is always on.
  apple-podcasts-mcp --version           Print the version.

Most of this server needs no configuration. Apple's catalog, charts, reviews and
RSS feeds are all open, and the local library is read straight off this Mac.

Options:
  APPLE_PODCASTS_STOREFRONT         two-letter country code, default us. Apple's
                                    catalog, charts and reviews all differ by country
  APPLE_PODCASTS_STOREFRONTS        comma-separated markets the cross-market tools sweep
  APPLE_PODCASTS_LIBRARY=0          remove the local-library tools from the tool list
  APPLE_PODCASTS_LIBRARY_PATH       where the Podcasts database is, if not the default

For a show you own in Apple Podcasts Connect:
  APPLE_PODCASTS_VENDOR_NUMBER      vendor number from Podcasts Connect
  APPLE_PODCASTS_REPORTER_TOKEN     Reporter access token, expires after 180 days

Everything else:
  APPLE_PODCASTS_READ_ONLY=1        hide the one tool that writes a file
  APPLE_PODCASTS_AUDIT_LOG          append-only log of every attempted write
  APPLE_PODCASTS_CACHE_TTL_MS       how long a fetched chart stays reusable, default 300000
  APPLE_PODCASTS_REQUEST_TIMEOUT_MS per-request deadline, default 30000
  APPLE_PODCASTS_HTTP_PORT / _HOST / _TOKEN  for --http

https://github.com/navidmoazzez/apple-podcasts-mcp
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (argv.includes("--help") || argv.includes("-h") || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    process.exitCode = await runDoctor();
    return;
  }

  const config = loadConfig();
  const built = buildServer(config);

  const shutdown = async (close?: () => Promise<void>): Promise<void> => {
    if (close) await close().catch(() => undefined);
    process.exit(0);
  };

  if (argv.includes("--http")) {
    const { close } = await startHttpServer(built, httpOptionsFromEnv(argv));
    process.on("SIGTERM", () => void shutdown(close));
    process.on("SIGINT", () => void shutdown(close));
    return;
  }

  const transport = new StdioServerTransport();
  await built.server.connect(transport);

  // Handled so `docker stop` and a client shutting down return promptly rather
  // than waiting out a grace period.
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`[apple-podcasts-mcp] ${(error as Error).message}\n`);
  process.exit(1);
});
