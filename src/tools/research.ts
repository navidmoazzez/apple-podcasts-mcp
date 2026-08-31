/**
 * Tools that cross surfaces, because the real questions do.
 *
 * Everything else here maps onto one source. These do not, and that is the
 * point. "How is this show doing" is not a catalog question or a chart question
 * or a reviews question: it is all three, plus the feed for publishing cadence,
 * and the answer only means something when they are put next to each other.
 *
 * Done by hand that is a dozen calls and a lot of clerical joining. It is
 * exactly the work worth moving into a tool, and it is the reason to have one
 * server over four.
 *
 * Each of these fans out across rate-limited APIs, so they are deliberately
 * few, they cap what they sweep, and a failure in one part is reported inline
 * rather than taking the whole answer down. A profile that is missing its
 * reviews is still worth having.
 */

import { z } from "zod";
import { MAX_CHART_SIZE, positionOf } from "../api/charts.js";
import { breakdown } from "../api/reviews.js";
import { resolveLink } from "../api/itunes.js";
import { normalizeStorefront } from "../config.js";
import { clamp, defineTool, showArg, storefrontArg } from "./kit.js";

/** Publishing cadence, in days between episodes. */
function cadence(dates: (string | undefined)[]): { median_days: number | null; per_month: number | null } {
  const times = dates
    .filter((d): d is string => Boolean(d))
    .map((d) => new Date(d).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a);

  if (times.length < 3) return { median_days: null, per_month: null };

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i - 1]! - times[i]!) / 86_400_000;
    // A same-day double drop and a multi-year hiatus both distort a mean.
    // Median over plausible gaps is what survives both.
    if (gap >= 0 && gap < 400) gaps.push(gap);
  }
  if (!gaps.length) return { median_days: null, per_month: null };

  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  return {
    median_days: Number(median.toFixed(1)),
    per_month: median > 0 ? Number((30 / median).toFixed(1)) : null,
  };
}

export const getShowProfile = defineTool({
  name: "get_show_profile",
  title: "Everything about one show, in one call",
  description:
    "A complete picture of one show: its catalog record, where it ranks across storefronts, what listeners are saying and how they rate it, how often it publishes, and whether it offers transcripts. This is the tool to reach for when the question is 'tell me about this show' or 'how is this show doing', because the answer needs all of those and no single Apple endpoint has them. Each part fails independently, so a missing piece is reported rather than losing the rest.",
  schema: {
    ...showArg,
    storefronts: z
      .array(z.string())
      .optional()
      .describe("Storefronts to check rank and reviews in. Defaults to the configured sweep."),
    reviews: z
      .number()
      .int()
      .min(0)
      .max(200)
      .optional()
      .describe("How many recent reviews to sample per storefront. 0 skips reviews entirely."),
    ...storefrontArg,
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const link = resolveLink(args.show);
    const home = ctx.storefront(args.storefront ?? link.storefront);
    const storefronts = (args.storefronts?.length ? args.storefronts : ctx.config.storefronts).map(
      normalizeStorefront,
    );
    const reviewSample = args.reviews ?? 50;

    const profile: Record<string, unknown> = { show_apple_id: link.showId, storefront: home };

    // The catalog record. Everything else is optional; without this there is
    // no show to profile, so a failure here is fatal and the rest are not.
    const { show } = await ctx.clients.itunes.lookup({ id: link.showId, storefront: home });
    profile.show = {
      name: show?.collectionName,
      author: show?.artistName,
      genre: show?.primaryGenreName,
      genres: show?.genres,
      episodes_in_catalog: show?.trackCount,
      latest_release: show?.releaseDate,
      feed_url: show?.feedUrl,
      apple_url: show?.collectionViewUrl,
      artwork: show?.artworkUrl600,
      explicit: show?.collectionExplicitness === "explicit",
    };

    const ranks: Record<string, unknown>[] = [];
    for (const storefront of storefronts) {
      try {
        const chart = await ctx.clients.charts.chart({
          storefront,
          kind: "podcasts",
          limit: MAX_CHART_SIZE,
        });
        const entry = positionOf(chart, link.showId);
        ranks.push({ storefront, rank: entry?.rank ?? null });
      } catch (error) {
        ranks.push({ storefront, error: (error as Error).message });
      }
    }
    const charted = ranks.filter((r) => typeof r.rank === "number");
    profile.chart = {
      checked: storefronts.length,
      charted_in: charted.length,
      best: charted.length
        ? charted.reduce((a, b) => ((a.rank as number) <= (b.rank as number) ? a : b))
        : null,
      per_storefront: ranks,
      note: "Rank is Apple's Top Shows position out of 100. Unranked means outside the top 100 in that market.",
    };

    if (reviewSample > 0) {
      const collected = [];
      for (const storefront of storefronts) {
        try {
          const reviews = await ctx.clients.reviews.forShow({
            showId: link.showId,
            storefront,
            limit: reviewSample,
          });
          collected.push(...reviews);
        } catch {
          // Unpublished in that market. Expected in a sweep.
        }
      }
      const stats = breakdown(collected);
      profile.reviews = {
        sampled: stats.count,
        average_of_sample: stats.average,
        distribution: stats.distribution,
        newest: collected.map((r) => r.updated).sort().reverse()[0] ?? null,
        note: "Averaged over recent reviews, not the lifetime rating Apple displays. Call get_reviews for the text.",
      };
    }

    const feedUrl = show?.feedUrl;
    if (typeof feedUrl === "string" && feedUrl) {
      try {
        const feed = await ctx.clients.feed.fetch(feedUrl, { limit: 100 });
        const withTranscripts = feed.episodes.filter((e) => e.transcripts.length).length;
        profile.publishing = {
          episodes_in_feed: feed.totalEpisodes,
          ...cadence(feed.episodes.map((e) => e.publishedAt)),
          newest_episode: feed.episodes[0]?.publishedAt ?? null,
          show_type: feed.showType ?? null,
          ended: feed.complete,
          episodes_with_public_transcripts: withTranscripts,
          transcripts_available: withTranscripts > 0,
        };
      } catch (error) {
        profile.publishing = { error: (error as Error).message };
      }
    } else {
      profile.publishing = {
        error: "Apple lists no RSS feed for this show, so publishing cadence cannot be read.",
      };
    }

    return profile;
  },
});

export const compareShows = defineTool({
  name: "compare_shows",
  title: "Compare several shows side by side",
  description:
    "Put two or more shows next to each other on the numbers that matter: chart rank, review sentiment, catalogue size and publishing cadence. This is the competitive read, and doing it by hand is a dozen calls plus the joining. Capped at six shows, because each one costs several requests against a rate-limited API.",
  schema: {
    shows: z
      .array(z.string())
      .min(2)
      .max(6)
      .describe("Two to six shows, each an Apple id or an Apple Podcasts URL."),
    storefront: z
      .string()
      .optional()
      .describe("Single storefront to compare within. Defaults to the configured one."),
    reviews: z
      .number()
      .int()
      .min(0)
      .max(200)
      .optional()
      .describe("Reviews to sample per show. 0 skips them, which makes this much faster."),
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const storefront = ctx.storefront(args.storefront);
    const reviewSample = args.reviews ?? 50;

    // One chart, reused for every show. Fetching it per show would multiply
    // the request count for identical data.
    let chart;
    try {
      chart = await ctx.clients.charts.chart({
        storefront,
        kind: "podcasts",
        limit: MAX_CHART_SIZE,
      });
    } catch {
      chart = undefined;
    }

    const rows = [];

    for (const input of args.shows) {
      const row: Record<string, unknown> = {};
      try {
        const link = resolveLink(input);
        row.show_apple_id = link.showId;

        const { show } = await ctx.clients.itunes.lookup({ id: link.showId, storefront });
        row.name = show?.collectionName;
        row.author = show?.artistName;
        row.genre = show?.primaryGenreName;
        row.episodes_in_catalog = show?.trackCount;
        row.latest_release = show?.releaseDate;
        row.rank = chart ? (positionOf(chart, link.showId)?.rank ?? null) : null;

        if (reviewSample > 0) {
          try {
            const reviews = await ctx.clients.reviews.forShow({
              showId: link.showId,
              storefront,
              limit: reviewSample,
            });
            const stats = breakdown(reviews);
            row.reviews_sampled = stats.count;
            row.average_of_sample = stats.average;
          } catch {
            row.reviews_sampled = 0;
          }
        }

        const feedUrl = show?.feedUrl;
        if (typeof feedUrl === "string" && feedUrl) {
          try {
            const feed = await ctx.clients.feed.fetch(feedUrl, { limit: 60 });
            const pace = cadence(feed.episodes.map((e) => e.publishedAt));
            row.episodes_in_feed = feed.totalEpisodes;
            row.episodes_per_month = pace.per_month;
            row.days_between_episodes = pace.median_days;
          } catch {
            row.episodes_in_feed = null;
          }
        }
      } catch (error) {
        row.error = (error as Error).message;
      }
      rows.push(row);
    }

    return {
      storefront,
      chart_updated: chart?.updated ?? null,
      shows: rows,
      note: "Rank is Apple's Top Shows position in this one storefront, out of 100, and null means outside it. Review averages are over the recent sample, not lifetime. Cadence is the median gap between recent episodes, which is more honest than a mean when a show has had a hiatus.",
    };
  },
});

export const findSimilarShows = defineTool({
  name: "find_similar_shows",
  title: "Find shows like this one",
  description:
    "Find shows adjacent to a given one, by searching its genre and its own subject matter and removing itself from the results. Apple publishes no 'listeners also subscribed' data through any open endpoint, so this is genre and topic adjacency rather than true audience overlap, and it says so rather than implying otherwise. Useful for mapping a niche before deciding where a new show fits.",
  schema: {
    ...showArg,
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("How many candidates to return. Defaults to 15."),
    ...storefrontArg,
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const link = resolveLink(args.show);
    const storefront = ctx.storefront(args.storefront ?? link.storefront);
    const limit = clamp(args.limit, 15, 50);

    const { show } = await ctx.clients.itunes.lookup({ id: link.showId, storefront });
    if (!show) throw new Error(`No show with id ${link.showId} in the ${storefront} storefront.`);

    const genreIds = Array.isArray(show.genreIds) ? (show.genreIds as string[]) : [];
    // genreIds[0] is Apple's top-level "Podcasts" id on most rows, so the
    // meaningful genre is the next one along.
    const genreId = genreIds.find((id) => id !== "26");

    const name = String(show.collectionName ?? "");
    const author = String(show.artistName ?? "");

    const seen = new Map<string, Record<string, unknown>>();
    const add = (rows: Record<string, unknown>[]) => {
      for (const row of rows) {
        const id = String(row.collectionId ?? row.trackId ?? "");
        if (!id || id === link.showId) continue;
        if (!seen.has(id)) seen.set(id, row);
      }
    };

    // Two passes: the genre, which finds neighbours, and the show's own title
    // words, which finds shows about the same thing in a different genre.
    if (genreId) {
      add(
        await ctx.clients.itunes.search({
          term: String(show.primaryGenreName ?? name),
          entity: "podcast",
          storefront,
          limit: 50,
          genreId,
        }),
      );
    }

    const topicWords = name
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3)
      .slice(0, 4)
      .join(" ");

    if (topicWords) {
      add(
        await ctx.clients.itunes.search({
          term: topicWords,
          entity: "podcast",
          storefront,
          limit: 50,
        }),
      );
    }

    const candidates = [...seen.values()]
      .filter((row) => String(row.artistName ?? "") !== author || String(row.collectionName ?? "") !== name)
      .slice(0, limit);

    return {
      seed: { apple_id: link.showId, name, author, genre: show.primaryGenreName },
      storefront,
      count: candidates.length,
      shows: candidates.map((row) => ({
        apple_id: row.collectionId ?? row.trackId,
        name: row.collectionName,
        author: row.artistName,
        genre: row.primaryGenreName,
        episodes: row.trackCount,
        latest_release: row.releaseDate,
        feed_url: row.feedUrl,
      })),
      note: "Adjacency by genre and title, not by audience. Apple exposes no listener-overlap data publicly, so treat this as a candidate list to look at rather than a ranked similarity. compare_shows is the next step once the list is narrowed.",
    };
  },
});

export const RESEARCH_TOOLS = [getShowProfile, compareShows, findSimilarShows];
