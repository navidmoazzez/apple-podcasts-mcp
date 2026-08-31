/**
 * Your own library, on this Mac.
 *
 * These read the Apple Podcasts database directly. Nothing leaves the machine
 * and nothing is written to. They are the only tools here that do not touch the
 * network, and the only ones that do not work on a machine without the app.
 *
 * `search_library` is the reason this group exists. Apple caches a transcript
 * excerpt for effectively every episode of every show you follow, and on a
 * normally-used library that is tens of thousands of excerpts of real spoken
 * text. Searching it answers "where did I hear about X", which is not a
 * question any catalog can answer and is usually the one a person actually has.
 *
 * Two limits are repeated in the tool descriptions rather than hidden in the
 * README, because a model that does not know them will answer confidently and
 * wrongly:
 *
 *   The excerpts are excerpts. Apple's full transcripts are access-controlled
 *   and unreadable outside the Podcasts app.
 *
 *   Play data usually is not here. On a library synced from a phone, the
 *   playhead and play-count columns are empty, so nothing here can say what was
 *   listened to. `library_stats` reports whether this particular library has
 *   usable play data before anything is inferred from it.
 *
 * The whole group disappears from the tool list under APPLE_PODCASTS_LIBRARY=0.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { renderLibraryEpisodes, renderLibraryShows } from "../format/podcasts.js";
import { clamp, confirmArg, defineTool, limitArg, snippet } from "./kit.js";

export const listSubscriptions = defineTool({
  name: "list_subscriptions",
  title: "Shows you follow",
  description:
    "Every podcast in the Apple Podcasts library on this Mac, followed shows first. Each carries a local id, which the other library tools take, and Apple's catalog id, which every public tool here takes. That pairing is what lets a question move from your own library out to charts, reviews and the feed.",
  schema: {
    followed_only: z
      .boolean()
      .optional()
      .describe(
        "Only shows currently followed. Off by default, because the library also holds shows played once without following, and those are often the interesting ones.",
      ),
    ...limitArg(1000, "Shows to return."),
  },
  risk: "read",
  surface: "library",
  handler: async (args, ctx) =>
    ctx.clients.withLibrary((library) =>
      renderLibraryShows(
        library.shows({ subscribedOnly: args.followed_only, limit: clamp(args.limit, 200, 1000) }),
      ),
    ),
});

export const searchLibrary = defineTool({
  name: "search_library",
  title: "Search your library, including transcripts",
  description:
    "Keyword search across every episode of every show in your library: titles, show notes, and the transcript excerpts Apple has cached. This is the closest thing to full-text search over everything you follow, and it answers 'which episode was that in'. Each result says whether the term matched the title, the notes, or the transcript, which matters: a title match means the episode is about the term, a transcript-only match means someone mentioned it in passing. The excerpts are excerpts, not full transcripts.",
  schema: {
    query: z.string().describe("The word or phrase to look for. Matching is literal, not fuzzy."),
    show: z
      .string()
      .optional()
      .describe("Restrict to one show, by local id, Apple id, or title. Omit to search everything."),
    include_transcripts: z
      .boolean()
      .optional()
      .describe(
        "Search the cached transcript excerpts as well as titles and notes. On by default, and it is the point of this tool.",
      ),
    full: z
      .boolean()
      .optional()
      .describe("Return complete notes and excerpts instead of trimmed ones. Much larger."),
    ...limitArg(200, "Episodes to return, newest first."),
  },
  risk: "read",
  surface: "library",
  handler: async (args, ctx) =>
    ctx.clients.withLibrary((library) => {
      let showId: number | undefined;
      if (args.show) {
        const show = library.findShow(args.show);
        if (!show) {
          return `<library_episodes count="0" source="search"><note>No show in this library matches "${args.show}". Call list_subscriptions to see what is here.</note></library_episodes>`;
        }
        showId = show.id;
      }

      const episodes = library.search({
        query: args.query,
        showId,
        includeTranscripts: args.include_transcripts,
        limit: clamp(args.limit, 25, 200),
      });

      return renderLibraryEpisodes(episodes, {
        source: "library-search",
        query: args.query,
        full: args.full,
      });
    }),
});

export const listRecentEpisodes = defineTool({
  name: "list_recent_episodes",
  title: "Newest episodes in your library",
  description:
    "The most recently published episodes across the shows you follow, newest first. This is the local database's view, so it reflects the last time the Podcasts app refreshed rather than what a feed has published in the last minute.",
  schema: {
    show: z.string().optional().describe("Restrict to one show, by local id, Apple id, or title."),
    since_hours: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Only episodes published within this many hours."),
    full: z.boolean().optional().describe("Return complete show notes rather than an excerpt."),
    ...limitArg(200, "Episodes to return."),
  },
  risk: "read",
  surface: "library",
  handler: async (args, ctx) =>
    ctx.clients.withLibrary((library) => {
      let showId: number | undefined;
      if (args.show) {
        const show = library.findShow(args.show);
        if (!show) {
          return `<library_episodes count="0" source="recent"><note>No show in this library matches "${args.show}".</note></library_episodes>`;
        }
        showId = show.id;
      }

      const episodes = library.recent({
        showId,
        sinceHours: args.since_hours,
        limit: clamp(args.limit, 25, 200),
      });

      return renderLibraryEpisodes(episodes, { source: "recent", full: args.full });
    }),
});

export const listSavedEpisodes = defineTool({
  name: "list_saved_episodes",
  title: "Saved, bookmarked or downloaded episodes",
  description:
    "Episodes flagged in the Podcasts app: saved, bookmarked, or downloaded to this Mac. This is the app's own shortlist and is the closest thing in the library to an explicit signal of interest, which matters because the play-position data does not sync to a Mac.",
  schema: {
    kind: z
      .enum(["saved", "bookmarked", "downloaded"])
      .describe(
        "'saved' and 'bookmarked' are deliberate marks. 'downloaded' means the audio file is on this Mac.",
      ),
    full: z.boolean().optional().describe("Return complete show notes rather than an excerpt."),
    ...limitArg(200, "Episodes to return."),
  },
  risk: "read",
  surface: "library",
  handler: async (args, ctx) =>
    ctx.clients.withLibrary((library) =>
      renderLibraryEpisodes(
        library.flagged({ kind: args.kind, limit: clamp(args.limit, 50, 200) }),
        { source: args.kind, full: args.full },
      ),
    ),
});

export const getLibraryEpisode = defineTool({
  name: "get_library_episode",
  title: "One episode from your library, in full",
  description:
    "One episode by its local id, with complete show notes and the whole cached transcript excerpt rather than a trimmed one. Local ids come from search_library and the other library tools.",
  schema: {
    id: z.number().int().describe("The local episode id, as returned by the other library tools."),
  },
  risk: "read",
  surface: "library",
  handler: async (args, ctx) =>
    ctx.clients.withLibrary((library) => {
      const episode = library.episode(args.id);
      if (!episode) {
        return `<library_episodes count="0" source="episode"><note>No episode with local id ${args.id} in this library. These ids are local to this Mac and are not Apple ids.</note></library_episodes>`;
      }
      return renderLibraryEpisodes([episode], { source: "episode", full: true });
    }),
});

export const libraryStats = defineTool({
  name: "library_stats",
  title: "What is actually in your library",
  description:
    "Counts for the local library: shows, followed shows, episodes, how many carry a cached transcript excerpt, and how many are saved, bookmarked or downloaded. Call this before drawing any conclusion about listening habits. It reports whether this library holds usable play data, and on a Mac it very often does not, because listening progress is tracked on the device you listen on and does not sync here.",
  schema: {},
  risk: "read",
  surface: "library",
  handler: async (_args, ctx) =>
    ctx.clients.withLibrary((library) => ({
      library_path: ctx.config.libraryPath,
      ...library.stats(),
    })),
});

export const exportSubscriptions = defineTool({
  name: "export_subscriptions",
  title: "Export your subscriptions as OPML",
  description:
    "Write the shows you follow to an OPML file, the format every podcast app imports. This is the one tool here that writes anything, so it needs confirm: true and will overwrite whatever is at the path. It is the practical answer to leaving Apple Podcasts, or to backing up a follow list that exists nowhere else.",
  schema: {
    path: z
      .string()
      .describe("Where to write the file, for example ~/Desktop/podcasts.opml."),
    followed_only: z
      .boolean()
      .optional()
      .describe("Only currently-followed shows. On by default, which is what an import wants."),
    ...confirmArg,
  },
  risk: "destructive",
  surface: "library",
  summary: (args) => `write an OPML export to ${snippet(args.path, 80)}`,
  handler: async (args, ctx) =>
    ctx.clients.withLibrary((library) => {
      const shows = library
        .shows({ subscribedOnly: args.followed_only !== false, limit: 1000 })
        .filter((show) => show.feedUrl);

      const target = resolve(args.path.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
      writeFileSync(target, buildOpml(shows), "utf8");

      return {
        written: target,
        shows: shows.length,
        note:
          shows.length === 0
            ? "No show in this library has a feed URL, so the file is empty. Shows delivered through Apple Podcasts Connect rather than RSS have no feed to export."
            : "OPML imports into every major podcast app. Shows without a feed URL were skipped, because there is nothing for another app to subscribe to.",
      };
    }),
});

/**
 * Build an OPML document.
 *
 * Assembled by hand rather than through a serialiser because the format is a
 * fixed twelve lines and every podcast app reads the same subset of it. The
 * escaping is the part that matters: show titles contain ampersands and quotes
 * regularly, and an unescaped one produces a file that silently fails to import.
 */
function buildOpml(shows: { title: string; feedUrl?: string; websiteUrl?: string }[]): string {
  const esc = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const outlines = shows
    .map((show) => {
      const html = show.websiteUrl ? ` htmlUrl="${esc(show.websiteUrl)}"` : "";
      return `      <outline type="rss" text="${esc(show.title)}" title="${esc(show.title)}" xmlUrl="${esc(show.feedUrl ?? "")}"${html} />`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Apple Podcasts subscriptions</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${outlines}
  </body>
</opml>
`;
}

export const LIBRARY_TOOLS = [
  listSubscriptions,
  searchLibrary,
  listRecentEpisodes,
  listSavedEpisodes,
  getLibraryEpisode,
  libraryStats,
  exportSubscriptions,
];
