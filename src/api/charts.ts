/**
 * Apple's live podcast charts, per storefront.
 *
 * This is the surface worth building a server for, because it is the only place
 * Apple publishes ranking, and ranking is the question people actually have:
 * not "does this show exist" but "is it winning, where, and against whom".
 *
 * Two charts, and they answer different questions:
 *
 *   podcasts           Top Shows, ranked by Apple's own follower-weighted
 *                      measure. Slow moving. This is standing.
 *   podcast-episodes   Trending Episodes. Fast moving, and the better signal
 *                      for what a topic is doing this week.
 *
 * Three limits, all verified rather than assumed, and all worth surfacing
 * because a caller who does not know them will read absence as evidence:
 *
 * **100 is the maximum.** Asking for 200 fails. A show outside the top 100 in a
 * storefront is unranked as far as this API is concerned, which is not the same
 * as unpopular.
 *
 * **There are no genre charts.** Apple serves an overall chart per storefront
 * and returns 404 for a genre-scoped path. The genre on each row tells you what
 * a show is filed under; it does not let you ask for the Business chart. A
 * genre ranking can be derived by filtering the overall chart, and that is what
 * this exposes, with the ceiling made explicit rather than implied.
 *
 * **Ranking is per storefront and they diverge sharply.** A show can sit at 12
 * in `gb` and be unranked in `us`. One storefront is never the answer to "how
 * is this show doing", which is why the sweep exists.
 */

import type { Config } from "../config.js";
import type { HttpClient } from "./http.js";

export type ChartKind = "podcasts" | "podcast-episodes";

export type ChartEntry = {
  /** 1-based position in the chart. */
  rank: number;
  id: string;
  name: string;
  artistName: string;
  /** Genre names Apple files this under. Not a chart you can request. */
  genres: string[];
  url: string;
  artworkUrl?: string;
  /** Present on the episode chart only, pulled out of the share URL. */
  showId?: string;
};

export type Chart = {
  kind: ChartKind;
  storefront: string;
  title: string;
  updated?: string;
  entries: ChartEntry[];
};

/** Apple refuses a chart larger than this. */
export const MAX_CHART_SIZE = 100;

type RawChart = {
  feed?: {
    title?: string;
    updated?: string;
    country?: string;
    results?: {
      id?: string;
      name?: string;
      artistName?: string;
      artworkUrl100?: string;
      url?: string;
      genres?: { name?: string }[];
    }[];
  };
};

export class ChartsClient {
  private readonly config: Config;
  private readonly http: HttpClient;

  constructor(config: Config, http: HttpClient) {
    this.config = config;
    this.http = http;
  }

  async chart(options: {
    storefront: string;
    kind: ChartKind;
    limit: number;
    fresh?: boolean;
  }): Promise<Chart> {
    const size = Math.min(Math.max(Math.trunc(options.limit), 1), MAX_CHART_SIZE);
    const url = `${this.config.chartsHost}/api/v2/${options.storefront}/podcasts/top/${size}/${options.kind}.json`;

    const body = await this.http.get<RawChart>(url, {
      surface: "charts",
      fresh: options.fresh,
    });

    const rows = body.feed?.results ?? [];

    return {
      kind: options.kind,
      storefront: options.storefront,
      title: body.feed?.title ?? (options.kind === "podcasts" ? "Top Shows" : "Trending Episodes"),
      updated: body.feed?.updated,
      entries: rows.map((row, index) => ({
        rank: index + 1,
        id: String(row.id ?? ""),
        name: row.name ?? "",
        artistName: row.artistName ?? "",
        genres: (row.genres ?? []).map((g) => g.name ?? "").filter(Boolean),
        url: row.url ?? "",
        artworkUrl: row.artworkUrl100,
        showId: showIdFromUrl(row.url),
      })),
    };
  }
}

/**
 * Pull the show id out of a chart row's share URL.
 *
 * The episode chart identifies an episode by its own id and never names the
 * show it belongs to as a field. The show id is only present inside the URL, so
 * without this an episode chart entry cannot be joined to anything.
 */
export function showIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = url.match(/\/id(\d+)/);
  return match?.[1];
}

/**
 * Where a show sits in a chart, or nothing.
 *
 * Matching is by id rather than by name. Titles collide, get re-cased and pick
 * up suffixes like "with <host>" between the catalog and the chart, and a name
 * match would report the wrong show as ranked.
 */
export function positionOf(chart: Chart, showId: string): ChartEntry | undefined {
  return chart.entries.find(
    (entry) => entry.id === showId || entry.showId === showId,
  );
}
