/**
 * The RSS feed: the full backlog, and everything Apple's catalog leaves out.
 *
 * A podcast's feed is the source of truth. Apple's catalog is a cache of it,
 * and a lossy one: the Search API returns recent episodes rather than the
 * backlog, drops the Podcasting 2.0 namespace entirely, and gives a truncated
 * description where the feed has full show notes. Anything historical, and
 * anything a host publishes that Apple does not display, is only here.
 *
 * The three things worth coming here for:
 *
 * **Every episode, not the recent ones.** A show with nine hundred episodes has
 * all nine hundred in its feed. This is the difference between "what has this
 * show published lately" and "has this show ever covered X".
 *
 * **Transcripts that are actually fetchable.** `<podcast:transcript>` carries a
 * public URL to a VTT, SRT or JSON transcript. This is a real transcript, not a
 * snippet, and unlike Apple's own transcripts it is not access-controlled.
 * Whether a given show publishes them is the show's choice, so the tool reports
 * which episodes have one rather than promising all of them do.
 *
 * **Whether the feed is correct.** A feed missing a field Apple requires gets
 * rejected or silently degraded, and the failure surfaces days later as "my
 * show is not appearing". Checking it is a read against a documented list of
 * requirements, and it is the one thing in this server a show owner needs
 * before they have any listeners at all.
 *
 * A feed is somebody else's server. It can be slow, gone, or serving an HTML
 * error page under an XML content type, and the errors here say that rather
 * than implying Apple is at fault.
 */

import type { HttpClient } from "./http.js";
import { FeedError } from "./errors.js";
import { child, childAttr, childText, children, parseXml, type XmlNode } from "./xml.js";

export type Transcript = {
  url: string;
  /** MIME type, e.g. `text/vtt`, `application/srt`, `application/json`. */
  type?: string;
  language?: string;
  /** `captions` when the host marked it as such. */
  rel?: string;
};

export type FeedEpisode = {
  title: string;
  guid?: string;
  link?: string;
  publishedAt?: string;
  /** Seconds, normalised from either a number or HH:MM:SS. */
  durationSeconds?: number;
  /** Show notes. HTML is preserved: it carries the links and the timestamps. */
  description?: string;
  audioUrl?: string;
  audioType?: string;
  audioBytes?: number;
  episodeNumber?: number;
  seasonNumber?: number;
  /** `full`, `trailer` or `bonus`. */
  episodeType?: string;
  explicit?: boolean;
  imageUrl?: string;
  transcripts: Transcript[];
  chaptersUrl?: string;
};

export type Feed = {
  title: string;
  description?: string;
  link?: string;
  language?: string;
  author?: string;
  ownerName?: string;
  ownerEmail?: string;
  imageUrl?: string;
  categories: string[];
  explicit?: boolean;
  /** `episodic` or `serial`. */
  showType?: string;
  complete: boolean;
  /** `<podcast:guid>`, the stable cross-directory identifier when present. */
  podcastGuid?: string;
  /** `<podcast:locked>`, which tells other hosts not to accept an import. */
  locked?: boolean;
  fundingUrl?: string;
  fundingText?: string;
  /** New feed location when the show has moved. */
  newFeedUrl?: string;
  episodes: FeedEpisode[];
  /** Episodes present in the feed, before any limit was applied. */
  totalEpisodes: number;
  feedUrl: string;
};

export class FeedClient {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  async fetch(feedUrl: string, options: { limit?: number; fresh?: boolean } = {}): Promise<Feed> {
    let url: URL;
    try {
      url = new URL(feedUrl);
    } catch {
      throw new FeedError(`"${feedUrl}" is not a URL.`, 0, feedUrl);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new FeedError(
        `Feeds are fetched over HTTP or HTTPS. "${url.protocol}" is not supported.`,
        0,
        feedUrl,
      );
    }

    const body = await this.http.get<string>(feedUrl, {
      text: true,
      surface: "feed",
      fresh: options.fresh,
    });

    return parseFeed(body, feedUrl, options.limit);
  }
}

export function parseFeed(source: string, feedUrl: string, limit?: number): Feed {
  const root = parseXml(source);

  if (!root) {
    throw new FeedError(
      `${feedUrl} returned nothing that parses as XML. The host may be serving an error page, or a login wall, under a feed URL.`,
      0,
      feedUrl,
      source.slice(0, 200),
    );
  }

  // RSS puts everything under rss > channel. A few hosts serve Atom, which this
  // does not read, and saying so beats returning an empty feed.
  const channel = root.name === "channel" ? root : child(root, "channel");
  if (!channel) {
    // The two common cases are worth naming, because "no <channel>" alone
    // leaves someone staring at a URL that looks fine in a browser.
    const hint =
      root.name === "feed"
        ? " This looks like an Atom feed. Apple Podcasts requires RSS 2.0, so a show serving Atom is not distributable through Apple."
        : /^html$/i.test(root.name)
          ? " The host returned an HTML page rather than a feed, which usually means a 404, a login wall, or a bot check standing between this URL and the feed."
          : "";
    throw new FeedError(
      `${feedUrl} parsed, but has no <channel> element, so it is not an RSS feed.${hint}`,
      0,
      feedUrl,
      `root element: <${root.name}>`,
    );
  }

  const items = children(channel, "item");
  const sliced = limit && limit > 0 ? items.slice(0, limit) : items;

  const owner = child(channel, "itunes:owner");
  const funding = child(channel, "podcast:funding");

  return {
    title: childText(channel, "title") ?? "(untitled)",
    description: childText(channel, "description", "itunes:summary"),
    link: childText(channel, "link"),
    language: childText(channel, "language"),
    author: childText(channel, "itunes:author", "managingEditor"),
    ownerName: childText(owner, "itunes:name"),
    ownerEmail: childText(owner, "itunes:email"),
    imageUrl: channelImage(channel),
    categories: categoriesOf(channel),
    explicit: parseExplicit(childText(channel, "itunes:explicit")),
    showType: childText(channel, "itunes:type"),
    complete: (childText(channel, "itunes:complete") ?? "").toLowerCase() === "yes",
    podcastGuid: childText(channel, "podcast:guid"),
    locked: parseLocked(childText(channel, "podcast:locked")),
    fundingUrl: funding?.attrs.url,
    fundingText: funding?.text.trim() || undefined,
    newFeedUrl: childText(channel, "itunes:new-feed-url"),
    episodes: sliced.map(parseItem),
    totalEpisodes: items.length,
    feedUrl,
  };
}

function parseItem(item: XmlNode): FeedEpisode {
  const enclosure = child(item, "enclosure");
  const guidNode = child(item, "guid");
  const bytes = Number(enclosure?.attrs.length);

  return {
    title: childText(item, "title") ?? "(untitled)",
    guid: guidNode?.text.trim() || undefined,
    link: childText(item, "link"),
    publishedAt: normalizeDate(childText(item, "pubDate")),
    durationSeconds: parseDuration(childText(item, "itunes:duration", "duration")),
    // content:encoded is the full show notes where it exists; description is
    // often a truncated version of the same thing.
    description: childText(item, "content:encoded", "description", "itunes:summary"),
    audioUrl: enclosure?.attrs.url,
    audioType: enclosure?.attrs.type,
    audioBytes: Number.isFinite(bytes) && bytes > 0 ? bytes : undefined,
    episodeNumber: parseIntOrUndefined(childText(item, "itunes:episode")),
    seasonNumber: parseIntOrUndefined(childText(item, "itunes:season")),
    episodeType: childText(item, "itunes:episodeType"),
    explicit: parseExplicit(childText(item, "itunes:explicit")),
    imageUrl: childAttr(item, "itunes:image", "href"),
    transcripts: children(item, "podcast:transcript")
      .map((node) => ({
        url: node.attrs.url ?? "",
        type: node.attrs.type,
        language: node.attrs.language,
        rel: node.attrs.rel,
      }))
      .filter((t) => t.url),
    chaptersUrl: childAttr(item, "podcast:chapters", "url"),
  };
}

function channelImage(channel: XmlNode): string | undefined {
  // Apple reads itunes:image and ignores the RSS <image><url>, so it wins here
  // too. The RSS one is the fallback because some feeds only carry that.
  return childAttr(channel, "itunes:image", "href") ?? childText(child(channel, "image"), "url");
}

function categoriesOf(channel: XmlNode): string[] {
  const out: string[] = [];
  for (const node of children(channel, "itunes:category")) {
    const parent = node.attrs.text;
    if (!parent) continue;
    const subs = children(node, "itunes:category")
      .map((s) => s.attrs.text)
      .filter(Boolean);
    if (subs.length) {
      for (const sub of subs) out.push(`${parent} > ${sub}`);
    } else {
      out.push(parent);
    }
  }
  return out;
}

/**
 * Duration, as seconds.
 *
 * Apple accepts three shapes in this one field and feeds use all of them:
 * plain seconds, `MM:SS`, and `HH:MM:SS`. Reading it as a number gets `1:02:33`
 * wrong by a factor of thousands, which then ranks a two-minute trailer as the
 * longest episode of the show.
 */
export function parseDuration(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (!text) return undefined;

  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  }

  const parts = text.split(":").map((p) => Number(p.trim()));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return undefined;

  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return undefined;
}

/**
 * Normalise a pubDate to ISO-8601.
 *
 * RSS specifies RFC-2822 and feeds deliver approximations of it. Anything
 * unparseable is dropped rather than passed through, so a caller comparing two
 * timestamps never compares a date against a string that looks like one.
 */
export function normalizeDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw.trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function parseExplicit(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim().toLowerCase();
  if (["yes", "true", "explicit"].includes(t)) return true;
  if (["no", "false", "clean"].includes(t)) return false;
  return undefined;
}

function parseLocked(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  return raw.trim().toLowerCase() === "yes";
}

function parseIntOrUndefined(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

export type FeedIssue = {
  severity: "error" | "warning";
  field: string;
  message: string;
};

/**
 * Check a feed against what Apple actually requires.
 *
 * Everything flagged as an error is something Apple documents as required, and
 * a feed missing one is either rejected at submission or degraded quietly after
 * it. The warnings are the things that do not block distribution but cost the
 * show something: no transcripts, no episode numbers on a serial, an unstable
 * guid that will duplicate the entire back catalogue the next time the host
 * regenerates it.
 *
 * The guid check is the one that has bitten the most people. A guid that is
 * derived from the audio URL changes when the show changes host, and every
 * episode then reappears as new in every app at once.
 */
export function checkFeed(feed: Feed): FeedIssue[] {
  const issues: FeedIssue[] = [];
  const error = (field: string, message: string) =>
    issues.push({ severity: "error", field, message });
  const warn = (field: string, message: string) =>
    issues.push({ severity: "warning", field, message });

  if (!feed.title || feed.title === "(untitled)") error("title", "The channel has no <title>. Apple requires one.");
  if (!feed.description) error("description", "The channel has no <description> or <itunes:summary>. Apple requires one.");
  if (!feed.language) error("language", "No <language>. Apple requires an ISO 639 code such as en-us, and uses it to decide which storefronts the show appears in.");
  if (!feed.imageUrl) error("itunes:image", "No <itunes:image>. Apple requires cover art between 1400x1400 and 3000x3000 pixels, square, in JPEG or PNG.");
  if (!feed.categories.length) error("itunes:category", "No <itunes:category>. Apple requires at least one from its own list, and the text attribute has to match Apple's spelling exactly.");
  if (feed.explicit === undefined) error("itunes:explicit", "No <itunes:explicit>. Apple requires it on the channel, as yes or no.");
  if (!feed.episodes.length) error("item", "The feed has no <item> elements, so there is nothing to publish.");

  if (!feed.author) warn("itunes:author", "No <itunes:author>. This is the name shown under the show title in Apple Podcasts.");
  if (!feed.ownerEmail) warn("itunes:owner", "No <itunes:owner><itunes:email>. Apple uses it to verify ownership when claiming the show, so submission will stall without it.");
  if (!feed.podcastGuid) warn("podcast:guid", "No <podcast:guid>. It is the stable identifier that lets directories recognise this show as the same one after a host migration.");

  if (feed.newFeedUrl) {
    warn(
      "itunes:new-feed-url",
      `This feed declares <itunes:new-feed-url> pointing at ${feed.newFeedUrl}. The show has moved. Apple follows it and then stops reading this URL, so anything published here after the move is invisible.`,
    );
  }
  if (feed.complete) {
    warn("itunes:complete", "This feed is marked <itunes:complete>yes</itunes:complete>, which tells Apple the show has ended and to stop checking for new episodes.");
  }

  const withoutGuid = feed.episodes.filter((e) => !e.guid).length;
  if (withoutGuid) {
    error("guid", `${withoutGuid} episode(s) have no <guid>. Apple identifies an episode by its guid, and without one a re-published feed can duplicate or drop episodes.`);
  }

  const urlLikeGuids = feed.episodes.filter((e) => e.guid && /^https?:\/\//i.test(e.guid)).length;
  if (urlLikeGuids) {
    warn("guid", `${urlLikeGuids} episode(s) use a URL as their <guid>. That is legal, but if the URL ever changes, and it will on a host migration, every one of those episodes reappears as brand new in every app at once.`);
  }

  const withoutAudio = feed.episodes.filter((e) => !e.audioUrl).length;
  if (withoutAudio) {
    error("enclosure", `${withoutAudio} episode(s) have no <enclosure> audio URL, so there is nothing to play.`);
  }

  const withoutDate = feed.episodes.filter((e) => !e.publishedAt).length;
  if (withoutDate) {
    error("pubDate", `${withoutDate} episode(s) have a missing or unparseable <pubDate>. Apple orders episodes by it, so these sort unpredictably.`);
  }

  const withoutDuration = feed.episodes.filter((e) => e.durationSeconds === undefined).length;
  if (withoutDuration) {
    warn("itunes:duration", `${withoutDuration} episode(s) have no usable <itunes:duration>. Apple shows a run time from the audio file instead, but it is not available until the file has been fetched.`);
  }

  const withTranscript = feed.episodes.filter((e) => e.transcripts.length).length;
  if (!withTranscript && feed.episodes.length) {
    warn("podcast:transcript", "No episode carries a <podcast:transcript>. Transcripts make a show searchable in apps that index them, and they are the only transcripts an outside tool can actually read.");
  }

  return issues;
}
