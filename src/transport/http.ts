/**
 * HTTP transport, for running the server somewhere always on.
 *
 * Streamable HTTP, stateless: every request builds its own transport and tears
 * it down. No session map means no session leak, which matters more here than
 * the reconnect support a stateful server would buy.
 *
 * This is also what makes the server reachable from claude.ai, which runs
 * connectors from Anthropic's cloud and cannot launch a local command.
 *
 * One thing to understand before hosting it. Three of the four sources are
 * public and travel fine. **The local library does not.** Those tools read the
 * Apple Podcasts database on the machine the server runs on, so a hosted
 * instance serves the host's library, not the caller's, to everyone who can
 * reach it. That is almost never what anyone wants, so a server bound to
 * anything other than loopback refuses to start with the library enabled unless
 * it is switched off deliberately.
 *
 * Bound to 127.0.0.1 by default for the same reason.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hasReporterCredentials } from "../config.js";
import type { BuiltServer } from "../server.js";

export type HttpOptions = {
  port: number;
  host: string;
  /** When set, every request must send `Authorization: Bearer <token>`. */
  token?: string;
};

export function httpOptionsFromEnv(argv: string[] = []): HttpOptions {
  const flag = argv.find((a) => a.startsWith("--port="));
  const port = Number(flag?.split("=")[1] ?? process.env.APPLE_PODCASTS_HTTP_PORT ?? 8788);
  return {
    port: Number.isFinite(port) && port > 0 ? port : 8788,
    host: process.env.APPLE_PODCASTS_HTTP_HOST || "127.0.0.1",
    token: process.env.APPLE_PODCASTS_HTTP_TOKEN || undefined,
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Constant-time comparison, so the token cannot be guessed byte by byte. */
function tokenMatches(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

async function handle(
  built: BuiltServer,
  options: HttpOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Health needs no auth: it reports counts and capability, never content.
  if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        tools: built.toolCount,
        storefront: built.config.storefront,
        library: built.config.libraryEnabled && existsSync(built.config.libraryPath),
        analytics: hasReporterCredentials(built.config),
        read_only: built.config.readOnly,
      }),
    );
    return;
  }

  if (options.token) {
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || !tokenMatches(options.token, provided)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => void transport.close());
  await built.server.connect(transport);
  await transport.handleRequest(req, res, await readBody(req));
}

/** Loopback addresses, where serving a personal library is only self-service. */
function isLoopback(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase());
}

export async function startHttpServer(
  built: BuiltServer,
  options: HttpOptions,
): Promise<{ close: () => Promise<void> }> {
  // Refused rather than warned about. Warnings in stderr are not read, and the
  // failure here is quietly exposing one person's listening history to whoever
  // can reach the port.
  if (!isLoopback(options.host) && built.config.libraryEnabled) {
    throw new Error(
      `Refusing to serve the local library on ${options.host}. The library tools read the Apple Podcasts database on this machine, so binding anywhere but loopback would serve this Mac's subscriptions and cached transcripts to every caller. Set APPLE_PODCASTS_LIBRARY=0 to host the public tools only, or keep the default host of 127.0.0.1.`,
    );
  }

  const http = createServer((req, res) => {
    void handle(built, options, req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: (error as Error)?.message ?? "internal error" },
          id: null,
        }),
      );
    });
  });

  await new Promise<void>((resolve) => http.listen(options.port, options.host, resolve));

  process.stderr.write(
    `[apple-podcasts-mcp] HTTP on http://${options.host}:${options.port} (${built.toolCount} tools)\n${
      options.token
        ? ""
        : "[apple-podcasts-mcp] No APPLE_PODCASTS_HTTP_TOKEN set: this endpoint is unauthenticated.\n"
    }`,
  );

  return {
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
      }),
  };
}
