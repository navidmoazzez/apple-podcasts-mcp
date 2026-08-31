/**
 * Reading the Apple Podcasts database, without a native dependency.
 *
 * The library lives in a SQLite file the Podcasts app owns. Reading it needs a
 * SQLite driver, and the obvious one is a compiled native module, which is the
 * wrong trade for a server people install with `npx`: it turns a download into
 * a build, and it fails on exactly the machines least able to debug it.
 *
 * So there are two backends and no dependency:
 *
 *   node:sqlite    built into Node 22.5 and later. Real prepared statements,
 *                  so values are bound rather than interpolated.
 *   sqlite3 CLI    /usr/bin/sqlite3, which ships with macOS. Used when
 *                  node:sqlite is missing, which is Node 20 and 21.
 *
 * The fallback is safe to rely on because this whole module is macOS-only by
 * definition: the database is written by an Apple app that runs nowhere else.
 * A Linux box has no library to read, so a missing CLI there is not a gap.
 *
 * **Everything opens read-only, through an immutable URI.** That matters for
 * more than tidiness. The Podcasts app keeps the database in WAL mode and holds
 * it open while it runs, so an ordinary connection can block, or worse, recover
 * the journal and modify a file this server has no business writing to.
 * `?immutable=1` promises SQLite the file will not change underneath it, which
 * skips locking entirely and makes reads work while the app is open.
 *
 * The consequence, stated because it is a real limitation rather than a
 * footnote: an immutable connection does not read the write-ahead log. Anything
 * the app has changed in the last few moments and not yet checkpointed is not
 * visible. For a library of tens of thousands of episodes that is the right
 * trade, but it is why a show followed thirty seconds ago may not appear yet.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { LibraryError } from "../api/errors.js";

export type Row = Record<string, unknown>;

export interface Db {
  query(sql: string, params?: unknown[]): Row[];
  close(): void;
}

/** Cached so the import cost and the experimental warning are paid once. */
let nodeSqlite: { DatabaseSync: new (path: string, options?: unknown) => NodeDb } | undefined;
let nodeSqliteChecked = false;

type NodeDb = {
  prepare(sql: string): { all(...params: unknown[]): Row[] };
  close(): void;
};

async function loadNodeSqlite(): Promise<typeof nodeSqlite> {
  if (nodeSqliteChecked) return nodeSqlite;
  nodeSqliteChecked = true;

  // Importing node:sqlite prints an ExperimentalWarning to stderr. Harmless to
  // the protocol, which runs on stdout, but it lands in the user's client log
  // as the only line there, and a warning nobody can act on trains people to
  // ignore that log. Suppressed narrowly, by exact text, and restored straight
  // after so no other warning is ever swallowed.
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (text?.includes("SQLite is an experimental feature")) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;

  try {
    nodeSqlite = (await import("node:sqlite")) as unknown as typeof nodeSqlite;
  } catch {
    // Node 20 and 21. The CLI backend covers it.
    nodeSqlite = undefined;
  } finally {
    process.emitWarning = original;
  }
  return nodeSqlite;
}

export async function openDatabase(path: string): Promise<Db> {
  if (!existsSync(path)) {
    throw new LibraryError(
      `No Apple Podcasts library at ${path}. That file is created the first time the Podcasts app runs and follows at least one show, so an untouched Mac will not have it. Set APPLE_PODCASTS_LIBRARY_PATH if yours is somewhere else, or APPLE_PODCASTS_LIBRARY=0 to remove these tools from the list.`,
    );
  }

  const sqlite = await loadNodeSqlite();
  if (sqlite) {
    try {
      return new NodeSqliteDb(path, sqlite);
    } catch (error) {
      // Fall through to the CLI. A DatabaseSync that will not open is usually
      // a permission problem, and the CLI reports it more legibly.
      if (!hasCli()) throw asLibraryError(error, path);
    }
  }

  if (!hasCli()) {
    throw new LibraryError(
      `Cannot read the Apple Podcasts library: this Node build has no node:sqlite (added in Node 22.5) and there is no sqlite3 command available. Upgrade Node, or install sqlite3.`,
    );
  }

  return new CliDb(path);
}

function hasCli(): boolean {
  return existsSync("/usr/bin/sqlite3");
}

/** `?immutable=1` is what makes reads work while the Podcasts app holds the file. */
function immutableUri(path: string): string {
  return `file:${encodeURI(path)}?immutable=1`;
}

class NodeSqliteDb implements Db {
  private readonly db: NodeDb;

  constructor(path: string, sqlite: NonNullable<typeof nodeSqlite>) {
    this.db = new sqlite.DatabaseSync(immutableUri(path), {
      readOnly: true,
      allowExtension: false,
      enableForeignKeyConstraints: false,
    });
  }

  query(sql: string, params: unknown[] = []): Row[] {
    try {
      return this.db.prepare(sql).all(...params);
    } catch (error) {
      throw asQueryError(error, sql);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Closing a read-only handle cannot fail in a way worth reporting.
    }
  }
}

/**
 * The CLI backend.
 *
 * `sqlite3 -json` returns a JSON array, which removes the separator-parsing
 * that makes shelling out to a database fragile. There is no parameter binding
 * over a command line, so values are quoted here instead, in one place, rather
 * than at every call site.
 */
class CliDb implements Db {
  private readonly uri: string;

  constructor(path: string) {
    this.uri = immutableUri(path);
  }

  query(sql: string, params: unknown[] = []): Row[] {
    const statement = interpolate(sql, params);
    let out: string;
    try {
      out = execFileSync("/usr/bin/sqlite3", ["-json", "-readonly", this.uri, statement], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
      });
    } catch (error) {
      throw asQueryError(error, sql);
    }
    const trimmed = out.trim();
    if (!trimmed) return [];
    try {
      return JSON.parse(trimmed) as Row[];
    } catch {
      throw new LibraryError(
        `The sqlite3 command returned output that is not JSON.`,
        trimmed.slice(0, 200),
      );
    }
  }

  close(): void {
    // Nothing is held open between calls.
  }
}

/**
 * Bind parameters into a statement for the CLI backend.
 *
 * Only `?` placeholders, positionally, which is all this server uses. Strings
 * are single-quoted with internal quotes doubled, per SQL, and anything that is
 * not a string, a finite number, a boolean or null is refused rather than
 * coerced. Refusing is the point: a value that reaches here in an unexpected
 * shape is a bug, and turning it into SQL anyway is how injection happens.
 */
export function interpolate(sql: string, params: unknown[]): string {
  let index = 0;
  const out = sql.replace(/\?/g, () => {
    if (index >= params.length) {
      throw new LibraryError(`Query has more placeholders than parameters.`);
    }
    return quote(params[index++]);
  });
  if (index !== params.length) {
    throw new LibraryError(`Query has ${params.length} parameters but ${index} placeholders.`);
  }
  return out;
}

export function quote(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new LibraryError(`Refusing to build a query with a non-finite number.`);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") {
    // A NUL byte truncates the statement at the process boundary, so a string
    // carrying one is rejected rather than silently cut in half.
    if (value.includes("\0")) {
      throw new LibraryError(`Refusing to build a query from a string containing a NUL byte.`);
    }
    return `'${value.split("'").join("''")}'`;
  }
  throw new LibraryError(`Cannot use a ${typeof value} as a query parameter.`);
}

function asQueryError(error: unknown, sql: string): LibraryError {
  const message = (error as Error)?.message ?? String(error);

  if (/authorization denied|not authorized|operation not permitted|EPERM|EACCES/i.test(message)) {
    return new LibraryError(
      `macOS refused access to the Apple Podcasts library. The library lives in a protected group container, so the app running this server needs Full Disk Access: System Settings, Privacy & Security, Full Disk Access, then add your terminal or your MCP client and restart it. Adding the client is not enough on its own if it launches the server through a terminal.`,
      message,
    );
  }

  if (/no such table/i.test(message)) {
    return new LibraryError(
      `The Apple Podcasts library does not have the table this query expects. Apple changes the schema between releases of the Podcasts app, so this is a version mismatch rather than a missing library.`,
      message,
    );
  }

  return new LibraryError(
    `Could not read the Apple Podcasts library: ${message}`,
    sql.slice(0, 200),
  );
}

function asLibraryError(error: unknown, path: string): LibraryError {
  return new LibraryError(
    `Could not open the Apple Podcasts library at ${path}: ${(error as Error)?.message ?? String(error)}`,
  );
}

/**
 * Core Data timestamps are seconds since 2001-01-01, not since 1970.
 *
 * The gap is 978,307,200 seconds. Read one as a Unix timestamp and every date
 * in the library lands in 1970, which looks like corrupt data rather than a
 * unit mistake and quietly ruins any sort by recency.
 */
export const CORE_DATA_EPOCH_OFFSET = 978_307_200;

export function fromCoreDataDate(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return undefined;
  const date = new Date((value + CORE_DATA_EPOCH_OFFSET) * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
