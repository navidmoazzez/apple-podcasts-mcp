<div align="center">
  <img src="https://cdn.navid.media/connectors/apple-podcasts-icon.png" alt="Apple Podcasts" width="88">
</div>

# Apple Podcasts MCP

[![License](https://img.shields.io/badge/License-MIT-blue)](https://github.com/navidmoazzez/apple-podcasts-mcp/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/@thenavidm/apple-podcasts-mcp?color=orange&label=npm)](https://www.npmjs.com/package/@thenavidm/apple-podcasts-mcp)
[![YouTube](https://img.shields.io/badge/YouTube-@thenavidm-red?logo=youtube&logoColor=white)](https://youtube.com/@thenavidm?sub_confirmation=1)
[![X](https://img.shields.io/badge/X-@thenavidm-black?logo=x)](https://x.com/thenavidm)

Apple Podcasts for Claude, Cursor, and any other AI agent.

It searches Apple's catalog, checks where a show ranks in each country, reads the listener reviews, parses any podcast's RSS feed, and searches the episodes in your own library on this Mac. If you own a show, it pulls your listening numbers too.

There are 32 tools, and only the five that read your own show's analytics need an account of any kind.

Built by [Navid Moazzez](https://navid.me).

```
You: is My First Million actually winning, or does it just feel like it?

Claude: Checked eight storefronts. It is not in Apple's top 100 in any of them,
        which is worth holding next to the rest of the picture.

  896 episodes, publishing every 2.9 days, so about 10 a month. That is a
  daily-news cadence on an interview show, and it has held for years.

  70 recent reviews across us, gb and se average 4.13, but the shape is
  odd: 50 five-star and 12 one-star, almost nothing in between. The
  one-stars are not about the content, they are all about ad load.

  So: large, relentless, and polarising on ads rather than on substance.
  The chart absence says the top 100 is dominated by daily news and true
  crime, not that the show is fading.
```

## Contents

| | Section | |
|---|---|---|
| 1 | [What you can ask it](#1-what-you-can-ask-it-) | Real prompts, not features |
| 2 | [Quick install](#2-quick-install-) | One line, no account |
| 3 | [Setup](#3-setup-) | Only if you want the optional parts |
| 4 | [Connect your client](#4-connect-your-client-) | Every client, copy and paste |
| 5 | [Check it worked](#5-check-it-worked-) | `doctor`, and what actually fails |
| 6 | [Tools](#6-tools-) | All 32, grouped by what they reach |
| 7 | [The four sources](#7-the-four-sources-) | Why this is not one API |
| 8 | [What Apple actually does](#8-what-apple-actually-does-) | The traps, learned the hard way |
| 9 | [Your data](#9-your-data-) | What is read, and what never leaves |
| 10 | [Safety](#10-safety-) | Short, because almost nothing writes |
| 11 | [Troubleshooting](#11-troubleshooting-) | Symptom to cause |
| 12 | [FAQ](#12-faq-) | Including what an MCP server is |

---

## 1. What you can ask it 💬

- Where does this show rank in the US, UK and Sweden, and where is it strongest?
- What are people complaining about in the reviews of my competitor's show?
- Which episode was that thing about compound interest I heard a while back?
- Compare these four shows on rank, ratings and how often they publish.
- Is my podcast feed missing anything Apple requires?
- What is trending in podcasts right now that is not true crime?
- Find shows like this one, so I can see who else is in this niche.
- Which of the shows I follow publish real transcripts I can read?
- How many people played my episodes last week, and which one won?
- Export everything I subscribe to as OPML so I can leave Apple Podcasts.

**The third one is the point.** Apple caches a transcript excerpt for nearly
every episode of every show you follow, and nothing surfaces it. On a normal
library that is tens of thousands of excerpts of real spoken words sitting on
your Mac, searchable, and it answers "where did I hear that" in a way no
catalog can.

---

## 2. Quick install ⚡

Node 20 or newer. Nothing else.

```bash
npx -y @thenavidm/apple-podcasts-mcp@latest --version
```

That is the whole install. `npx` fetches it on demand, so there is nothing to
update later.

**Most of this server works immediately, with no account.** Apple's catalog,
its charts, its reviews and every podcast RSS feed are all open. Your own
library is read straight off this Mac. Section 3 is only for the parts that
need something extra, and you can skip it entirely.

---

## 3. Setup 🔑

Nothing here is required. Skip to [section 4](#4-connect-your-client-) and come
back when you want one of these.

### Reading your own library

Nothing to configure, but macOS may need to be told to allow it.

The Apple Podcasts library lives in a protected group container, so the app
running the server needs **Full Disk Access**:

1. Open **System Settings**, then **Privacy & Security**, then **Full Disk Access**.
2. Click **+** and add the app that launches the server. For Claude Code or
   Codex that is your terminal (Terminal, iTerm, Ghostty). For Claude Desktop
   it is Claude itself.
3. Quit that app completely and reopen it. The permission is only read at launch.

If you would rather this server never read your subscriptions, set
`APPLE_PODCASTS_LIBRARY=0` and those seven tools disappear from the list
entirely.

This group only exists on macOS. On Linux or Windows the other 25 tools work
normally.

### Apple Podcasts Connect analytics

Only for a show you own and administer. It is the one part with credentials.

1. Sign in to [podcastsconnect.apple.com](https://podcastsconnect.apple.com).
2. Your **vendor number** is on the account. It is a numeric id, usually seven
   or eight digits.
3. Generate a **Reporter access token** under the account's Reporter settings.
   Copy it immediately: Apple shows it once.
4. Set both as environment variables in your client config, as
   `APPLE_PODCASTS_VENDOR_NUMBER` and `APPLE_PODCASTS_REPORTER_TOKEN`.

The token **expires after 180 days** and has to be regenerated in Podcasts
Connect. Nothing in this server can mint or refresh one. `doctor` reports
whether the token still works, and `check_analytics_access` lists which vendor
numbers it can actually read, which is the fastest way to tell a wrong token
from a wrong vendor number.

To revoke it, delete the token in Podcasts Connect. That takes effect
immediately.

### Have an agent do it

The agent cannot sign in to Apple for you. What it can do is wire up the config
and verify it. Paste this into Claude Code, Cursor, or any agent with terminal
access:

```
Set up @thenavidm/apple-podcasts-mcp for me.

1. Add it to my MCP client config, running via `npx -y @thenavidm/apple-podcasts-mcp@latest`.
2. Run `npx -y @thenavidm/apple-podcasts-mcp@latest doctor` and show me the output.
3. If the local library check fails on permissions, tell me exactly which app
   to add to Full Disk Access and stop so I can do it.
4. Do not ask me for Apple Podcasts Connect credentials unless I say I own a
   show. Everything else works without them.
```

---

## 4. Connect your client 🔌

Every block is self-contained. No credentials are needed in any of them; the
`env` block is only for the optional extras from section 3.

### Claude Code

```bash
claude mcp add apple-podcasts -- npx -y @thenavidm/apple-podcasts-mcp@latest
```

`--scope user` makes it available in every project rather than the current one.

### Claude Desktop

**1. Open the config file.**

In Claude Desktop go to **Settings**, then **Developer**, then click
**Edit Config**. That reveals `claude_desktop_config.json` in your file manager.
Open it in any text editor.

To go straight there:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

On macOS, from a terminal:

```bash
open -e ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**2. Add the server.**

If the file is empty or does not exist, paste this whole thing in:

```json
{
  "mcpServers": {
    "apple-podcasts": {
      "command": "npx",
      "args": ["-y", "@thenavidm/apple-podcasts-mcp@latest"]
    }
  }
}
```

If you already have other servers, add only the `"apple-podcasts": { ... }` part
inside your existing `"mcpServers"`, and put a comma after the entry before it.
The file has to stay valid JSON. One missing comma or one trailing comma stops
every server from loading, not just this one.

> **Tip**
> Claude Desktop does not inherit your shell PATH. If `npx` is not found, run
> `which npx` in a terminal and use that absolute path as the `command`.

**3. Restart properly.**

Quit Claude Desktop completely and reopen it. On macOS closing the window is not
enough, use **Cmd+Q**. On Windows quit it from the system tray. Claude only
reads that file at startup.

**4. Check it worked.**

Look for the tools icon in the message box and click it. You should see
`apple-podcasts` with its tools listed. Then ask it something from
[section 1](#1-what-you-can-ask-it-).

If nothing appears, Claude Desktop's own log is the fastest way in:

| Platform | Path |
|---|---|
| macOS | `~/Library/Logs/Claude/mcp-server-apple-podcasts.log` |
| Windows | `%APPDATA%\Claude\logs\mcp-server-apple-podcasts.log` |

```bash
tail -n 50 ~/Library/Logs/Claude/mcp-server-apple-podcasts.log
```

### Cursor

`.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for every project. Same
JSON shape as Claude Desktop, with the key `mcpServers`. Then reload the window,
or open **Settings**, **MCP**, and toggle the server.

### Windsurf

`~/.codeium/windsurf/mcp_config.json`, key `mcpServers`, same JSON shape. Then
reload.

### VS Code

`.vscode/mcp.json`. The key is **`servers`**, not `mcpServers`, and each entry
takes a `type`:

```json
{
  "servers": {
    "apple-podcasts": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@thenavidm/apple-podcasts-mcp@latest"]
    }
  }
}
```

Or run **MCP: Add Server** from the command palette.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.apple-podcasts]
command = "npx"
args = ["-y", "@thenavidm/apple-podcasts-mcp@latest"]
```

### Gemini CLI

`~/.gemini/settings.json`, key `mcpServers`, same JSON shape as Claude Desktop.

### claude.ai on the web

claude.ai runs connectors from Anthropic's cloud rather than your machine, so it
needs a public HTTPS URL and cannot run a local command.

```bash
npx -y @thenavidm/apple-podcasts-mcp@latest --http --port 8000
```

Host that somewhere with a public HTTPS URL, then in claude.ai: **Customize**,
**Connectors**, **+**, **Add custom connector**. Paste the URL and click **Add**.

> **The library tools cannot be hosted.** They read the Apple Podcasts database
> on whatever machine the server runs on, so a hosted instance would serve
> *your* subscriptions to every caller. The server refuses to start bound to
> anything but loopback while the library is enabled. Set
> `APPLE_PODCASTS_LIBRARY=0` to host the 25 public tools.

Set `APPLE_PODCASTS_HTTP_TOKEN` so the endpoint is not open, and put it behind
TLS. `GET /health` reports the tool count and capability without authentication.

### Docker

```bash
docker build -t apple-podcasts-mcp .
docker run --rm -i apple-podcasts-mcp
```

The container has no Apple Podcasts library, so it runs the public tools only.

### Everything else

Any stdio MCP client takes the same three things: the command `npx`, the args,
and optionally an `env` block. Zed, Cline and Continue all work.

---

## 5. Check it worked 🩺

```bash
npx -y @thenavidm/apple-podcasts-mcp@latest doctor
```

It probes each of the four sources separately and names the failing one, rather
than leaving you with "the tool errored". It also checks two things this server
assumes but cannot guarantee: that the Podcasts database still has the columns
it reads, and whether your library holds any usable play data.

Two things account for most failures:

| Symptom | Cause |
|---|---|
| Server does not appear at all | Node is not on the PATH your client sees, or the config JSON is malformed. Run the exact command your client runs, by hand, and read the error |
| Library checks fail on permissions | Full Disk Access, see [section 3](#3-setup-). Adding the client is not enough if it launches the server through a terminal |

---

## 6. Tools 🛠️

32 tools. Everything that reads Apple's catalog takes an optional `storefront`.
Anywhere a show is named, it takes an Apple id **or** a pasted Apple Podcasts
URL, so a link someone sent you works directly.

### Start here

| Tool | What it does |
|---|---|
| `status` | Which of the four sources are reachable right now. Local and free |
| `get_show_profile` | One show, everything: catalog, rank across markets, review sentiment, publishing cadence, transcripts. **The one to reach for** |
| `resolve_apple_link` | Turn a pasted Apple Podcasts URL into show and episode ids |

### Catalog

| Tool | Arguments |
|---|---|
| `search_podcasts` | `query`, `genre_id`, `match`, `limit`, `storefront` |
| `search_episodes` | `query`, `limit`, `storefront` |
| `get_podcast` | `show`, `storefront` |
| `get_podcast_episodes` | `show`, `limit`, `storefront` |
| `list_genres` | `storefront`, `top_level_only` |

### Charts and ranking

| Tool | Arguments |
|---|---|
| `get_top_shows` | `limit`, `genre`, `storefront` |
| `get_trending_episodes` | `limit`, `storefront` |
| `find_chart_position` | `show`, `storefronts[]`, `include_episodes` |
| `list_storefronts` | none |

### Reviews

| Tool | Arguments |
|---|---|
| `get_reviews` | `show`, `storefronts[]`, `sort`, `limit` |
| `get_review_summary` | `show`, `storefronts[]`, `limit` |

### Feeds

| Tool | Arguments |
|---|---|
| `get_feed` | `show`, `limit`, `include_episodes` |
| `get_feed_episode` | `show`, `episode`, `limit` |
| `find_transcripts` | `show`, `limit` |
| `check_feed` | `show`, `limit` |

### Research

| Tool | Arguments |
|---|---|
| `get_show_profile` | `show`, `storefronts[]`, `reviews` |
| `compare_shows` | `shows[]` (2 to 6), `storefront`, `reviews` |
| `find_similar_shows` | `show`, `limit`, `storefront` |

### Your library

macOS only. Hidden entirely by `APPLE_PODCASTS_LIBRARY=0`.

| Tool | Arguments |
|---|---|
| `search_library` | `query`, `show`, `include_transcripts`, `full`, `limit` |
| `list_subscriptions` | `followed_only`, `limit` |
| `list_recent_episodes` | `show`, `since_hours`, `full`, `limit` |
| `list_saved_episodes` | `kind`, `full`, `limit` |
| `get_library_episode` | `id` |
| `library_stats` | none |
| `export_subscriptions` | `path`, `followed_only`, `confirm` |

### Owner analytics

Needs Apple Podcasts Connect credentials. Listed even when unconfigured, so they
can tell you what is missing.

| Tool | Arguments |
|---|---|
| `check_analytics_access` | none |
| `get_show_analytics` | `date_type`, `date`, `worldwide` |
| `get_episode_analytics` | `date_type`, `date`, `worldwide`, `limit` |
| `get_followers` | `date_type`, `date` |
| `get_analytics_report` | `report_type`, `date_type`, `date`, `limit` |

### Resources and prompts

Three resources, so a client can load context without spending a tool call:
`apple-podcasts://status`, `apple-podcasts://concepts`,
`apple-podcasts://output-format`.

Four prompts: **show-teardown**, **niche-map**, **what-did-i-hear**,
**feed-checkup**.

---

## 7. The four sources 📚

Apple Podcasts is not one API. It is four things wearing the same brand, and
they differ in who can reach them and what they are good for. This is the single
most useful thing to understand about this server.

| Source | Reach | Credential | Good for |
|---|---|---|---|
| Search API | anyone | none | discovery, competitive research |
| Charts and reviews | anyone | none | ranking, audience voice |
| A show's RSS feed | anyone | none | the full backlog, real transcripts |
| Your local library | this Mac | none | your own subscriptions and cached transcripts |
| Podcasts Connect | a show you own | vendor number and token | plays, followers, per-episode consumption |

Three of those need nothing at all. That is unusual and it is why this works the
moment you install it.

---

## 8. What Apple actually does ⚠️

The section that makes this worth more than the API docs it wraps. Everything
here was verified against the live services, not recalled.

### Storefronts change the answer, silently

The catalog, the charts and the reviews are all per country. The same search in
`us` and `se` returns different shows in a different order, a show can be
published in one market and not another, and its review pool is entirely
separate in each.

An empty result in one storefront is **not** evidence a show does not exist.
Every listing here carries the storefront it came from for exactly this reason.

### Ranking stops at 100, and there are no genre charts

Apple publishes two charts per storefront: Top Shows, which is follower-weighted
and slow, and Trending Episodes, which moves fast and is the better read on what
a topic is doing this week. Both cap at 100 and asking for 200 fails.

**A genre-scoped chart returns 404.** Apple serves one overall chart per country.
The `genre` argument on `get_top_shows` filters that list, so it gives the
charting shows that happen to be in a genre, not that genre's own top 100.

There is also no endpoint for "where does this show rank". Finding a rank means
fetching the chart and looking, which is what `find_chart_position` does, once
per storefront.

### The Search API answers 200 for failures

A malformed query returns HTTP 200 with an `errorMessage` field and zero
results. Handled by status alone that reads as "nothing matched", and a model
told a search found nothing concludes the show does not exist. Every response
here is inspected on success, not only on failure.

### Rate limiting is real, silent, and has no header

Roughly 20 requests a minute per IP, answered with 403 and an HTML body. No
`Retry-After`, no quota endpoint, no announcement.

Requests are therefore spaced and queued rather than fired in parallel, and
responses are cached for five minutes, so asking about six shows fetches the
chart once rather than six times. Prefer `get_show_profile` and `compare_shows`
over calling single tools in a loop.

### Transcripts: two kinds, one readable

**Feed transcripts are public.** `<podcast:transcript>` in a show's RSS carries
a URL to a VTT, SRT or JSON transcript that anything can fetch.
`find_transcripts` lists them. Most shows publish none, which is the show's
choice.

**Apple's own transcripts are not readable.** The ones the app displays are
access-controlled, and their CDN refuses unauthenticated requests. What does
exist is a short excerpt Apple caches locally for episodes in your library,
speaker-tagged and typically a few hundred characters, present for nearly every
episode. `search_library` searches those. It is an excerpt, not the episode, and
the tools say so rather than implying otherwise.

### Your library holds far more than the app shows

The Podcasts app keeps a Core Data store with every episode of every show you
follow: full descriptions, dates, durations, guids and audio URLs, whether or
not anything was ever downloaded. On a normally-used library that is tens of
thousands of episodes.

Its dates are Core Data timestamps, which are seconds since 2001, not 1970. Read
as Unix time, every date in your library lands in 1970.

**Play data usually is not there.** On a library synced from an iPhone, the
playhead and play-count columns are zero on every row. Listening progress is
tracked on the device that played the episode and does not reach the Mac. So
nothing here can tell you what you have listened to. `library_stats` reports
whether your library actually has usable play data, and the tools decline to
infer listening history rather than presenting a zero as a finding.

### Podcasts Connect lags, and counts devices

Reporting is one to two days behind, and a request for today returns an error
that reads as breakage. Every analytics tool here defaults to three days back.

Listener counts are **devices**, not people. One person on a phone and a
HomePod counts twice, and Apple has no way to collapse them.

The access token expires after 180 days with no refresh path.

---

## 9. Your data 🔒

There is no server behind this. Your requests go straight from your machine to
Apple and to podcast hosts, and nothing is collected or sent anywhere else.

| | Where |
|---|---|
| Your subscriptions and episodes | Read from `~/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/`, read-only, never written |
| Apple Podcasts Connect credentials | Your client's config. Never written to disk by this server |
| Catalog and chart responses | Memory only, for five minutes |
| OPML export | Only the path you name, and only with `confirm: true` |
| Audit log | Only the file you name in `APPLE_PODCASTS_AUDIT_LOG` |

The library database is opened read-only through an immutable URI, which is also
why reads work while the Podcasts app is running.

Hosts contacted: `itunes.apple.com`, `rss.marketingtools.apple.com`,
`reportingitc-reporter.apple.com` if you configure analytics, and whatever host
serves a podcast RSS feed you ask for.

---

## 10. Safety 🛡️

Short, because there is almost nothing to guard. **There is no Apple Podcasts
write API and this server does not invent one.** Of 32 tools, 31 only read.

`export_subscriptions` writes an OPML file, so it refuses without
`confirm: true`. That is the only guard, deliberately: a confirmation on every
call would train a model to pass the flag reflexively, which is worse than not
asking.

The control that matters here is privacy rather than damage:

```bash
APPLE_PODCASTS_LIBRARY=0     # removes all seven library tools from the list
APPLE_PODCASTS_READ_ONLY=1   # removes the OPML export too
APPLE_PODCASTS_AUDIT_LOG=~/.apple-podcasts-mcp/writes.jsonl
```

Tools disappear from the list rather than erroring when called, because a model
cannot call a tool it cannot see.

**Prompt injection.** Reviews are the most injectable surface here, and
"summarise my reviews" is the first thing anyone asks. Review bodies, show notes
and transcript excerpts are all fenced with a marker naming them as data before
a model reads them, and any attempt to close that fence early is defanged. The
server instructions repeat the rule. That framing helps and it is not a
guarantee: for an agent working unattended over other people's text,
`APPLE_PODCASTS_READ_ONLY=1` is the real defence.

---

## 11. Troubleshooting 🔧

`doctor` first. It names the failing source and the fix.

| Symptom | Cause |
|---|---|
| Every library tool fails on permissions | Full Disk Access, on the app that launches the server, then restart it. See [section 3](#3-setup-) |
| "No Apple Podcasts library at ..." | The database is created the first time the Podcasts app runs and follows a show. Set `APPLE_PODCASTS_LIBRARY_PATH` if yours is elsewhere |
| Library tools are missing from the list | `APPLE_PODCASTS_LIBRARY=0`, or you are not on macOS |
| "Apple is rate limiting this IP" | Roughly 20 requests a minute. Wait a minute. Use `get_show_profile` or `compare_shows` rather than looping single calls |
| A search returns nothing for a show you know exists | Wrong storefront. The show may not be published there. Try `storefront: "gb"` or wherever it is based |
| A show is unranked everywhere | Apple only publishes the top 100 per storefront. Outside that band there is no ranking to report |
| `get_top_shows` with a genre looks wrong | There are no genre charts. That argument filters the overall chart |
| `find_transcripts` returns nothing | The show publishes none. Apple's own transcripts are not readable by anything outside the Podcasts app |
| `library_stats` says no usable play data | Normal on a Mac. Progress is tracked on the device you listen on |
| Analytics say "no report available" | Reporting lags one to two days. Try a date three or four days back |
| Analytics reject the token | Tokens expire after 180 days. Regenerate it in Podcasts Connect |
| "will not run without confirm: true" | Working as intended. Only `export_subscriptions` does this |

---

## 12. FAQ ❓

<details>
<summary><b>What is an MCP server?</b></summary>

An MCP server is a small program that gives an AI assistant a set of tools. MCP is the open protocol Claude, Cursor, Windsurf, VS Code and others use to talk to them. You install it once, and then you ask questions in plain language instead of calling an API.

</details>

<details>
<summary><b>Do I need an Apple developer account?</b></summary>

You do not need one. Nothing in the first 25 tools needs an account of any kind. Only the owner analytics do, and only if you have a show in Apple Podcasts Connect.

</details>

<details>
<summary><b>Does it work on Windows or Linux?</b></summary>

It works everywhere apart from the library tools. Those read the Apple Podcasts app's database, which only exists on macOS. The other 25 work anywhere.

</details>

<details>
<summary><b>Can it post, subscribe, or rate a show?</b></summary>

It cannot. Apple publishes no write API for podcasts, so there is nothing to call. This server only reads.

</details>

<details>
<summary><b>Can it read the transcript of any episode?</b></summary>

It reads only the transcripts a show publishes in its own feed, which `find_transcripts` lists. Apple's own transcripts are access-controlled and unreadable outside the Podcasts app. For shows you follow, Apple caches a short excerpt locally and `search_library` searches those.

</details>

<details>
<summary><b>Can it tell me what I have listened to?</b></summary>

Almost certainly not, and it will say so rather than guess. Listening progress lives on the device you listen on and does not sync to the Mac's copy of the library. `library_stats` tells you whether yours is an exception.

</details>

<details>
<summary><b>Why does it ask for Full Disk Access?</b></summary>

It does not ask; macOS refuses without it. The Apple Podcasts library sits in a protected group container. The server opens it read-only and never writes to it. Set `APPLE_PODCASTS_LIBRARY=0` if you would rather it never looked.

</details>

<details>
<summary><b>Does it work with Spotify or other podcast apps?</b></summary>

It covers Apple Podcasts only. Any show's RSS feed can be read regardless of where it is distributed, so `get_feed` and `check_feed` are useful either way.

</details>

<details>
<summary><b>Why are my two storefronts giving different answers?</b></summary>

Because they are different. Apple runs a separate catalog, chart and review pool per country. That is a feature of the data, not a bug, and it is often the most useful thing in it.

</details>

<details>
<summary><b>Is my data sent anywhere?</b></summary>

Nothing is sent anywhere. There is no backend: requests go to Apple and to podcast RSS hosts and nowhere else.

</details>

---

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `APPLE_PODCASTS_STOREFRONT` | `us` | Country code used when a tool names none |
| `APPLE_PODCASTS_STOREFRONTS` | `us,gb,ca,au,ie,se,de,nl` | Markets the cross-market tools sweep |
| `APPLE_PODCASTS_LIBRARY` | `1` | `0` removes every local-library tool |
| `APPLE_PODCASTS_LIBRARY_PATH` | the app's default | Where the Podcasts database is |
| `APPLE_PODCASTS_VENDOR_NUMBER` | none | Apple Podcasts Connect vendor number |
| `APPLE_PODCASTS_REPORTER_TOKEN` | none | Reporter access token, expires after 180 days |
| `APPLE_PODCASTS_READ_ONLY` | `0` | Hide the one tool that writes a file |
| `APPLE_PODCASTS_ALLOW_DESTRUCTIVE` | `1` | `0` blocks the OPML export |
| `APPLE_PODCASTS_AUDIT_LOG` | none | Append-only log of every attempted write |
| `APPLE_PODCASTS_CACHE_TTL_MS` | `300000` | How long a fetched response stays reusable |
| `APPLE_PODCASTS_REQUEST_TIMEOUT_MS` | `30000` | Per-request deadline |
| `APPLE_PODCASTS_MIN_REQUEST_INTERVAL_MS` | `220` | Spacing between requests, to stay under the limit |
| `APPLE_PODCASTS_MAX_RETRIES` | `3` | Retries on 5xx and transient errors |
| `APPLE_PODCASTS_HTTP_PORT` | `8788` | For `--http` |
| `APPLE_PODCASTS_HTTP_HOST` | `127.0.0.1` | For `--http` |
| `APPLE_PODCASTS_HTTP_TOKEN` | none | Bearer token required by `--http` |

## Versions

See [VERSIONS.md](https://github.com/navidmoazzez/apple-podcasts-mcp/blob/main/VERSIONS.md).

## Questions

Run into a problem or have a question? [Open an issue](https://github.com/navidmoazzez/apple-podcasts-mcp/issues) and I will help.

## About the author

Navid Moazzez is a leading AI business strategist, and the host of the AI Creator Summit, watched by 100,000+ creators. He helps creators and founders master AI and build their own AI Operating System (AI OS) to automate their business and life. This Apple Podcasts MCP server is one piece of that system.

**Links**

- Personal website: [navid.me](https://navid.me)
- Navid Media: [navid.media](https://navid.media)
- YouTube: [@thenavidm](https://youtube.com/@thenavidm?sub_confirmation=1) and [@thenavidai](https://youtube.com/@thenavidai?sub_confirmation=1)
- X: [@thenavidm](https://x.com/thenavidm)
- Instagram: [@thenavidm](https://instagram.com/thenavidm)
- LinkedIn: [thenavidm](https://linkedin.com/in/thenavidm)

## Dependencies

| Library | Licence | What it does |
|---|---|---|
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | The MCP server and transports |
| [zod](https://github.com/colinhacks/zod) | MIT | Tool argument schemas and validation |

RSS parsing and SQLite reading are both built in, so there is nothing else to
install. The library is read through Node's own `node:sqlite` where available,
falling back to the `sqlite3` command that ships with macOS.

## License

[MIT](https://github.com/navidmoazzez/apple-podcasts-mcp/blob/main/LICENSE). Free to use, modify, and share.

Not affiliated with, endorsed by, or connected to Apple Inc.

---

© 2026 NM Media. Made with ❤️ by [Navid Moazzez](https://navid.me).
