/**
 * Apple Podcasts Connect: the numbers only the show's owner can see.
 *
 * Everything else in this server is outside-in. This is the one group that
 * looks out from inside a show: how many people actually played an episode, how
 * far through they got, and which way followers are moving. None of it is
 * public and none of it can be inferred from a chart.
 *
 * It needs a vendor number and a Reporter access token, which exist only for a
 * show you own and administer in Apple Podcasts Connect. Without them these
 * tools still appear in the list, and each says exactly what is missing rather
 * than failing opaquely. That is deliberate: a tool that vanishes when
 * unconfigured cannot tell anyone how to configure it.
 *
 * Two things about the data itself are worth carrying into every result,
 * because getting either wrong produces a confident wrong number:
 *
 * **Reporting lags one to two days.** A request for today returns Apple's
 * no-data error, which reads as a broken integration. Every tool here defaults
 * to a date far enough back to have data.
 *
 * **Listener counts are devices, not people.** Someone who listens on a phone
 * and a HomePod is two. Apple has no way to collapse them, so a "listeners"
 * figure is an upper bound on humans and is labelled as devices throughout.
 */

import { z } from "zod";
import {
  REPORT_TYPES,
  latestLikelyDate,
  pickColumn,
  reporterDate,
  sumColumn,
  type DateType,
  type ReportType,
} from "../api/reporter.js";
import { hasReporterCredentials } from "../config.js";
import { defineTool } from "./kit.js";

const dateTypeArg = {
  date_type: z
    .enum(["Daily", "Weekly", "Monthly"])
    .optional()
    .describe(
      "Apple's reporting granularity. Daily and Weekly take a date as YYYYMMDD, Monthly as YYYYMM. Defaults to Daily.",
    ),
};

const dateArg = {
  date: z
    .string()
    .optional()
    .describe(
      "The reporting date, as YYYYMMDD, or YYYYMM for a Monthly report. Defaults to three days ago, because Apple publishes on a one to two day lag and asking for today reliably returns no data.",
    ),
};

export const checkAnalyticsAccess = defineTool({
  name: "check_analytics_access",
  title: "Check Apple Podcasts Connect access",
  description:
    "Verify the Apple Podcasts Connect credentials and list the vendor numbers this access token can read. Call this first: it is the cheapest way to tell a wrong token from a wrong vendor number from a show that simply has no data yet. Returns no listening data of its own.",
  schema: {},
  risk: "read",
  surface: "reporter",
  handler: async (_args, ctx) => {
    if (!hasReporterCredentials(ctx.config)) {
      return {
        configured: false,
        vendor_number_set: Boolean(ctx.config.vendorNumber),
        token_set: Boolean(ctx.config.reporterToken),
        note: "Apple Podcasts Connect is not configured, and only a show you own has these credentials. Set APPLE_PODCASTS_VENDOR_NUMBER and APPLE_PODCASTS_REPORTER_TOKEN. Both come from Apple Podcasts Connect: the vendor number is on the account, and the access token is generated under the account's Reporter settings and expires after 180 days. Every other tool in this server works without them.",
      };
    }

    const vendors = await ctx.clients.reporter.vendors();
    const configured = ctx.config.vendorNumber!;

    return {
      configured: true,
      token_valid: true,
      vendor_number: configured,
      readable_vendors: vendors,
      vendor_matches: vendors.length === 0 || vendors.includes(configured),
      note:
        vendors.length && !vendors.includes(configured)
          ? `The token is valid but does not cover vendor number ${configured}. It can read: ${vendors.join(", ")}. Set APPLE_PODCASTS_VENDOR_NUMBER to one of those.`
          : "Credentials work. Reporting lags one to two days, so the most recent date with data is usually two or three days back.",
    };
  },
});

export const getShowAnalytics = defineTool({
  name: "get_show_analytics",
  title: "Show-level listening",
  description:
    "Plays and listener counts for your show over one reporting period, from Apple Podcasts Connect. Listener counts are devices rather than people: one person listening on a phone and a speaker counts twice, and Apple has no way to collapse them. Needs Apple Podcasts Connect credentials.",
  schema: {
    ...dateTypeArg,
    ...dateArg,
    worldwide: z
      .boolean()
      .optional()
      .describe(
        "Use the worldwide report, which drops the per-storefront breakdown and returns totals. Smaller and the right choice unless the question is about geography.",
      ),
  },
  risk: "read",
  surface: "reporter",
  handler: async (args, ctx) => {
    const dateType = (args.date_type ?? "Daily") as DateType;
    const date = args.date ?? latestLikelyDate(dateType);
    const reportType: ReportType = args.worldwide ? "apShowListeningWorldwide" : "apShowListening";

    const report = await ctx.clients.reporter.report({ reportType, dateType, date });
    return summarise(report, "show");
  },
});

export const getEpisodeAnalytics = defineTool({
  name: "get_episode_analytics",
  title: "Per-episode listening",
  description:
    "Plays and listener counts per episode for one reporting period, ranked. This is the report that says which episode actually worked, which no public data can tell you. Listener counts are devices, not people. Needs Apple Podcasts Connect credentials.",
  schema: {
    ...dateTypeArg,
    ...dateArg,
    worldwide: z
      .boolean()
      .optional()
      .describe("Use the worldwide report, dropping the per-storefront breakdown."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("How many episodes to return, ranked by plays. Defaults to 25."),
  },
  risk: "read",
  surface: "reporter",
  handler: async (args, ctx) => {
    const dateType = (args.date_type ?? "Daily") as DateType;
    const date = args.date ?? latestLikelyDate(dateType);
    const reportType: ReportType = args.worldwide
      ? "apEpisodeListeningWorldwide"
      : "apEpisodeListening";

    const report = await ctx.clients.reporter.report({ reportType, dateType, date });
    const summary = summarise(report, "episode");

    const playsColumn = pickColumn(report.columns, ["Plays", "Total Plays", "Play Count"]);
    const titleColumn = pickColumn(report.columns, ["Episode Name", "Episode", "Title"]);

    if (!playsColumn || !titleColumn) return summary;

    const ranked = [...report.rows]
      .sort((a, b) => numberOf(b[playsColumn]) - numberOf(a[playsColumn]))
      .slice(0, args.limit ?? 25)
      .map((row) => ({ episode: row[titleColumn], plays: numberOf(row[playsColumn]) }));

    return { ...summary, top_episodes: ranked };
  },
});

export const getFollowers = defineTool({
  name: "get_followers",
  title: "Follower counts over time",
  description:
    "Follower numbers for your show across a reporting period, from Apple's content performance report. Followers are the metric Apple's Top Shows chart is weighted by, so a change here is the leading indicator for a change in rank. Needs Apple Podcasts Connect credentials.",
  schema: { ...dateTypeArg, ...dateArg },
  risk: "read",
  surface: "reporter",
  handler: async (args, ctx) => {
    const dateType = (args.date_type ?? "Daily") as DateType;
    const date = args.date ?? latestLikelyDate(dateType);

    const report = await ctx.clients.reporter.report({
      reportType: "apContentPerformance",
      dateType,
      date,
    });

    const followersColumn = pickColumn(report.columns, [
      "Followers",
      "Total Followers",
      "Follower Count",
      "Subscribers",
    ]);

    return {
      report_type: "apContentPerformance",
      date_type: dateType,
      date,
      columns: report.columns,
      rows_returned: report.rowCount,
      followers: followersColumn ? sumColumn(report.rows, followersColumn) : null,
      followers_column: followersColumn ?? null,
      rows: report.rows.slice(0, 50),
      note: followersColumn
        ? "Followers is the measure Apple's Top Shows chart is weighted by, so movement here leads movement in find_chart_position."
        : "This report did not contain a column recognisable as followers. Apple changes report columns between versions, so the raw columns and rows are returned for inspection.",
    };
  },
});

export const getAnalyticsReport = defineTool({
  name: "get_analytics_report",
  title: "Any Reporter report, raw",
  description:
    "Fetch any Apple Podcasts Connect listening report by name and return its columns and rows unchanged. The other analytics tools are shaped views over specific reports; this is the escape hatch for a report they do not cover, and for inspecting columns after Apple changes a report format. Needs Apple Podcasts Connect credentials.",
  schema: {
    report_type: z
      .enum(REPORT_TYPES)
      .describe(
        "Which Apple report to fetch. The Worldwide variants drop the storefront breakdown and are much smaller.",
      ),
    ...dateTypeArg,
    ...dateArg,
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Rows to return. Defaults to 100. The true row count is always reported."),
  },
  risk: "read",
  surface: "reporter",
  handler: async (args, ctx) => {
    const dateType = (args.date_type ?? "Daily") as DateType;
    const date = args.date ?? latestLikelyDate(dateType);

    const report = await ctx.clients.reporter.report({
      reportType: args.report_type,
      dateType,
      date,
    });

    return {
      report_type: report.reportType,
      date_type: report.dateType,
      date: report.date,
      columns: report.columns,
      rows_returned: report.rowCount,
      rows: report.rows.slice(0, args.limit ?? 100),
    };
  },
});

/**
 * Shape a raw report into the numbers a caller asked for.
 *
 * Column names are matched from a candidate list rather than hardcoded, because
 * Apple renames them between report versions and a hardcoded name silently
 * becomes a null. When nothing matches, the raw columns come back so the caller
 * can see what Apple actually sent rather than being told there is no data.
 */
function summarise(
  report: { reportType: string; dateType: string; date: string; columns: string[]; rows: Record<string, string>[]; rowCount: number },
  level: "show" | "episode",
): Record<string, unknown> {
  const plays = pickColumn(report.columns, ["Plays", "Total Plays", "Play Count"]);
  const listeners = pickColumn(report.columns, [
    "Unique Listeners",
    "Listeners",
    "Unique Devices",
    "Devices",
  ]);
  const engaged = pickColumn(report.columns, ["Engaged Listeners", "Engaged Devices"]);

  return {
    report_type: report.reportType,
    level,
    date_type: report.dateType,
    date: report.date,
    rows_returned: report.rowCount,
    totals: {
      plays: plays ? sumColumn(report.rows, plays) : null,
      listener_devices: listeners ? sumColumn(report.rows, listeners) : null,
      engaged_listener_devices: engaged ? sumColumn(report.rows, engaged) : null,
    },
    columns: report.columns,
    note: plays
      ? "Listener figures count devices, not people. One person on a phone and a speaker is two. Apple publishes on a one to two day lag, so a recent date with no data usually means it is not published yet rather than that nobody listened."
      : "No column recognisable as plays was present. Apple changes report columns between versions, so the column list is returned for inspection and get_analytics_report will give the raw rows.",
  };
}

function numberOf(value: string | undefined): number {
  const parsed = Number((value ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Exported for the doctor, which reports the newest date worth trying. */
export function suggestedDate(dateType: DateType = "Daily"): string {
  return reporterDate(new Date(Date.now() - 3 * 86_400_000), dateType);
}

export const ANALYTICS_TOOLS = [
  checkAnalyticsAccess,
  getShowAnalytics,
  getEpisodeAnalytics,
  getFollowers,
  getAnalyticsReport,
];
