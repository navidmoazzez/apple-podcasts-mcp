/**
 * The public catalog: search, lookup, and the genre tree.
 *
 * This is the Search API, which is open, needs no key, and is the same index
 * the Podcasts app searches. Three things about it are worth knowing before
 * reading the code, because each one shapes a decision here.
 *
 * **It answers 200 for failures.** A bad parameter comes back as HTTP 200 with
 * an `errorMessage` field and zero results, which is indistinguishable from a
 * search that genuinely matched nothing unless the body is inspected. Every
 * response goes through `inBandError` before its results are trusted.
 *
 * **A lookup returns the show as the first result.** `lookup?id=X&entity=
 * podcastEpisode` returns the show in position zero and the episodes after it,
 * in one array of mixed shapes. Handing that array to a model unsorted means
 * the first "episode" it reads is the show. They are split apart here by
 * `wrapperType`, which is the only field that reliably distinguishes them.
 *
 * **The episode list is shallow.** Apple returns recent episodes, not the
 * backlog, and the cap moves. For anything historical the answer is the RSS
 * feed, which is why `feed.ts` exists and why the episode tools say so rather
 * than letting a caller conclude a show has thirty episodes when it has nine
 * hundred.
 *
 * Results are per-storefront. The same search in `us` and `se` returns
 * different shows in a different order, so the storefront travels with every
 * call and comes back on every result.
 */

import type { Config } from "../config.js";
import type { HttpClient } from "./http.js";
import { NotFoundError, ValidationError, inBandError } from "./errors.js";

export type SearchResponse = {
  resultCount: number;
  results: Record<string, unknown>[];
  errorMessage?: string;
};

/** A show and its episodes, already separated. */
export type LookupResult = {
  show?: Record<string, unknown>;
  episodes: Record<string, unknown>[];
};

export type GenreNode = {
  id: string;
  name: string;
  subgenres: GenreNode[];
};

export class ItunesClient {
  private readonly config: Config;
  private readonly http: HttpClient;

  constructor(config: Config, http: HttpClient) {
    this.config = config;
    this.http = http;
  }

  /** Search the catalog. `entity` picks shows or episodes. */
  async search(options: {
    term: string;
    entity: "podcast" | "podcastEpisode";
    storefront: string;
    limit: number;
    genreId?: string;
    /** Restrict matching to one field, e.g. `titleTerm` or `authorTerm`. */
    attribute?: string;
  }): Promise<Record<string, unknown>[]> {
    const body = await this.http.get<SearchResponse>(`${this.config.itunesHost}/search`, {
      surface: "catalog",
      params: {
        term: options.term,
        media: "podcast",
        entity: options.entity,
        country: options.storefront,
        limit: options.limit,
        genreId: options.genreId,
        attribute: options.attribute,
      },
    });

    const message = inBandError(body);
    if (message) {
      throw new ValidationError(
        `Apple rejected the search: ${message}. This arrives as a normal 200 response with no results, so it is reported here rather than passed off as "nothing matched".`,
        200,
        "itunes.apple.com/search",
        { surface: "catalog", detail: message },
      );
    }

    return Array.isArray(body.results) ? body.results : [];
  }

  /**
   * One show by Apple id, optionally with its recent episodes.
   *
   * Returns the show and the episodes separately, because Apple returns them
   * mixed together in a single array.
   */
  async lookup(options: {
    id: string;
    storefront: string;
    withEpisodes?: boolean;
    limit?: number;
  }): Promise<LookupResult> {
    const body = await this.http.get<SearchResponse>(`${this.config.itunesHost}/lookup`, {
      surface: "catalog",
      params: {
        id: options.id,
        country: options.storefront,
        entity: options.withEpisodes ? "podcastEpisode" : undefined,
        limit: options.withEpisodes ? (options.limit ?? 50) : undefined,
      },
    });

    const message = inBandError(body);
    if (message) {
      throw new ValidationError(
        `Apple rejected the lookup: ${message}`,
        200,
        "itunes.apple.com/lookup",
        { surface: "catalog", detail: message },
      );
    }

    const results = Array.isArray(body.results) ? body.results : [];
    if (results.length === 0) {
      throw new NotFoundError(
        `No Apple Podcasts show with id ${options.id} in the ${options.storefront} storefront. A show can be published in some storefronts and not others, so it is worth trying another before concluding it does not exist.`,
        200,
        "itunes.apple.com/lookup",
        { surface: "catalog" },
      );
    }

    const show = results.find((r) => r.wrapperType === "track" && r.kind === "podcast");
    const episodes = results.filter((r) => r.wrapperType === "podcastEpisode");

    return { show: show ?? results[0], episodes };
  }

  /**
   * The podcast genre tree, live.
   *
   * Fetched rather than written down. The ids are stable but the names and the
   * subgenre lists are not, and a hardcoded tree is wrong the moment Apple adds
   * a category.
   */
  async genres(storefront: string): Promise<GenreNode | undefined> {
    const body = await this.http.get<Record<string, RawGenre>>(
      `${this.config.itunesHost}/WebObjects/MZStoreServices.woa/ws/genres`,
      { surface: "catalog", params: { id: PODCASTS_GENRE_ID, cc: storefront } },
    );
    const root = body[PODCASTS_GENRE_ID];
    return root ? toGenreNode(PODCASTS_GENRE_ID, root) : undefined;
  }
}

/** Apple's top-level id for podcasts, the root of the genre tree. */
export const PODCASTS_GENRE_ID = "26";

type RawGenre = { name?: string; subgenres?: Record<string, RawGenre> };

function toGenreNode(id: string, raw: RawGenre): GenreNode {
  return {
    id,
    name: raw.name ?? id,
    subgenres: Object.entries(raw.subgenres ?? {}).map(([childId, child]) =>
      toGenreNode(childId, child),
    ),
  };
}

export type ResolvedLink = {
  showId: string;
  episodeId?: string;
  storefront?: string;
  kind: "show" | "episode";
};

/**
 * Turn something a person pasted into ids.
 *
 * People paste an Apple Podcasts link, not a numeric id, and every tool here is
 * keyed by id. Apple's own share URLs come in several shapes, and the episode
 * id hides in a query parameter rather than the path:
 *
 *   https://podcasts.apple.com/us/podcast/some-show/id1469759170
 *   https://podcasts.apple.com/gb/podcast/some-show/id1469759170?i=1000712345678
 *   https://podcasts.apple.com/podcast/id1469759170
 *   1469759170
 *
 * Returning the storefront from the path matters as much as the id. A link
 * someone shares from the UK store, looked up against `us`, can 404 for a show
 * that is only published in some markets.
 */
export function resolveLink(input: string): ResolvedLink {
  const trimmed = input.trim();

  if (/^\d{4,}$/.test(trimmed)) {
    return { showId: trimmed, kind: "show" };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError(
      `"${input}" is neither an Apple Podcasts id nor a link. Pass the numeric id, or an Apple Podcasts URL such as https://podcasts.apple.com/us/podcast/name/id1469759170.`,
      0,
      "(local)",
      { surface: "catalog" },
    );
  }

  if (!/(^|\.)apple\.com$/i.test(url.hostname)) {
    throw new ValidationError(
      `"${url.hostname}" is not an Apple Podcasts link. To look up a show from its RSS feed instead, search for its title with search_podcasts and match on the feed URL in the result.`,
      0,
      "(local)",
      { surface: "catalog" },
    );
  }

  const idMatch = url.pathname.match(/\/id(\d+)/);
  if (!idMatch?.[1]) {
    throw new ValidationError(
      `That Apple link has no show id in it. An Apple Podcasts show URL contains "/id" followed by digits.`,
      0,
      "(local)",
      { surface: "catalog" },
    );
  }

  // Storefront is the first path segment when it is a two-letter code. Apple
  // also serves storefront-less URLs, which is why this is optional.
  const first = url.pathname.split("/").filter(Boolean)[0];
  const storefront = first && /^[a-z]{2}$/i.test(first) ? first.toLowerCase() : undefined;

  const episodeId = url.searchParams.get("i") ?? undefined;

  return {
    showId: idMatch[1],
    episodeId: episodeId && /^\d+$/.test(episodeId) ? episodeId : undefined,
    storefront,
    kind: episodeId ? "episode" : "show",
  };
}
