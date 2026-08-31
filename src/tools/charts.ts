/**
 * Ranking: the only place Apple says who is winning.
 *
 * The catalog answers "does this exist". These answer "does it matter", which
 * is almost always the real question, and Apple publishes it for free.
 *
 * `find_chart_position` is the tool worth the whole group. Apple has no
 * endpoint that says where a show ranks: it publishes a chart, and finding a
 * show in it means fetching the chart and looking. Across markets that is a
 * sweep, one request per storefront, which is exactly the kind of thing a
 * person will not do by hand and an agent should.
 */

import { z } from "zod";
import { MAX_CHART_SIZE, positionOf, type Chart } from "../api/charts.js";
import { normalizeStorefront } from "../config.js";
import { renderChart } from "../format/podcasts.js";
import { resolveLink } from "../api/itunes.js";
import { clamp, defineTool, limitArg, showArg, storefrontArg } from "./kit.js";

export const getTopShows = defineTool({
  name: "get_top_shows",
  title: "Apple's Top Shows chart",
  description:
    "Apple's live Top Shows chart for one storefront, ranked. This is Apple's own ordering, weighted by followers rather than plays, and it moves slowly. Capped at 100 by Apple. There are no genre charts: Apple serves one overall chart per country, so filtering by genre here filters this list rather than asking Apple for a different one.",
  schema: {
    ...limitArg(MAX_CHART_SIZE, `Apple refuses more than ${MAX_CHART_SIZE}.`),
    genre: z
      .string()
      .optional()
      .describe(
        "Keep only entries Apple files under a genre whose name contains this, case-insensitive. This filters the overall chart, so it shows the top-100 shows that are in a genre, not the genre's own top 100.",
      ),
    ...storefrontArg,
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const storefront = ctx.storefront(args.storefront);
    const chart = await ctx.clients.charts.chart({
      storefront,
      kind: "podcasts",
      limit: clamp(args.limit, 25, MAX_CHART_SIZE),
    });

    if (!args.genre) return renderChart(chart);

    const needle = args.genre.toLowerCase();
    const filtered: Chart = {
      ...chart,
      entries: chart.entries.filter((entry) =>
        entry.genres.some((genre) => genre.toLowerCase().includes(needle)),
      ),
    };
    return renderChart(filtered);
  },
});

export const getTrendingEpisodes = defineTool({
  name: "get_trending_episodes",
  title: "Apple's Trending Episodes chart",
  description:
    "Apple's live Trending Episodes chart for one storefront. This moves far faster than Top Shows and is the better signal for what a topic or a guest is doing right now, because a single episode can chart without its show being anywhere near the top 100. Each entry carries both the episode id and the show it belongs to.",
  schema: {
    ...limitArg(MAX_CHART_SIZE, `Apple refuses more than ${MAX_CHART_SIZE}.`),
    ...storefrontArg,
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const storefront = ctx.storefront(args.storefront);
    const chart = await ctx.clients.charts.chart({
      storefront,
      kind: "podcast-episodes",
      limit: clamp(args.limit, 25, MAX_CHART_SIZE),
    });
    return renderChart(chart);
  },
});

export const findChartPosition = defineTool({
  name: "find_chart_position",
  title: "Where a show ranks, across markets",
  description:
    "Find where one show sits in Apple's Top Shows chart, in one storefront or swept across several. Apple publishes no endpoint for a show's rank, so this fetches each chart and looks the show up in it by id. Ranking diverges sharply between countries: a show can be top 20 in one market and unranked in another, so a single storefront is rarely the answer to how a show is doing. Unranked means outside the top 100 there, not unpopular.",
  schema: {
    ...showArg,
    storefronts: z
      .array(z.string())
      .optional()
      .describe(
        "Storefronts to check, as two-letter codes. Defaults to the configured sweep. Each one is a separate request against a rate-limited API, so keep the list to the markets that matter.",
      ),
    include_episodes: z
      .boolean()
      .optional()
      .describe("Also check the Trending Episodes chart for episodes belonging to this show."),
    ...storefrontArg,
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const link = resolveLink(args.show);
    const storefronts = (args.storefronts?.length
      ? args.storefronts
      : args.storefront
        ? [args.storefront]
        : ctx.config.storefronts
    ).map(normalizeStorefront);

    const results: Record<string, unknown>[] = [];

    for (const storefront of storefronts) {
      const row: Record<string, unknown> = { storefront };
      try {
        const chart = await ctx.clients.charts.chart({
          storefront,
          kind: "podcasts",
          limit: MAX_CHART_SIZE,
        });
        const entry = positionOf(chart, link.showId);
        row.rank = entry?.rank ?? null;
        row.charted = Boolean(entry);
        if (entry) {
          row.name = entry.name;
          row.genres = entry.genres;
        }
        row.chart_updated = chart.updated ?? null;

        if (args.include_episodes) {
          const episodes = await ctx.clients.charts.chart({
            storefront,
            kind: "podcast-episodes",
            limit: MAX_CHART_SIZE,
          });
          const hits = episodes.entries.filter((e) => e.showId === link.showId);
          row.trending_episodes = hits.map((e) => ({ rank: e.rank, title: e.name, episode_apple_id: e.id }));
        }
      } catch (error) {
        // One dead storefront must not hide seven healthy ones. A sweep that
        // throws on the first failure is worse than no sweep, because the
        // caller cannot tell a bad market from a bad show.
        row.error = (error as Error).message;
      }
      results.push(row);
    }

    const charted = results.filter((r) => r.charted);
    const best = charted.length
      ? charted.reduce((a, b) => ((a.rank as number) <= (b.rank as number) ? a : b))
      : undefined;

    return {
      show_apple_id: link.showId,
      storefronts_checked: storefronts.length,
      charted_in: charted.length,
      best_rank: best ? { storefront: best.storefront, rank: best.rank } : null,
      results,
      note: charted.length
        ? "Rank is Apple's Top Shows position in each storefront, out of 100."
        : "This show is not in the top 100 of any storefront checked. Apple publishes no ranking below 100, so this says the show is outside that band, not that nobody listens to it.",
    };
  },
});

export const listStorefronts = defineTool({
  name: "list_storefronts",
  title: "Storefronts worth checking",
  description:
    "The storefronts this server sweeps by default, and the configured default. Apple operates a storefront for most countries and any two-letter code can be passed to the tools here; this is the working set, not the full list. Change it with APPLE_PODCASTS_STOREFRONTS.",
  schema: {},
  risk: "read",
  surface: "public",
  handler: async (_args, ctx) => ({
    default: ctx.config.storefront,
    sweep: ctx.config.storefronts,
    note: "Any ISO 3166-1 alpha-2 country code works as a storefront, not only these. Apple returns HTTP 404 for a country it does not operate in, which is reported as a not-found rather than an empty chart.",
  }),
});

export const CHART_TOOLS = [getTopShows, getTrendingEpisodes, findChartPosition, listStorefronts];
