/**
 * What this server can currently reach.
 *
 * Worth a tool of its own rather than only a CLI command. A model that starts a
 * session by asking what is available stops guessing, and the four surfaces
 * here are unusual enough that guessing is likely: three of them need nothing,
 * one needs a Mac with the Podcasts app, and one needs credentials most people
 * do not have. Answering that in one cheap local call prevents a chain of
 * confident failures.
 */

import { existsSync } from "node:fs";
import { hasReporterCredentials } from "../config.js";
import { defineTool } from "./kit.js";

export const status = defineTool({
  name: "status",
  title: "What this server can reach",
  description:
    "Report which of the four Apple Podcasts sources are available right now: the public catalog, charts and reviews, the local library on this Mac, and Apple Podcasts Connect analytics. Call this first if a tool has failed, or before planning work that depends on the library or on owner analytics. Contacts nothing and costs nothing.",
  schema: {},
  risk: "read",
  surface: "public",
  handler: async (_args, ctx) => {
    const libraryPresent = existsSync(ctx.config.libraryPath);

    return {
      surfaces: {
        catalog: {
          available: true,
          note: "Search and lookup across Apple's public podcast catalog. No credentials needed. Rate limited by Apple at roughly 20 requests a minute per IP.",
        },
        charts_and_reviews: {
          available: true,
          note: "Top Shows, Trending Episodes and listener reviews, per storefront. No credentials needed.",
        },
        library: {
          available: ctx.config.libraryEnabled && libraryPresent,
          enabled: ctx.config.libraryEnabled,
          database_present: libraryPresent,
          path: ctx.config.libraryPath,
          note: !ctx.config.libraryEnabled
            ? "Switched off with APPLE_PODCASTS_LIBRARY=0, so the library tools are not in the tool list at all."
            : libraryPresent
              ? "The Apple Podcasts database is present. If reads fail with a permissions error, the app running this server needs Full Disk Access."
              : "No Apple Podcasts database at this path. It exists only on a Mac where the Podcasts app has run and followed at least one show.",
        },
        analytics: {
          available: hasReporterCredentials(ctx.config),
          vendor_number_set: Boolean(ctx.config.vendorNumber),
          token_set: Boolean(ctx.config.reporterToken),
          note: hasReporterCredentials(ctx.config)
            ? "Apple Podcasts Connect credentials are set. Call check_analytics_access to confirm they work. Reporting lags one to two days."
            : "Not configured. These exist only for a show you own in Apple Podcasts Connect, and every other tool here works without them.",
        },
      },
      storefront: {
        default: ctx.config.storefront,
        sweep: ctx.config.storefronts,
      },
      writes: {
        read_only: ctx.config.readOnly,
        note: "This server only reads, apart from export_subscriptions, which writes an OPML file and requires confirm: true.",
      },
    };
  },
});

export const STATUS_TOOLS = [status];
