/**
 * The public catalog: finding shows and episodes that exist.
 *
 * Everything here works with no credential and no setup, which is worth saying
 * because it is unusual. The whole of Apple's podcast index is open.
 *
 * The recurring trap these tools guard against is the storefront. Search is
 * per country, silently, and a show can be published in some markets and not
 * others. A search that returns nothing in `us` is not evidence the show does
 * not exist, so every empty result here says so rather than letting a model
 * conclude otherwise.
 */

import { z } from "zod";
import { clamp, defineTool, limitArg, showArg, storefrontArg } from "./kit.js";
import { resolveLink } from "../api/itunes.js";
import {
  renderCatalogEpisodeList,
  renderShow,
  renderShowList,
} from "../format/podcasts.js";

export const searchPodcasts = defineTool({
  name: "search_podcasts",
  title: "Search Apple Podcasts for shows",
  description:
    "Search Apple's podcast catalog for shows by name, topic, host or keyword. This is the same index the Podcasts app searches, and it needs no account. Results are per storefront and differ by country. Returns the Apple id and the RSS feed URL for each hit, which is what every other tool here takes.",
  schema: {
    query: z
      .string()
      .describe("What to search for: a show name, a host, a topic, or a phrase."),
    genre_id: z
      .string()
      .optional()
      .describe("Restrict to one genre, by the numeric id from list_genres."),
    match: z
      .enum(["any", "title", "author"])
      .optional()
      .describe(
        "Which field to match. 'title' and 'author' are exact-field searches and are much narrower than the default, which searches everything Apple indexes.",
      ),
    ...limitArg(200, "Apple caps this at 200."),
    ...storefrontArg,
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const storefront = ctx.storefront(args.storefront);
    const attribute =
      args.match === "title" ? "titleTerm" : args.match === "author" ? "authorTerm" : undefined;

    const rows = await ctx.clients.itunes.search({
      term: args.query,
      entity: "podcast",
      storefront,
      limit: clamp(args.limit, 10, 200),
      genreId: args.genre_id,
      attribute,
    });

    return renderShowList(rows, {
      storefront,
      source: "search",
      meta: { query: args.query, genre_id: args.genre_id, match: args.match },
    });
  },
});

export const searchEpisodes = defineTool({
  name: "search_episodes",
  title: "Search Apple Podcasts for episodes",
  description:
    "Search Apple's catalog for individual episodes across all shows. Useful for finding who has covered a topic, or which episode a guest appeared on. Apple's episode index is shallower than its show index and skews recent, so an old episode may not surface here even when the show is indexed; the show's RSS feed via get_feed is the complete record.",
  schema: {
    query: z
      .string()
      .describe(
        "What to search for. Including the show name narrows this a great deal, because Apple ranks episode matches loosely.",
      ),
    ...limitArg(200, "Apple caps this at 200."),
    ...storefrontArg,
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const storefront = ctx.storefront(args.storefront);
    const rows = await ctx.clients.itunes.search({
      term: args.query,
      entity: "podcastEpisode",
      storefront,
      limit: clamp(args.limit, 10, 200),
    });

    return renderCatalogEpisodeList(rows, {
      storefront,
      source: "search",
      meta: { query: args.query },
    });
  },
});

export const getPodcast = defineTool({
  name: "get_podcast",
  title: "Get one show from the catalog",
  description:
    "Full catalog record for one show: name, author, genres, episode count, latest release date, artwork and its RSS feed URL. Takes an Apple id or a pasted Apple Podcasts URL. The feed URL it returns is the way into the complete episode backlog through get_feed.",
  schema: { ...showArg, ...storefrontArg },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const link = resolveLink(args.show);
    // A pasted link carries the storefront it was shared from. Honouring it
    // avoids a 404 on a show that is only published in some markets.
    const storefront = ctx.storefront(args.storefront ?? link.storefront);

    const { show } = await ctx.clients.itunes.lookup({ id: link.showId, storefront });
    if (!show) {
      return `<podcasts count="0" source="lookup" storefront="${storefront}"><note>No show with id ${link.showId} in this storefront.</note></podcasts>`;
    }
    return renderShow(show, { storefront, full: true });
  },
});

export const getPodcastEpisodes = defineTool({
  name: "get_podcast_episodes",
  title: "Recent episodes of one show",
  description:
    "Recent episodes for a show from Apple's catalog, newest first. Apple returns a recent window rather than the full back catalogue and the cutoff moves, so treat a short list as Apple's limit and not as the show's history. For every episode a show has ever published, use get_feed with the feed URL from get_podcast.",
  schema: {
    ...showArg,
    ...limitArg(200, "Apple often returns fewer than requested regardless of this."),
    ...storefrontArg,
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const link = resolveLink(args.show);
    const storefront = ctx.storefront(args.storefront ?? link.storefront);
    const limit = clamp(args.limit, 25, 200);

    const { show, episodes } = await ctx.clients.itunes.lookup({
      id: link.showId,
      storefront,
      withEpisodes: true,
      limit,
    });

    const total = Number(show?.trackCount);
    const meta: Record<string, unknown> = {
      show: show?.collectionName,
      show_apple_id: link.showId,
    };
    if (Number.isFinite(total) && total > episodes.length) {
      meta.note = `Apple lists ${total} episodes for this show but returned ${episodes.length}. Use get_feed for all of them.`;
    }

    return renderCatalogEpisodeList(episodes, { storefront, source: "lookup", meta });
  },
});

export const listGenres = defineTool({
  name: "list_genres",
  title: "The Apple Podcasts genre tree",
  description:
    "Apple's podcast categories and their numeric ids, fetched live rather than hardcoded. The ids are what search_podcasts takes as genre_id. Note that these are the categories Apple files shows under: they are not charts, and there is no way to request a chart for one.",
  schema: {
    ...storefrontArg,
    top_level_only: z
      .boolean()
      .optional()
      .describe("Return only the 19 top-level categories, without their subcategories."),
  },
  risk: "read",
  surface: "public",
  handler: async (args, ctx) => {
    const storefront = ctx.storefront(args.storefront);
    const tree = await ctx.clients.itunes.genres(storefront);

    if (!tree) {
      return { storefront, genres: [], note: "Apple returned no genre tree for this storefront." };
    }

    return {
      storefront,
      count: tree.subgenres.length,
      genres: tree.subgenres.map((genre) => ({
        id: genre.id,
        name: genre.name,
        ...(args.top_level_only
          ? {}
          : {
              subgenres: genre.subgenres.map((sub) => ({ id: sub.id, name: sub.name })),
            }),
      })),
    };
  },
});

export const resolveAppleLink = defineTool({
  name: "resolve_apple_link",
  title: "Turn an Apple Podcasts link into ids",
  description:
    "Take an Apple Podcasts URL someone pasted and return the show id, the episode id when the link points at one, and the storefront the link came from. Every other tool here is keyed by id, and Apple's share URLs hide the episode id in a query parameter rather than the path, so this is the bridge between what a person has and what the tools take.",
  schema: {
    url: z
      .string()
      .describe("An Apple Podcasts URL, or a bare numeric id, which passes straight through."),
  },
  risk: "read",
  surface: "public",
  handler: async (args) => {
    const link = resolveLink(args.url);
    return {
      show_apple_id: link.showId,
      episode_apple_id: link.episodeId ?? null,
      storefront: link.storefront ?? null,
      points_at: link.kind,
      note: link.storefront
        ? `This link was shared from the ${link.storefront} storefront. Passing that storefront to other tools avoids a miss on a show not published everywhere.`
        : `This link carries no storefront, so tools will use the configured default.`,
    };
  },
});

export const CATALOG_TOOLS = [
  searchPodcasts,
  searchEpisodes,
  getPodcast,
  getPodcastEpisodes,
  listGenres,
  resolveAppleLink,
];
