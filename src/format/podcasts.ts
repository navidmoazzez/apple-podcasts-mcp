/**
 * Shaping results for a model rather than dumping the API's JSON.
 *
 * A single show from the Search API is about forty fields, most of which are
 * store plumbing: six artwork sizes, three censored-name variants, prices in a
 * currency for a thing that is free, and a wrapper type. A listing of twenty of
 * those is tens of thousands of tokens, paid on every turn, to carry maybe six
 * facts anyone asked about.
 *
 * So results come back as tagged text: roughly a tenth the size, with the
 * fields a caller actually reasons about, and the identifiers a follow-up call
 * needs sitting where they can be found. The tags matter more than they look.
 * A model reading `<podcast id="…" apple_id="…">` knows what to pass to the
 * next tool; the same data as prose has to be guessed at.
 *
 * Three rules hold everywhere here:
 *
 * **Every list says which storefront it came from.** Apple's catalog, charts
 * and reviews are all per-country and they diverge. A result that does not
 * carry its storefront invites a comparison between two markets that reads as
 * a change over time.
 *
 * **Dates are ISO-8601 UTC.** Apple mixes RFC-2822 in feeds, its own format in
 * the catalog, and seconds-since-2001 in the local database. Normalising once
 * here is what lets two timestamps be compared at all.
 *
 * **Text somebody else wrote is fenced**, never interpolated bare. See
 * `safety.ts` for why that is not optional on the reviews path.
 */

import { fence } from "../safety.js";
import type { Chart } from "../api/charts.js";
import type { Feed, FeedEpisode } from "../api/feed.js";
import type { RatingBreakdown, Review } from "../api/reviews.js";
import type { LibraryEpisode, LibraryShow } from "../library/library.js";

/** Escape the five characters that would break the tagging. */
function attr(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** Render an attribute only when it has a value, so empty ones cost nothing. */
function opt(name: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return ` ${name}="${attr(value)}"`;
}

function seconds(total: number | undefined): string | undefined {
  if (total === undefined || !Number.isFinite(total) || total <= 0) return undefined;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.round(total % 60);
  if (hours) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

/** Apple's catalog dates are ISO already, but not always parseable. Normalise. */
function iso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Trim long prose to a readable excerpt.
 *
 * Show notes routinely run to several thousand characters of sponsor copy and
 * timestamps. A listing of twenty of those is not a useful answer, so listings
 * excerpt and the single-item tools return the whole thing.
 */
function excerpt(text: string | undefined, length: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

// ---------------------------------------------------------------- catalog

/** One show from the Search API. */
export function renderShow(raw: Record<string, unknown>, options: { storefront: string; full?: boolean } = { storefront: "us" }): string {
  const id = raw.collectionId ?? raw.trackId;
  const description = options.full
    ? (raw.description as string | undefined)
    : excerpt(raw.description as string | undefined, 300);

  const lines = [
    `<podcast apple_id="${attr(id)}"` +
      opt("name", raw.collectionName ?? raw.trackName) +
      opt("author", raw.artistName) +
      opt("storefront", options.storefront) +
      opt("episodes", raw.trackCount) +
      opt("latest_episode", iso(raw.releaseDate)) +
      opt("genre", raw.primaryGenreName) +
      opt("explicit", raw.collectionExplicitness === "explicit" ? "yes" : undefined) +
      opt("country", raw.country) +
      ">",
  ];

  if (raw.feedUrl) lines.push(`  <feed_url>${attr(raw.feedUrl)}</feed_url>`);
  if (raw.collectionViewUrl) lines.push(`  <apple_url>${attr(raw.collectionViewUrl)}</apple_url>`);
  if (raw.artworkUrl600) lines.push(`  <artwork>${attr(raw.artworkUrl600)}</artwork>`);

  const genres = Array.isArray(raw.genres) ? (raw.genres as string[]).join(", ") : undefined;
  if (genres) lines.push(`  <genres>${attr(genres)}</genres>`);

  if (description) {
    lines.push(`  <description>`, fence("show_notes", description), `  </description>`);
  }

  lines.push(`</podcast>`);
  return lines.join("\n");
}

export function renderShowList(
  rows: Record<string, unknown>[],
  options: { storefront: string; source: string; meta?: Record<string, unknown> },
): string {
  const meta = Object.entries(options.meta ?? {})
    .map(([k, v]) => opt(k, v))
    .join("");
  const head = `<podcasts count="${rows.length}" source="${attr(options.source)}" storefront="${attr(options.storefront)}"${meta}>`;
  if (!rows.length) {
    return `${head}\n  <note>No shows matched in the ${attr(options.storefront)} storefront. Apple's catalog is per country, so a show published only in other markets will not appear here. Try another storefront before concluding it does not exist.</note>\n</podcasts>`;
  }
  const body = rows
    .map((row) => indent(renderShow(row, { storefront: options.storefront })))
    .join("\n\n");
  return `${head}\n${body}\n</podcasts>`;
}

/** One episode from the Search API. */
export function renderCatalogEpisode(
  raw: Record<string, unknown>,
  options: { storefront: string; full?: boolean },
): string {
  const duration = Number(raw.trackTimeMillis);
  const description = options.full
    ? (raw.description as string | undefined)
    : excerpt((raw.description as string | undefined) ?? (raw.shortDescription as string | undefined), 300);

  const lines = [
    `<episode apple_id="${attr(raw.trackId)}"` +
      opt("title", raw.trackName) +
      opt("show", raw.collectionName) +
      opt("show_apple_id", raw.collectionId) +
      opt("published_at", iso(raw.releaseDate)) +
      opt("duration", Number.isFinite(duration) ? seconds(duration / 1000) : undefined) +
      opt("guid", raw.episodeGuid) +
      opt("transcript_available", raw.closedCaptioning === "closed" ? "yes" : undefined) +
      opt("storefront", options.storefront) +
      ">",
  ];

  if (raw.episodeUrl) lines.push(`  <audio_url>${attr(raw.episodeUrl)}</audio_url>`);
  if (raw.trackViewUrl) lines.push(`  <apple_url>${attr(raw.trackViewUrl)}</apple_url>`);
  if (description) {
    lines.push(`  <description>`, fence("show_notes", description), `  </description>`);
  }
  lines.push(`</episode>`);
  return lines.join("\n");
}

export function renderCatalogEpisodeList(
  rows: Record<string, unknown>[],
  options: { storefront: string; source: string; meta?: Record<string, unknown> },
): string {
  const meta = Object.entries(options.meta ?? {})
    .map(([k, v]) => opt(k, v))
    .join("");
  const head = `<episodes count="${rows.length}" source="${attr(options.source)}" storefront="${attr(options.storefront)}"${meta}>`;
  if (!rows.length) return `${head}\n  <note>No episodes returned.</note>\n</episodes>`;
  const body = rows
    .map((row) => indent(renderCatalogEpisode(row, { storefront: options.storefront })))
    .join("\n\n");
  return `${head}\n${body}\n</episodes>`;
}

// ------------------------------------------------------------------ charts

export function renderChart(chart: Chart): string {
  const head =
    `<chart kind="${attr(chart.kind)}" storefront="${attr(chart.storefront)}"` +
    opt("title", chart.title) +
    opt("updated", iso(chart.updated)) +
    ` count="${chart.entries.length}">`;

  const rows = chart.entries.map((entry) => {
    const genres = entry.genres.join(", ");
    return (
      `  <entry rank="${entry.rank}"` +
      opt(chart.kind === "podcasts" ? "apple_id" : "episode_apple_id", entry.id) +
      opt("show_apple_id", chart.kind === "podcast-episodes" ? entry.showId : undefined) +
      opt("name", entry.name) +
      opt("author", entry.artistName) +
      opt("genres", genres) +
      ` />`
    );
  });

  const note =
    chart.kind === "podcasts"
      ? `  <note>Apple publishes one overall chart per storefront and no genre charts, so a genre ranking here is this list filtered, not Apple's own. The chart tops out at 100: a show that is absent is outside the top 100 in ${attr(chart.storefront)}, which is not the same as unpopular.</note>`
      : `  <note>Trending Episodes moves much faster than Top Shows and is the better read on what a topic is doing right now.</note>`;

  return `${head}\n${rows.join("\n")}\n${note}\n</chart>`;
}

// ----------------------------------------------------------------- reviews

export function renderReviews(
  reviews: Review[],
  options: { showId: string; storefronts: string[]; breakdown: RatingBreakdown },
): string {
  const { breakdown: stats } = options;
  const head =
    `<reviews show_apple_id="${attr(options.showId)}"` +
    ` storefronts="${attr(options.storefronts.join(", "))}"` +
    ` count="${reviews.length}"` +
    ` average_of_these="${stats.average}">`;

  const distribution = ([5, 4, 3, 2, 1] as const)
    .map((star) => `${star}★ ${stats.distribution[star]}`)
    .join(", ");

  const body = reviews
    .map((review) => {
      const lines = [
        `  <review rating="${review.rating}"` +
          opt("title", review.title) +
          opt("author", review.author) +
          opt("storefront", review.storefront) +
          opt("at", iso(review.updated)) +
          ">",
        fence("review", review.body),
        `  </review>`,
      ];
      return lines.join("\n");
    })
    .join("\n\n");

  return [
    head,
    `  <distribution>${distribution}</distribution>`,
    `  <note>This average is over the reviews returned here, which are the most recent ones. It is not the lifetime star rating Apple shows on the store page, and the two often differ. Reviews are per storefront and do not aggregate: Apple caps them at 50 per page and 10 pages, so 500 per storefront is the ceiling.</note>`,
    body,
    `</reviews>`,
  ]
    .filter(Boolean)
    .join("\n");
}

// -------------------------------------------------------------------- feed

export function renderFeed(feed: Feed, options: { includeEpisodes: boolean }): string {
  const head =
    `<feed` +
    opt("title", feed.title) +
    opt("author", feed.author) +
    opt("language", feed.language) +
    opt("type", feed.showType) +
    opt("episodes_in_feed", feed.totalEpisodes) +
    opt("explicit", feed.explicit === undefined ? undefined : feed.explicit ? "yes" : "no") +
    opt("podcast_guid", feed.podcastGuid) +
    opt("complete", feed.complete ? "yes" : undefined) +
    ">";

  const lines = [head, `  <feed_url>${attr(feed.feedUrl)}</feed_url>`];

  if (feed.link) lines.push(`  <website>${attr(feed.link)}</website>`);
  if (feed.imageUrl) lines.push(`  <artwork>${attr(feed.imageUrl)}</artwork>`);
  if (feed.categories.length) lines.push(`  <categories>${attr(feed.categories.join(" | "))}</categories>`);
  if (feed.ownerName || feed.ownerEmail) {
    lines.push(`  <owner${opt("name", feed.ownerName)}${opt("email", feed.ownerEmail)} />`);
  }
  if (feed.fundingUrl) {
    lines.push(`  <funding url="${attr(feed.fundingUrl)}">${attr(feed.fundingText ?? "")}</funding>`);
  }
  if (feed.newFeedUrl) {
    lines.push(
      `  <moved to="${attr(feed.newFeedUrl)}">This feed declares a new location. Apple follows it and stops reading this URL.</moved>`,
    );
  }
  if (feed.description) {
    lines.push(`  <description>`, fence("show_notes", excerpt(feed.description, 600) ?? ""), `  </description>`);
  }

  if (options.includeEpisodes) {
    lines.push(`  <episodes count="${feed.episodes.length}" of="${feed.totalEpisodes}">`);
    for (const episode of feed.episodes) {
      lines.push(indent(renderFeedEpisode(episode), 4));
    }
    lines.push(`  </episodes>`);
  }

  lines.push(`</feed>`);
  return lines.join("\n");
}

export function renderFeedEpisode(episode: FeedEpisode): string {
  const lines = [
    `<episode` +
      opt("title", episode.title) +
      opt("published_at", episode.publishedAt) +
      opt("duration", seconds(episode.durationSeconds)) +
      opt("episode", episode.episodeNumber) +
      opt("season", episode.seasonNumber) +
      opt("type", episode.episodeType) +
      opt("guid", episode.guid) +
      opt("transcripts", episode.transcripts.length || undefined) +
      ">",
  ];

  if (episode.audioUrl) lines.push(`  <audio_url>${attr(episode.audioUrl)}</audio_url>`);
  for (const transcript of episode.transcripts) {
    lines.push(
      `  <transcript url="${attr(transcript.url)}"${opt("type", transcript.type)}${opt("language", transcript.language)} />`,
    );
  }
  if (episode.chaptersUrl) lines.push(`  <chapters url="${attr(episode.chaptersUrl)}" />`);

  const notes = excerpt(episode.description, 400);
  if (notes) lines.push(`  <description>`, fence("show_notes", notes), `  </description>`);

  lines.push(`</episode>`);
  return lines.join("\n");
}

// ----------------------------------------------------------------- library

export function renderLibraryShows(shows: LibraryShow[]): string {
  const head = `<library_shows count="${shows.length}">`;
  if (!shows.length) {
    return `${head}\n  <note>The Apple Podcasts library on this Mac has no shows in it.</note>\n</library_shows>`;
  }
  const body = shows
    .map(
      (show) =>
        `  <show id="${show.id}"` +
        opt("apple_id", show.appleId) +
        opt("title", show.title) +
        opt("author", show.author) +
        opt("category", show.category) +
        opt("followed", show.subscribed ? "yes" : "no") +
        opt("episodes_in_library", show.episodeCount) +
        opt("added_at", show.addedAt) +
        ` />` +
        (show.feedUrl ? `\n    <feed_url>${attr(show.feedUrl)}</feed_url>` : ""),
    )
    .join("\n");
  return `${head}\n${body}\n  <note>The id here is local to this Mac and is what library tools take. apple_id is Apple's catalog id and is what the public tools take.</note>\n</library_shows>`;
}

export function renderLibraryEpisodes(
  episodes: (LibraryEpisode & { matchedIn?: string[] })[],
  options: { source: string; query?: string; full?: boolean },
): string {
  const head =
    `<library_episodes count="${episodes.length}" source="${attr(options.source)}"` +
    opt("query", options.query) +
    ">";

  if (!episodes.length) {
    return `${head}\n  <note>Nothing in the local library matched. This searches only shows followed on this Mac, not the Apple catalog. Use search_episodes for the catalog.</note>\n</library_episodes>`;
  }

  const body = episodes
    .map((episode) => {
      const lines = [
        `  <episode id="${episode.id}"` +
          opt("apple_id", episode.appleId) +
          opt("title", episode.title) +
          opt("show", episode.showTitle) +
          opt("show_id", episode.showId) +
          opt("published_at", episode.publishedAt) +
          opt("duration", seconds(episode.durationSeconds)) +
          opt("episode", episode.episodeNumber) +
          opt("season", episode.seasonNumber) +
          opt("saved", episode.saved ? "yes" : undefined) +
          opt("bookmarked", episode.bookmarked ? "yes" : undefined) +
          opt("downloaded", episode.downloaded ? "yes" : undefined) +
          opt("matched_in", episode.matchedIn?.join(", ")) +
          ">",
      ];

      const notes = options.full ? episode.description : excerpt(episode.description, 300);
      if (notes) lines.push(`    <description>`, fence("show_notes", notes), `    </description>`);

      if (episode.transcriptSnippet) {
        const snippet = options.full
          ? episode.transcriptSnippet
          : excerpt(episode.transcriptSnippet, 600);
        if (snippet) {
          lines.push(
            `    <transcript_excerpt source="apple-cached">`,
            fence("transcript", snippet),
            `    </transcript_excerpt>`,
          );
        }
      } else if (episode.hasFullTranscript) {
        lines.push(
          `    <transcript_excerpt available="no">Apple holds a transcript for this episode but did not cache an excerpt locally, and the full file is not readable outside the Podcasts app.</transcript_excerpt>`,
        );
      }

      lines.push(`  </episode>`);
      return lines.join("\n");
    })
    .join("\n\n");

  return `${head}\n${body}\n</library_episodes>`;
}

function indent(block: string, spaces = 2): string {
  const pad = " ".repeat(spaces);
  return block
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}
