/** Every tool, in the order they should appear in a client's tool list. */

import { STATUS_TOOLS } from "./status.js";
import { CATALOG_TOOLS } from "./catalog.js";
import { CHART_TOOLS } from "./charts.js";
import { REVIEW_TOOLS } from "./reviews.js";
import { FEED_TOOLS } from "./feed.js";
import { RESEARCH_TOOLS } from "./research.js";
import { LIBRARY_TOOLS } from "./library.js";
import { ANALYTICS_TOOLS } from "./analytics.js";
import type { AnyToolSpec } from "./kit.js";

export const ALL_TOOLS = [
  ...STATUS_TOOLS,
  ...CATALOG_TOOLS,
  ...CHART_TOOLS,
  ...REVIEW_TOOLS,
  ...FEED_TOOLS,
  ...RESEARCH_TOOLS,
  ...LIBRARY_TOOLS,
  ...ANALYTICS_TOOLS,
] as unknown as AnyToolSpec[];
