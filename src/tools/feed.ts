/**
 * The RSS feed: the complete record, and the only readable transcripts.
 *
 * Apple's catalog is a lossy cache of a show's feed. The feed has every episode
 * rather than a recent window, full show notes rather than a truncated
 * description, and the entire Podcasting 2.0 namespace that Apple ignores.
 *
 * `find_transcripts` is the one that changes what is possible. Apple's own
 * transcripts are access-controlled and cannot be fetched by anything outside
 * the Podcasts app. A `<podcast:transcript>` URL in a feed is public. When a
 * show publishes them, they are the difference between reasoning about a
 * description and reasoning about what was actually said.
 *
 * `check_feed` is the tool a show owner needs before they have any listeners.
 * A feed missing something Apple requires is rejected at submission or degraded
 * quietly afterwards, and the symptom shows up days later as "my show is not
 * appearing" with nothing pointing at the cause.
 */

import { z } from "zod";
import { checkFeed } from "../api/feed.js";
import { renderFeed, renderFeedEpisode } from "../format/podcasts.js";
import { resolveLink } from "../api/itunes.js";
import { clamp, defineTool, limitArg } from "./kit.js";

/**
 * Accept either a feed URL or an Apple id, and end up with a feed URL.
 *
 * People have whichever one they were given. Requiring the feed URL would mean
 * every call starts with a lookup the tool could have done itself.
 */
async function feedUrlFor(
  input: string,
  ctx: { clients: { itunes: { lookup: (o: { id: string; storefront: string }) => Promise<{ show?: Record<string, unknown> }> } }; config: { storefront: string } },
  storefront?: string,
): Promise<string> {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed) && !/podcasts\.apple\.com/i.test(trimmed)) {
    return trimmed;
  }

  const link = resolveLink(trimmed);
  const { show } = await ctx.clients.itunes.lookup({
    id: link.showId,
    storefront: storefront ?? link.storefront ?? ctx.config.storefront,
  });

  const feedUrl = show?.feedUrl;
  if (typeof feedUrl !== "string" || !feedUrl) {
    throw new Error(
      `Apple has no feed URL for show ${link.showId}. That happens on shows delivered through Apple Podcasts Connect rather than an RSS feed, and on shows Apple has removed. There is no feed to read.`,
    );
  }
  return feedUrl;
}

export const getFeed = defineTool({
  name: "get_feed",
  title: "Read a podcast's RSS feed",
  description:
    "Fetch and parse a show's RSS feed: the channel metadata and its episodes, newest first. This is the complete record, unlike Apple's catalog, which returns only recent episodes and drops the Podcasting 2.0 fields entirely. Takes an RSS URL, an Apple id, or an Apple Podcasts link. A feed is the show's own server, so it can be slow or unreachable in ways Apple is not.",
  schema: {
    show: z
      .string()
      .describe("An RSS feed URL, an Apple Podcasts numeric id, or an Apple Podcasts URL."),
    ...limitArg(500, "Episodes to return, newest first. The feed's true total is always reported."),
    include_episodes: z
      .boolean()
      .optional()
      .describe("Set false for channel metadata only, which is much smaller."),
    storefront: z
      .string()
      .optional()
      .describe("Only used when resolving an Apple id to a feed URL."),
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const feedUrl = await feedUrlFor(args.show, ctx, args.storefront);
    const includeEpisodes = args.include_episodes !== false;
    const feed = await ctx.clients.feed.fetch(feedUrl, {
      limit: includeEpisodes ? clamp(args.limit, 25, 500) : 0,
    });
    return renderFeed(feed, { includeEpisodes });
  },
});

export const findTranscripts = defineTool({
  name: "find_transcripts",
  title: "Find publicly readable transcripts",
  description:
    "List episodes of a show that publish a transcript in their feed, with the URL, format and language of each. These are Podcasting 2.0 transcripts the show chose to publish, and unlike Apple's own transcripts they are public and fetchable. Whether any exist is entirely the show's choice, and most shows publish none. Returns nothing rather than failing when a show publishes none.",
  schema: {
    show: z
      .string()
      .describe("An RSS feed URL, an Apple Podcasts numeric id, or an Apple Podcasts URL."),
    ...limitArg(500, "Episodes to scan, newest first."),
    storefront: z.string().optional().describe("Only used when resolving an Apple id."),
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const feedUrl = await feedUrlFor(args.show, ctx, args.storefront);
    const feed = await ctx.clients.feed.fetch(feedUrl, { limit: clamp(args.limit, 100, 500) });

    const withTranscripts = feed.episodes.filter((episode) => episode.transcripts.length);

    return {
      show: feed.title,
      feed_url: feed.feedUrl,
      episodes_scanned: feed.episodes.length,
      episodes_in_feed: feed.totalEpisodes,
      episodes_with_transcripts: withTranscripts.length,
      transcripts: withTranscripts.map((episode) => ({
        title: episode.title,
        published_at: episode.publishedAt,
        guid: episode.guid,
        transcripts: episode.transcripts,
      })),
      note: withTranscripts.length
        ? "These URLs are public and can be fetched directly. Formats vary: text/vtt and application/srt are timed text, application/json is Podcasting 2.0's speaker-tagged format."
        : "This show publishes no transcripts in its feed. Apple may still show transcripts inside the Podcasts app, but those are generated by Apple, access-controlled, and not readable by anything outside the app. If the show is one you follow, search_library can search the excerpts Apple cached on this Mac.",
    };
  },
});

export const checkFeedHealth = defineTool({
  name: "check_feed",
  title: "Validate a feed against Apple's requirements",
  description:
    "Check a podcast's RSS feed against what Apple actually requires and warn about what will cost the show later. Errors are fields Apple documents as required, and a feed missing one is rejected at submission or degraded silently after it. Warnings are things that do not block distribution but hurt: no owner email stalls a claim, an unstable guid re-publishes the entire back catalogue as new the next time the show changes host.",
  schema: {
    show: z
      .string()
      .describe("An RSS feed URL, an Apple Podcasts numeric id, or an Apple Podcasts URL."),
    ...limitArg(500, "Episodes to inspect. More is a more thorough check and a larger download."),
    storefront: z.string().optional().describe("Only used when resolving an Apple id."),
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const feedUrl = await feedUrlFor(args.show, ctx, args.storefront);
    const feed = await ctx.clients.feed.fetch(feedUrl, { limit: clamp(args.limit, 100, 500) });
    const issues = checkFeed(feed);

    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warning");

    return {
      show: feed.title,
      feed_url: feed.feedUrl,
      episodes_checked: feed.episodes.length,
      episodes_in_feed: feed.totalEpisodes,
      passes: errors.length === 0,
      errors,
      warnings,
      summary: errors.length
        ? `${errors.length} problem(s) Apple treats as required, and ${warnings.length} warning(s).`
        : `No required field is missing. ${warnings.length} warning(s) worth looking at.`,
    };
  },
});

export const getFeedEpisode = defineTool({
  name: "get_feed_episode",
  title: "One episode from a feed, in full",
  description:
    "Find one episode in a show's feed by title, guid or episode number, and return it with its complete show notes, audio URL, chapters and transcripts. Use this when a listing gave a truncated description and the full notes matter, since show notes are where the links, the timestamps and the guest details live.",
  schema: {
    show: z
      .string()
      .describe("An RSS feed URL, an Apple Podcasts numeric id, or an Apple Podcasts URL."),
    episode: z
      .string()
      .describe(
        "A guid, an episode number, or part of the title. A title match is case-insensitive and takes the first hit, newest first.",
      ),
    ...limitArg(500, "How deep into the feed to search."),
    storefront: z.string().optional().describe("Only used when resolving an Apple id."),
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const feedUrl = await feedUrlFor(args.show, ctx, args.storefront);
    const feed = await ctx.clients.feed.fetch(feedUrl, { limit: clamp(args.limit, 200, 500) });

    const needle = args.episode.trim().toLowerCase();
    const asNumber = /^\d+$/.test(needle) ? Number(needle) : undefined;

    const found =
      feed.episodes.find((e) => e.guid?.toLowerCase() === needle) ??
      (asNumber !== undefined
        ? feed.episodes.find((e) => e.episodeNumber === asNumber)
        : undefined) ??
      feed.episodes.find((e) => e.title.toLowerCase().includes(needle));

    if (!found) {
      return {
        found: false,
        show: feed.title,
        episodes_searched: feed.episodes.length,
        episodes_in_feed: feed.totalEpisodes,
        note:
          feed.episodes.length < feed.totalEpisodes
            ? `Searched the newest ${feed.episodes.length} of ${feed.totalEpisodes} episodes. Raise limit to search further back.`
            : `Searched every episode in the feed. Nothing matched "${args.episode}".`,
      };
    }

    return renderFeedEpisode(found);
  },
});

export const FEED_TOOLS = [getFeed, getFeedEpisode, findTranscripts, checkFeedHealth];
