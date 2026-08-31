/**
 * Listener reviews, per storefront.
 *
 * The only place Apple publishes what an audience actually says, and it is a
 * genuinely different signal from a chart. A chart says a show is big. Reviews
 * say what people think it is about, which episode converted them, what they
 * complain about, and which competitor they came from. For anyone deciding
 * how to position a show, that is the useful half.
 *
 * The endpoint is an old iTunes RSS feed wearing a JSON coat, and it shows.
 *
 * **Reviews are per storefront and do not aggregate.** The `us` reviews are a
 * different pool from the `gb` ones, with a different average. There is no
 * global view, so a global read means sweeping and saying so.
 *
 * **Fifty per page, ten pages, hard stop.** Page 11 does not return an empty
 * feed, it returns something that is not JSON at all. So 500 per storefront is
 * the ceiling and paging past it is an error rather than an ending, which is
 * why the loop below stops on a short page instead of trusting the caller.
 *
 * **The first entry is not a review.** Apple puts a feed-description object in
 * position zero on page 1, with the show's name where a review's title goes.
 * Take the array at face value and every summary starts with a fake five-star
 * review that is actually the show's own blurb. It is dropped by shape rather
 * than by index, because it is absent on later pages.
 *
 * **The ratings here are not the show's rating.** These are the most recent
 * reviews, which is a sample skewed by whatever happened lately, not the
 * lifetime average Apple displays on the show page. The average computed from
 * them is labelled as what it is.
 *
 * Everything returned here is text a stranger wrote, and "summarise my reviews"
 * is one of the first things anyone asks. It is fenced before a model sees it.
 */

import type { Config } from "../config.js";
import type { HttpClient } from "./http.js";

export type Review = {
  id: string;
  rating: number;
  title: string;
  body: string;
  author: string;
  /** The reviewer's app version string. Frequently empty. */
  version?: string;
  updated?: string;
  storefront: string;
};

/** Apple serves 50 reviews per page and refuses beyond page 10. */
export const REVIEWS_PER_PAGE = 50;
export const MAX_REVIEW_PAGES = 10;

type RawFeed = {
  feed?: {
    entry?: RawEntry[] | RawEntry;
  };
};

type RawEntry = {
  id?: { label?: string };
  title?: { label?: string };
  content?: { label?: string } | { label?: string }[];
  author?: { name?: { label?: string } };
  updated?: { label?: string };
  "im:rating"?: { label?: string };
  "im:version"?: { label?: string };
};

export class ReviewsClient {
  private readonly config: Config;
  private readonly http: HttpClient;

  constructor(config: Config, http: HttpClient) {
    this.config = config;
    this.http = http;
  }

  /**
   * Recent reviews for one show in one storefront.
   *
   * Pages until it has enough or Apple runs out. A short page means the end,
   * because there is no total and no next-page marker to trust.
   */
  async forShow(options: {
    showId: string;
    storefront: string;
    limit: number;
    sort?: "mostrecent" | "mosthelpful";
  }): Promise<Review[]> {
    const sort = options.sort ?? "mostrecent";
    const wanted = Math.max(1, Math.trunc(options.limit));
    const out: Review[] = [];

    for (let page = 1; page <= MAX_REVIEW_PAGES && out.length < wanted; page++) {
      const url = `${this.config.itunesHost}/${options.storefront}/rss/customerreviews/page=${page}/id=${options.showId}/sortby=${sort}/json`;

      let body: RawFeed;
      try {
        body = await this.http.get<RawFeed>(url, { surface: "reviews" });
      } catch (error) {
        // A show with no reviews at all, and a page past the end, both come
        // back as something that will not parse. Neither is worth failing the
        // whole call over when earlier pages succeeded.
        if (page === 1) throw error;
        break;
      }

      const entries = normalizeEntries(body.feed?.entry);
      const reviews = entries
        .filter(isReview)
        .map((entry) => toReview(entry, options.storefront));

      out.push(...reviews);

      // A page that came back short is the last one. Apple publishes no total.
      if (entries.length < REVIEWS_PER_PAGE) break;
    }

    return out.slice(0, wanted);
  }
}

function normalizeEntries(entry: RawEntry[] | RawEntry | undefined): RawEntry[] {
  if (!entry) return [];
  return Array.isArray(entry) ? entry : [entry];
}

/**
 * Tell a real review from the feed-description object Apple prepends.
 *
 * The description has no rating. Every genuine review has one, so that is the
 * discriminator rather than the position, which only holds on page 1.
 */
function isReview(entry: RawEntry): boolean {
  const rating = Number(entry["im:rating"]?.label);
  return Number.isFinite(rating) && rating >= 1 && rating <= 5;
}

function toReview(entry: RawEntry, storefront: string): Review {
  const content = Array.isArray(entry.content) ? entry.content[0] : entry.content;
  return {
    id: entry.id?.label ?? "",
    rating: Number(entry["im:rating"]?.label ?? 0),
    title: entry.title?.label ?? "",
    body: content?.label ?? "",
    author: entry.author?.name?.label ?? "",
    version: entry["im:version"]?.label || undefined,
    updated: entry.updated?.label,
    storefront,
  };
}

export type RatingBreakdown = {
  count: number;
  average: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
};

/**
 * Summarise a set of reviews.
 *
 * The average here is over the reviews actually fetched, which are the most
 * recent ones. It is not the lifetime rating Apple shows on the store page and
 * the tools that return it say so, because the two differ and a model asked
 * "what is this show rated" will otherwise report the wrong number confidently.
 */
export function breakdown(reviews: Review[]): RatingBreakdown {
  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;

  for (const review of reviews) {
    const rating = review.rating as 1 | 2 | 3 | 4 | 5;
    if (rating >= 1 && rating <= 5) {
      distribution[rating] += 1;
      total += rating;
    }
  }

  return {
    count: reviews.length,
    average: reviews.length ? Number((total / reviews.length).toFixed(2)) : 0,
    distribution,
  };
}
