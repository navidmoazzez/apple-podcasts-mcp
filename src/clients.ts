/**
 * The four clients, assembled once and handed to every tool.
 *
 * They are grouped rather than passed individually because several tools cross
 * surfaces on purpose, and that crossing is most of the value here. Asking
 * "how is this show doing" means the catalog for what it is, the charts for
 * where it ranks, the reviews for what listeners say, and the feed for how
 * often it actually publishes. A tool that could only reach one of those would
 * answer a quarter of the question.
 *
 * The library client is created lazily and per call rather than held open. A
 * long-lived handle on a database another application is actively writing is a
 * liability, and opening it costs a few milliseconds against a local file.
 */

import { ChartsClient } from "./api/charts.js";
import { FeedClient } from "./api/feed.js";
import { HttpClient, type FetchLike } from "./api/http.js";
import { ItunesClient } from "./api/itunes.js";
import { ReporterClient } from "./api/reporter.js";
import { ReviewsClient } from "./api/reviews.js";
import type { Config } from "./config.js";
import { openDatabase } from "./library/db.js";
import { Library } from "./library/library.js";

export type Clients = {
  http: HttpClient;
  itunes: ItunesClient;
  charts: ChartsClient;
  reviews: ReviewsClient;
  feed: FeedClient;
  reporter: ReporterClient;
  /**
   * Open the local library, run something against it, and close it again.
   *
   * Scoped rather than returned so no caller can leak a handle, and so the
   * close happens even when the query throws.
   */
  withLibrary: <T>(fn: (library: Library) => T) => Promise<T>;
};

export function makeClients(config: Config, fetchImpl: FetchLike = fetch): Clients {
  const http = new HttpClient(config, fetchImpl);

  return {
    http,
    itunes: new ItunesClient(config, http),
    charts: new ChartsClient(config, http),
    reviews: new ReviewsClient(config, http),
    feed: new FeedClient(http),
    reporter: new ReporterClient(config, fetchImpl),

    async withLibrary<T>(fn: (library: Library) => T): Promise<T> {
      const db = await openDatabase(config.libraryPath);
      try {
        return fn(new Library(db));
      } finally {
        db.close();
      }
    },
  };
}
