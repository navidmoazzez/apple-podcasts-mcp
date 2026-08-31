/**
 * Apple Podcasts Connect analytics, over the Reporter protocol.
 *
 * This is the owner-side data: how many people actually played an episode, how
 * far they got, and which way followers are moving. None of it is public and
 * none of it is in the catalog. It only works for a show you own.
 *
 * Apple documents Reporter as a Java command-line tool, which is why so little
 * speaks it. Underneath, it is a plain HTTP POST, and the shape is fixed:
 *
 *   POST https://reportingitc-reporter.apple.com/reportservice/sales/v1
 *   Content-Type: application/x-www-form-urlencoded
 *   jsonRequest={"accesstoken":"…","version":"2.2","mode":"Robot.XML",
 *                "queryInput":"[p=Reporter.properties, Sales.getReport, …]"}
 *
 * Four things about it will surprise anyone who expects a REST API, and each
 * one is handled here rather than left to leak out as a confusing failure:
 *
 * **The command is a string inside a JSON field inside a form field.** The
 * `queryInput` is Reporter's own command language, wrapped in square brackets
 * with a properties-file reference that has to be present even though there is
 * no properties file. Omitting it fails with an unhelpful error.
 *
 * **A successful report is gzipped TSV, not JSON.** Apple signals it with the
 * content type `application/a-gzip`. Anything else on a 200 is a status message
 * in plain text or XML, so the response has to be sniffed rather than assumed.
 *
 * **An empty day is an error, not an empty report.** Apple returns HTTP 404
 * with a message saying there is no data for that date. That is the normal
 * shape of "this show had no listeners yet", and treating it as a failure would
 * report a quiet week as a broken integration.
 *
 * **Reporting lags by one to two days**, and there is no field saying so. A
 * request for today reliably returns the no-data 404, which reads as breakage
 * unless the caller is told. The date helpers below default back rather than to
 * today for exactly that reason.
 *
 * The access token rotates every 180 days and is generated in Podcasts Connect,
 * not here. Nothing in this server can mint one.
 */

import { gunzipSync } from "node:zlib";
import type { Config } from "../config.js";
import { ReporterError } from "./errors.js";
import type { FetchLike } from "./http.js";

/** The protocol version Reporter expects. Not the report format version. */
const REPORTER_VERSION = "2.2";

/**
 * Listening reports Apple publishes for podcasts.
 *
 * The `Worldwide` variants drop the storefront breakdown and return one row per
 * subject, which is both smaller and the right choice when the question is
 * about totals rather than geography.
 */
export const REPORT_TYPES = [
  "apShowListening",
  "apEpisodeListening",
  "apChannelListening",
  "apProviderListening",
  "apContentPerformance",
  "apShowListeningWorldwide",
  "apEpisodeListeningWorldwide",
  "apChannelListeningWorldwide",
  "apProviderListeningWorldwide",
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

export type DateType = "Daily" | "Weekly" | "Monthly";

export type Report = {
  reportType: ReportType;
  dateType: DateType;
  date: string;
  /** Header row from the TSV, in Apple's own column names. */
  columns: string[];
  rows: Record<string, string>[];
  rowCount: number;
};

export class ReporterClient {
  private readonly config: Config;
  private readonly fetchImpl: FetchLike;

  constructor(config: Config, fetchImpl: FetchLike = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  private get endpoint(): string {
    return `${this.config.reporterHost}/reportservice/sales/v1`;
  }

  private requireCredentials(): { vendor: string; token: string } {
    const vendor = this.config.vendorNumber;
    const token = this.config.reporterToken;
    if (!vendor || !token) {
      throw new ReporterError(
        `Apple Podcasts Connect is not configured. This tool needs APPLE_PODCASTS_VENDOR_NUMBER and APPLE_PODCASTS_REPORTER_TOKEN, which only exist for a show you own and administer. Everything else in this server works without them. Run \`apple-podcasts-mcp doctor\` for where to find both.`,
        0,
      );
    }
    return { vendor, token };
  }

  /** The vendor numbers this token can read. The cheapest proof it works. */
  async vendors(): Promise<string[]> {
    const { token } = this.requireCredentials();
    const body = await this.post("Sales.getVendors", token);
    // Robot.XML returns <Vendors><Vendor>123</Vendor></Vendors>. The numbers are
    // pulled out by pattern rather than by parsing, because this response is a
    // flat list and a parser would be more machinery than the shape needs.
    const matches = [...body.matchAll(/<Vendor>\s*([0-9]+)\s*<\/Vendor>/g)];
    if (matches.length) return matches.map((m) => m[1]!);
    // Normal mode answers with one vendor number per line.
    return body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line));
  }

  /** One listening report. */
  async report(options: {
    reportType: ReportType;
    dateType: DateType;
    date: string;
    vendor?: string;
  }): Promise<Report> {
    const { vendor, token } = this.requireCredentials();
    const useVendor = options.vendor ?? vendor;

    assertDate(options.dateType, options.date);

    const command = `Sales.getReport, ${useVendor},${options.reportType},Summary,${options.dateType},${options.date}`;
    const text = await this.post(command, token, { expectReport: true });
    const { columns, rows } = parseTsv(text);

    return {
      reportType: options.reportType,
      dateType: options.dateType,
      date: options.date,
      columns,
      rows,
      rowCount: rows.length,
    };
  }

  private async post(
    command: string,
    token: string,
    options: { expectReport?: boolean } = {},
  ): Promise<string> {
    const payload = {
      version: REPORTER_VERSION,
      mode: "Robot.XML",
      // The properties-file reference is required even though no file exists.
      queryInput: `[p=Reporter.properties, ${command}]`,
      accesstoken: token,
    };

    const body = `jsonRequest=${encodeURIComponent(JSON.stringify(payload))}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        signal: controller.signal,
        body,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "text/html,image/gif,image/jpeg; q=.2, */*; q=.2",
          "User-Agent": this.config.userAgent,
        },
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        throw new ReporterError(
          `Apple Podcasts Connect did not respond within ${this.config.requestTimeoutMs}ms. Reporter is slow on large reports; raise APPLE_PODCASTS_REQUEST_TIMEOUT_MS.`,
          0,
        );
      }
      throw new ReporterError(
        `Could not reach Apple Podcasts Connect: ${(error as Error)?.message ?? String(error)}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (!response.ok) {
      const message = (await response.text()).trim().replace(/\s+/g, " ").slice(0, 400);
      throw reporterErrorFor(response.status, message, options.expectReport === true);
    }

    // A real report arrives gzipped, and it is the only response that does.
    if (contentType.includes("a-gzip") || contentType.includes("gzip")) {
      const buffer = Buffer.from(await response.arrayBuffer());
      try {
        return gunzipSync(buffer).toString("utf8");
      } catch (error) {
        throw new ReporterError(
          `Apple returned a report that could not be decompressed.`,
          response.status,
          (error as Error)?.message,
        );
      }
    }

    return await response.text();
  }
}

function reporterErrorFor(status: number, message: string, expectReport: boolean): ReporterError {
  // Apple's "no data" is an HTTP error carrying a specific phrase. It is the
  // normal answer for a quiet day and must not read as a broken setup.
  if (/no report.*available|no data|not available/i.test(message)) {
    return new ReporterError(
      `Apple has no report for that date. Reporting lags one to two days, so today and often yesterday return this. It also means exactly what it says on a day the show had no listeners. ${expectReport ? "Try a date three or four days back to tell the two apart." : ""}`.trim(),
      status,
      message,
    );
  }

  if (status === 401 || status === 403 || /access token|unauthor/i.test(message)) {
    return new ReporterError(
      `Apple Podcasts Connect rejected the access token. Tokens expire after 180 days and are regenerated in Podcasts Connect under the account's Reporter settings, not through this server.`,
      status,
      message,
    );
  }

  if (/vendor/i.test(message)) {
    return new ReporterError(
      `Apple rejected the vendor number. Call check_analytics_access to list the vendor numbers this token can actually read, which is the fastest way to find the right one.`,
      status,
      message,
    );
  }

  return new ReporterError(
    `Apple Podcasts Connect refused the request${status ? ` (HTTP ${status})` : ""}.`,
    status,
    message,
  );
}

/**
 * Reporter's date formats, which differ per date type and are not forgiving.
 *
 * A Weekly report wants the date of a specific day within the week and returns
 * an error for anything else, and a Monthly one wants six digits rather than
 * eight. Sending the wrong shape produces a message about the report being
 * unavailable, which reads as missing data rather than a malformed request.
 */
export function assertDate(dateType: DateType, date: string): void {
  const wanted = dateType === "Monthly" ? /^\d{6}$/ : /^\d{8}$/;
  if (!wanted.test(date)) {
    throw new ReporterError(
      dateType === "Monthly"
        ? `A Monthly report takes a date as YYYYMM, for example 202608. Got "${date}".`
        : `A ${dateType} report takes a date as YYYYMMDD, for example 20260830. Got "${date}". Apple reports this as "no report available" rather than as a bad date, so it is checked here first.`,
      0,
    );
  }
}

/** Format a Date as Reporter wants it. */
export function reporterDate(date: Date, dateType: DateType): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  if (dateType === "Monthly") return `${year}${month}`;
  return `${year}${month}${String(date.getUTCDate()).padStart(2, "0")}`;
}

/**
 * The most recent date likely to have data.
 *
 * Defaults three days back rather than to today. Apple publishes on a one to
 * two day lag, so a default of today returns the no-data error essentially
 * always, and a caller reads that as the integration being broken.
 */
export function latestLikelyDate(dateType: DateType, lagDays = 3): string {
  const date = new Date(Date.now() - lagDays * 86_400_000);
  return reporterDate(date, dateType);
}

/**
 * Parse Reporter's TSV.
 *
 * Tab-separated with a header row, no quoting, and no escaping. Because there
 * is no quoting, a value can never contain a tab, so splitting is safe. Rows
 * with a different column count than the header are kept and padded rather than
 * dropped: Apple occasionally emits a trailing summary row, and discarding
 * anything that does not fit would silently lose real data.
 */
export function parseTsv(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return { columns: [], rows: [] };

  const columns = lines[0]!.split("\t").map((c) => c.trim());
  const rows: Record<string, string>[] = [];

  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    columns.forEach((column, index) => {
      row[column] = (cells[index] ?? "").trim();
    });
    rows.push(row);
  }

  return { columns, rows };
}

/**
 * Add up a numeric column across rows.
 *
 * Apple's counts arrive as strings and can carry thousands separators depending
 * on the report, so they are stripped before parsing rather than handed to
 * Number, which would return NaN for "1,204" and quietly zero the total.
 */
export function sumColumn(rows: Record<string, string>[], column: string): number {
  let total = 0;
  for (const row of rows) {
    const raw = (row[column] ?? "").replace(/[,\s]/g, "");
    const value = Number(raw);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

/** Find whichever of these column names this report actually uses. */
export function pickColumn(columns: string[], candidates: string[]): string | undefined {
  const lowered = columns.map((c) => c.toLowerCase());
  for (const candidate of candidates) {
    const index = lowered.indexOf(candidate.toLowerCase());
    if (index !== -1) return columns[index];
  }
  return undefined;
}
