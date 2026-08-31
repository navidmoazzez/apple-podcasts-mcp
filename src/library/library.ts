/**
 * Your own library: what you follow, and every episode Apple has cached for you.
 *
 * This is the surface nothing else reaches, and the reason is that it does not
 * look like an API. It is a Core Data store the Podcasts app writes for itself,
 * and it happens to contain a great deal more than the app displays.
 *
 * On a normally-used Mac it holds tens of thousands of episodes across the
 * shows you follow, each with its full description, publication date, duration,
 * guid, audio URL, and season and episode numbers. Apple keeps that whether or
 * not the episode was ever downloaded, because the app needs it to draw a list.
 *
 * **The transcript snippets are the find.** Almost every episode carries
 * `ZFREETRANSCRIPTSNIPPET`, a JSON array of speaker-tagged lines Apple caches
 * from its own transcription. It is an excerpt rather than the whole thing, a
 * few hundred characters typically, but it is real spoken text, and there is
 * one for effectively every episode in the library. Searching it is the closest
 * thing to full-text search across everything you follow.
 *
 * Two limits are load-bearing and are surfaced rather than smoothed over,
 * because a tool that implies otherwise produces confident wrong answers:
 *
 * **The full transcripts are not readable.** `ZFREETRANSCRIPTIDENTIFIER` holds
 * a path to a TTML file on Apple's CDN, and that CDN refuses unauthenticated
 * requests. The snippet is what there is.
 *
 * **Play position does not reach the Mac.** On a library synced from an iPhone,
 * the playhead and play-count columns are zero on every row and the
 * last-played date is set on almost none. Whatever tracks listening, it is not
 * this file. So this module reports what a column literally contains and never
 * infers listening history, and `library_stats` says out loud when the play
 * data is empty rather than reporting an honest-looking zero.
 *
 * Column names are Core Data's: a `Z` prefix, upper case, and a `Z_PK` primary
 * key. They are Apple's private schema and can change between releases of the
 * app, which is why `doctor` probes them.
 */

import type { Db, Row } from "./db.js";
import { fromCoreDataDate } from "./db.js";

export type LibraryShow = {
  id: number;
  title: string;
  author?: string;
  /** Apple's catalog id, which joins this row to every public tool here. */
  appleId?: string;
  feedUrl?: string;
  websiteUrl?: string;
  category?: string;
  artworkUrl?: string;
  subscribed: boolean;
  addedAt?: string;
  lastFetchedAt?: string;
  /** Episodes of this show present in the local database. */
  episodeCount?: number;
};

export type LibraryEpisode = {
  id: number;
  title: string;
  showId: number;
  showTitle?: string;
  /** Apple's catalog id for the episode. */
  appleId?: string;
  guid?: string;
  publishedAt?: string;
  durationSeconds?: number;
  description?: string;
  audioUrl?: string;
  websiteUrl?: string;
  episodeNumber?: number;
  seasonNumber?: number;
  episodeType?: string;
  saved: boolean;
  bookmarked: boolean;
  downloaded: boolean;
  /** Apple's cached transcript excerpt, already flattened to plain text. */
  transcriptSnippet?: string;
  /** True when Apple holds a full transcript, which is not readable from here. */
  hasFullTranscript: boolean;
};

const SHOW_COLUMNS = `
  p.Z_PK              as id,
  p.ZTITLE            as title,
  p.ZAUTHOR           as author,
  p.ZSTORECOLLECTIONID as appleId,
  p.ZFEEDURL          as feedUrl,
  p.ZWEBPAGEURL       as websiteUrl,
  p.ZCATEGORY         as category,
  p.ZARTWORKTEMPLATEURL as artworkTemplate,
  p.ZSUBSCRIBED       as subscribed,
  p.ZADDEDDATE        as addedAt,
  p.ZLASTFETCHEDDATE  as lastFetchedAt
`;

const EPISODE_COLUMNS = `
  e.Z_PK                        as id,
  e.ZTITLE                      as title,
  e.ZPODCAST                    as showId,
  p.ZTITLE                      as showTitle,
  e.ZSTORETRACKID               as appleId,
  e.ZGUID                       as guid,
  e.ZPUBDATE                    as publishedAt,
  e.ZDURATION                   as durationSeconds,
  e.ZITEMDESCRIPTIONWITHOUTHTML as description,
  e.ZENCLOSUREURL               as audioUrl,
  e.ZWEBPAGEURL                 as websiteUrl,
  e.ZEPISODENUMBER              as episodeNumber,
  e.ZSEASONNUMBER               as seasonNumber,
  e.ZEPISODETYPE                as episodeType,
  e.ZSAVED                      as saved,
  e.ZISBOOKMARKED               as bookmarked,
  e.ZDOWNLOADPATH               as downloadPath,
  e.ZFREETRANSCRIPTSNIPPET      as transcriptSnippet,
  e.ZFREETRANSCRIPTIDENTIFIER   as transcriptId
`;

export class Library {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Every show in the library, followed first. */
  shows(options: { subscribedOnly?: boolean; limit?: number } = {}): LibraryShow[] {
    const where = options.subscribedOnly ? "where p.ZSUBSCRIBED = 1" : "";
    const limit = clampInt(options.limit, 200, 1, 1000);

    const rows = this.db.query(
      `select ${SHOW_COLUMNS},
              (select count(*) from ZMTEPISODE e where e.ZPODCAST = p.Z_PK) as episodeCount
       from ZMTPODCAST p
       ${where}
       order by p.ZSUBSCRIBED desc, p.ZTITLE collate nocase asc
       limit ?`,
      [limit],
    );

    return rows.map(toShow);
  }

  /**
   * Search the library by keyword.
   *
   * Searches titles, descriptions and the cached transcript snippets, and says
   * which of those matched. That last part is the useful bit: a hit in a title
   * means the episode is about the term, and a hit only in a transcript
   * snippet means somebody said it in passing. Collapsing the two into one
   * relevance score would throw away the distinction a person actually wants.
   *
   * `like` rather than FTS because the Podcasts app ships no full-text index
   * over these columns, and building one would mean writing to a database this
   * server opens read-only.
   */
  search(options: {
    query: string;
    showId?: number;
    includeTranscripts?: boolean;
    limit?: number;
  }): (LibraryEpisode & { matchedIn: string[] })[] {
    const limit = clampInt(options.limit, 25, 1, 200);
    const needle = `%${escapeLike(options.query)}%`;
    const searchTranscripts = options.includeTranscripts !== false;

    const params: unknown[] = [needle, needle];
    let match = `(e.ZTITLE like ? escape '\\' or e.ZITEMDESCRIPTIONWITHOUTHTML like ? escape '\\'`;
    if (searchTranscripts) {
      match += ` or e.ZFREETRANSCRIPTSNIPPET like ? escape '\\'`;
      params.push(needle);
    }
    match += ")";

    let showFilter = "";
    if (options.showId !== undefined) {
      showFilter = "and e.ZPODCAST = ?";
      params.push(options.showId);
    }

    params.push(limit);

    const rows = this.db.query(
      `select ${EPISODE_COLUMNS}
       from ZMTEPISODE e
       left join ZMTPODCAST p on p.Z_PK = e.ZPODCAST
       where ${match} ${showFilter}
       order by e.ZPUBDATE desc
       limit ?`,
      params,
    );

    const lowered = options.query.toLowerCase();
    return rows.map((row) => {
      const episode = toEpisode(row);
      const matchedIn: string[] = [];
      if (episode.title.toLowerCase().includes(lowered)) matchedIn.push("title");
      if (episode.description?.toLowerCase().includes(lowered)) matchedIn.push("description");
      if (episode.transcriptSnippet?.toLowerCase().includes(lowered)) matchedIn.push("transcript");
      return { ...episode, matchedIn };
    });
  }

  /** Newest episodes across the library, or within one show. */
  recent(options: { showId?: number; limit?: number; sinceHours?: number } = {}): LibraryEpisode[] {
    const limit = clampInt(options.limit, 25, 1, 200);
    const params: unknown[] = [];
    const clauses: string[] = ["e.ZPUBDATE is not null"];

    if (options.showId !== undefined) {
      clauses.push("e.ZPODCAST = ?");
      params.push(options.showId);
    }
    if (options.sinceHours !== undefined && options.sinceHours > 0) {
      // Compared in Core Data's own epoch so the database does no conversion.
      const cutoff = Date.now() / 1000 - options.sinceHours * 3600 - 978_307_200;
      clauses.push("e.ZPUBDATE >= ?");
      params.push(cutoff);
    }
    params.push(limit);

    const rows = this.db.query(
      `select ${EPISODE_COLUMNS}
       from ZMTEPISODE e
       left join ZMTPODCAST p on p.Z_PK = e.ZPODCAST
       where ${clauses.join(" and ")}
       order by e.ZPUBDATE desc
       limit ?`,
      params,
    );
    return rows.map(toEpisode);
  }

  /** Episodes flagged saved or bookmarked, which is the app's own shortlist. */
  flagged(options: { kind: "saved" | "bookmarked" | "downloaded"; limit?: number }): LibraryEpisode[] {
    const limit = clampInt(options.limit, 50, 1, 200);
    const column =
      options.kind === "saved"
        ? "e.ZSAVED = 1"
        : options.kind === "bookmarked"
          ? "e.ZISBOOKMARKED = 1"
          : "e.ZDOWNLOADPATH is not null";

    const rows = this.db.query(
      `select ${EPISODE_COLUMNS}
       from ZMTEPISODE e
       left join ZMTPODCAST p on p.Z_PK = e.ZPODCAST
       where ${column}
       order by e.ZPUBDATE desc
       limit ?`,
      [limit],
    );
    return rows.map(toEpisode);
  }

  /** One episode by its local primary key. */
  episode(id: number): LibraryEpisode | undefined {
    const rows = this.db.query(
      `select ${EPISODE_COLUMNS}
       from ZMTEPISODE e
       left join ZMTPODCAST p on p.Z_PK = e.ZPODCAST
       where e.Z_PK = ?
       limit 1`,
      [id],
    );
    return rows[0] ? toEpisode(rows[0]) : undefined;
  }

  /** One show by local id, Apple id, or an exact-ish title. */
  findShow(hint: string): LibraryShow | undefined {
    if (/^\d+$/.test(hint)) {
      const n = Number(hint);
      const rows = this.db.query(
        `select ${SHOW_COLUMNS} from ZMTPODCAST p
         where p.Z_PK = ? or p.ZSTORECOLLECTIONID = ? limit 1`,
        [n, n],
      );
      if (rows[0]) return toShow(rows[0]);
    }

    // Exact before prefix, for the same reason account matching works that way:
    // a short title is a prefix of a longer one, and a prefix-first search
    // silently answers about the wrong show.
    const exact = this.db.query(
      `select ${SHOW_COLUMNS} from ZMTPODCAST p where p.ZTITLE like ? escape '\\' limit 1`,
      [escapeLike(hint)],
    );
    if (exact[0]) return toShow(exact[0]);

    const prefix = this.db.query(
      `select ${SHOW_COLUMNS} from ZMTPODCAST p where p.ZTITLE like ? escape '\\'
       order by length(p.ZTITLE) asc limit 1`,
      [`${escapeLike(hint)}%`],
    );
    if (prefix[0]) return toShow(prefix[0]);

    const anywhere = this.db.query(
      `select ${SHOW_COLUMNS} from ZMTPODCAST p where p.ZTITLE like ? escape '\\'
       order by length(p.ZTITLE) asc limit 1`,
      [`%${escapeLike(hint)}%`],
    );
    return anywhere[0] ? toShow(anywhere[0]) : undefined;
  }

  /**
   * What is actually in this library.
   *
   * Reports the play-data columns as counts rather than as conclusions,
   * precisely because they are frequently empty on a Mac and a caller needs to
   * know that before drawing an inference from them.
   */
  stats(): Record<string, unknown> {
    const one = (sql: string): number => {
      const rows = this.db.query(sql);
      const first = rows[0];
      if (!first) return 0;
      const value = Object.values(first)[0];
      return typeof value === "number" ? value : Number(value ?? 0);
    };

    const episodes = one("select count(*) from ZMTEPISODE");
    const withPlayhead = one("select count(*) from ZMTEPISODE where ZPLAYHEAD > 0");
    const withPlayCount = one("select count(*) from ZMTEPISODE where ZPLAYCOUNT > 0");
    const withLastPlayed = one("select count(*) from ZMTEPISODE where ZLASTDATEPLAYED is not null");

    // A handful of played episodes in a library of tens of thousands is noise,
    // not a listening history: a Mac picks up a few stray rows even when the
    // real listening happens on a phone that never syncs progress here. So a
    // bare count is not the test. Either the progress columns are genuinely
    // populated, or played episodes have to be a real share of the library
    // before anything should be concluded from them.
    const playDataPresent =
      withPlayhead > 0 ||
      withPlayCount > 0 ||
      (withLastPlayed >= 50 && withLastPlayed >= episodes * 0.01);

    return {
      shows: one("select count(*) from ZMTPODCAST"),
      followed: one("select count(*) from ZMTPODCAST where ZSUBSCRIBED = 1"),
      episodes,
      with_transcript_snippet: one(
        "select count(*) from ZMTEPISODE where ZFREETRANSCRIPTSNIPPET is not null",
      ),
      saved: one("select count(*) from ZMTEPISODE where ZSAVED = 1"),
      bookmarked: one("select count(*) from ZMTEPISODE where ZISBOOKMARKED = 1"),
      downloaded: one("select count(*) from ZMTEPISODE where ZDOWNLOADPATH is not null"),
      play_data: {
        episodes_with_playhead: withPlayhead,
        episodes_with_play_count: withPlayCount,
        episodes_with_last_played_date: withLastPlayed,
        usable: playDataPresent,
        note: playDataPresent
          ? "Play data is present in this library and can be reasoned about."
          : "This library carries no usable play data. Listening progress is tracked on the device you listen on and does not reach the Mac's copy, so do not infer listening history, completion or favourites from it. What is here is the catalogue of what you follow, not a record of what you played.",
      },
    };
  }
}

function toShow(row: Row): LibraryShow {
  const template = str(row.artworkTemplate);
  return {
    id: num(row.id) ?? 0,
    title: str(row.title) ?? "(untitled)",
    author: str(row.author),
    appleId: row.appleId ? String(row.appleId) : undefined,
    feedUrl: str(row.feedUrl),
    websiteUrl: str(row.websiteUrl),
    category: str(row.category),
    artworkUrl: template ? artwork(template, 600) : undefined,
    subscribed: num(row.subscribed) === 1,
    addedAt: fromCoreDataDate(row.addedAt),
    lastFetchedAt: fromCoreDataDate(row.lastFetchedAt),
    episodeCount: num(row.episodeCount),
  };
}

function toEpisode(row: Row): LibraryEpisode {
  const duration = num(row.durationSeconds);
  return {
    id: num(row.id) ?? 0,
    title: str(row.title) ?? "(untitled)",
    showId: num(row.showId) ?? 0,
    showTitle: str(row.showTitle),
    appleId: row.appleId ? String(row.appleId) : undefined,
    guid: str(row.guid),
    publishedAt: fromCoreDataDate(row.publishedAt),
    durationSeconds: duration && duration > 0 ? Math.round(duration) : undefined,
    description: str(row.description),
    audioUrl: str(row.audioUrl),
    websiteUrl: str(row.websiteUrl),
    episodeNumber: num(row.episodeNumber) || undefined,
    seasonNumber: num(row.seasonNumber) || undefined,
    episodeType: str(row.episodeType),
    saved: num(row.saved) === 1,
    bookmarked: num(row.bookmarked) === 1,
    downloaded: Boolean(str(row.downloadPath)),
    transcriptSnippet: flattenSnippet(str(row.transcriptSnippet)),
    hasFullTranscript: Boolean(str(row.transcriptId)),
  };
}

/**
 * Apple stores artwork as a template with `{w}`, `{h}` and `{f}` placeholders.
 *
 * Returning the template itself would hand a caller a URL that 404s, which is
 * worse than returning nothing, so it is always filled in.
 */
export function artwork(template: string, size: number): string {
  return template
    .replace("{w}", String(size))
    .replace("{h}", String(size))
    .replace("{f}", "jpg");
}

/**
 * Flatten Apple's cached transcript excerpt into readable text.
 *
 * Stored as a JSON array of `{speaker_id, content}` objects. Speaker turns are
 * preserved because they carry real information in an interview: who said the
 * thing that matched is usually the point. When two adjacent lines share a
 * speaker they are joined rather than re-labelled, which is what makes the
 * result read as prose instead of as a data dump.
 *
 * A row that is not the expected shape falls back to the raw string. The column
 * is Apple's private format and a future version of the app may change it;
 * degrading to unformatted text keeps search working when that happens.
 */
export function flattenSnippet(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (!text.startsWith("[")) return text || undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!Array.isArray(parsed)) return text;

  const out: string[] = [];
  let lastSpeaker: string | undefined;

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const content = typeof e.content === "string" ? e.content.trim() : "";
    if (!content) continue;
    const speaker = e.speaker_id === undefined ? undefined : String(e.speaker_id);

    if (speaker !== undefined && speaker !== lastSpeaker) {
      out.push(`Speaker ${speaker}: ${content}`);
      lastSpeaker = speaker;
    } else if (out.length) {
      out[out.length - 1] += ` ${content}`;
    } else {
      out.push(content);
    }
  }

  const joined = out.join("\n");
  return joined || text;
}

/**
 * Escape a user's search term for a `like` pattern.
 *
 * Without this, a search for "100%" matches every episode, and one containing
 * an underscore matches any character in that position. Both are silent wrong
 * answers rather than errors, which is the worst kind.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t ? t : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}
