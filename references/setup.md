# Apple Podcasts MCP setup

Most of this server needs no setup at all. Apple's catalog, its charts, its
reviews and every podcast RSS feed are open, so `npx -y
@thenavidm/apple-podcasts-mcp@latest` gives you 25 working tools immediately.

This file covers the two optional parts.

## Prerequisites

Node 20 or newer. Nothing else.

## 1. Reading your own library (macOS)

Seven extra tools, including the transcript search, which is the most useful
thing here. There is nothing to configure, but macOS has to be told to allow it.

The Apple Podcasts library lives at:

```
~/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite
```

That is a protected group container. macOS refuses to read it without **Full
Disk Access**, and the refusal surfaces as a permissions error on every library
tool.

1. **System Settings**, then **Privacy & Security**, then **Full Disk Access**.
2. Click **+** and add the app that *launches the server*, which is not always
   the app you are talking to:

   | Client | Add this |
   |---|---|
   | Claude Code, Codex, Gemini CLI | your terminal: Terminal, iTerm, Ghostty |
   | Claude Desktop | Claude |
   | Cursor, VS Code, Windsurf | that editor |

3. **Quit that app completely and reopen it.** The permission is only read at
   launch, so a running app keeps the old answer.

Then:

```bash
npx -y @thenavidm/apple-podcasts-mcp@latest doctor
```

The library check reports how many shows and episodes it can see, how many carry
a cached transcript excerpt, and whether your library has any usable play data.

### If you would rather it never looked

```bash
APPLE_PODCASTS_LIBRARY=0
```

Those seven tools are removed from the tool list entirely, rather than erroring
when called.

### What is actually readable

The database holds every episode of every show you follow, with full
descriptions, dates, durations, guids and audio URLs, whether or not anything
was downloaded. Nearly every episode also carries a short transcript excerpt
Apple cached, speaker-tagged, a few hundred characters. That is what
`search_library` searches.

Two things are **not** readable, and the tools say so rather than guessing:

- **Full Apple transcripts.** The database holds CDN paths to them and the CDN
  refuses unauthenticated requests. Only transcripts a show publishes in its own
  RSS feed can be fetched, and `find_transcripts` lists those.
- **Listening history.** On a library synced from an iPhone, the playhead and
  play-count columns are zero on every row. Progress lives on the device that
  played the episode. `library_stats` reports whether yours is an exception.

## 2. Apple Podcasts Connect analytics

Five extra tools, and the only part with credentials. It works only for a show
you own and administer.

### Get the two values

1. Sign in to [podcastsconnect.apple.com](https://podcastsconnect.apple.com).
2. Find your **vendor number** on the account. It is numeric, usually seven or
   eight digits.
3. Generate a **Reporter access token** under the account's Reporter settings.

**Copy the token immediately.** Apple displays it once and there is no way to
read it back later; a lost token has to be regenerated, which invalidates the
old one.

### Set them

In your MCP client config, as an `env` block:

```json
{
  "mcpServers": {
    "apple-podcasts": {
      "command": "npx",
      "args": ["-y", "@thenavidm/apple-podcasts-mcp@latest"],
      "env": {
        "APPLE_PODCASTS_VENDOR_NUMBER": "1234567",
        "APPLE_PODCASTS_REPORTER_TOKEN": "..."
      }
    }
  }
}
```

Or in a shell, for `doctor`:

```bash
export APPLE_PODCASTS_VENDOR_NUMBER=1234567
export APPLE_PODCASTS_REPORTER_TOKEN=...
npx -y @thenavidm/apple-podcasts-mcp@latest doctor
```

### Check it

```
check_analytics_access
```

It lists the vendor numbers the token can actually read, which is the fastest
way to tell a wrong token from a wrong vendor number. Both otherwise produce the
same unhelpful failure.

### Two things that look like breakage and are not

**Reporting lags one to two days.** A request for today returns Apple's "no
report available" error. Every analytics tool here defaults to three days back
for that reason. If you pass an explicit date, keep it a few days behind.

**Listener counts are devices, not people.** One person listening on a phone and
a HomePod counts twice, and Apple has no way to collapse them. Treat the figure
as an upper bound on humans.

### The 180-day clock

The access token expires after 180 days. Nothing in this server can refresh or
mint one; it has to be regenerated in Podcasts Connect. `doctor` reports whether
the current one still works.

To revoke it, delete it in Podcasts Connect. That takes effect immediately.

## 3. Storefronts

Worth setting even though it is not required, because it changes answers rather
than just language.

```bash
APPLE_PODCASTS_STOREFRONT=se                    # your home market
APPLE_PODCASTS_STOREFRONTS=us,gb,se,de          # what the cross-market tools sweep
```

Apple runs a separate catalog, chart and review pool per country. A show can
rank in one and be absent from another, or not be published there at all. The
default is `us`, and the default sweep is the handful of markets that carry most
English-language podcast attention.

Each storefront in a sweep is one request against an API limited to roughly 20 a
minute, so a long list is slower and more likely to be throttled.
