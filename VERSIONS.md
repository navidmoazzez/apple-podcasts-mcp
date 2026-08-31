# Apple Podcasts MCP Versions

| Component | Version | Last Updated |
|-----------|---------|--------------|
| apple-podcasts-mcp | 1.0.0 | 2026-08-31 |

---

## 1.0.0

First release. TypeScript, 32 tools, 77 tests.

### Apple Podcasts is four sources, not one API

The thing worth building around. The catalog, the charts and reviews, a show's
RSS feed, and Apple Podcasts Connect share a brand and nothing else. They differ
in who can reach them, what they are good for, and whether they need a
credential at all. Three of the four need nothing, which is why most of this
works the moment it is installed.

Covering all of them in one server is the point. "How is this show doing" is not
a catalog question or a chart question, it is both plus reviews plus publishing
cadence, and the answer only means something when they sit next to each other.
That is what `get_show_profile` and `compare_shows` do in one call, and doing it
by hand is a dozen requests and a lot of clerical joining.

### The local library holds a transcript corpus nothing reads

The Podcasts app keeps a Core Data store with every episode of every followed
show, whether or not anything was downloaded. On a normally-used library that is
tens of thousands of episodes with full descriptions, dates, durations and guids.

Nearly every one of them also carries `ZFREETRANSCRIPTSNIPPET`: a JSON array of
speaker-tagged lines Apple caches from its own transcription. A few hundred
characters each, present for around 99% of episodes. `search_library` searches
it, which makes "which episode was that in" answerable for the first time.

Two limits are load-bearing and are surfaced rather than smoothed over, because
a tool that implies otherwise produces confident wrong answers:

**Apple's full transcripts are not readable.** The database holds CDN paths to
TTML files and that CDN refuses unauthenticated requests. The excerpt is what
there is, and the tools never claim more.

**Play data does not reach the Mac.** On a library synced from a phone, the
playhead and play-count columns are zero on every row. Listening progress is
tracked on the device that played the episode. So nothing here reports listening
history, and `library_stats` says whether a given library is an exception rather
than presenting a zero as a finding. A handful of stray played rows in a library
of tens of thousands is noise, and the check is a share of the library rather
than a bare count for exactly that reason.

Its dates are Core Data timestamps, seconds since 2001. Read as Unix time,
every date in the library lands in 1970.

### Charts and reviews, which the ecosystem ignores

Apple publishes live ranking per storefront and it is free. Top Shows is
follower-weighted and slow; Trending Episodes moves fast and is the better read
on a topic. Both cap at 100, and a genre-scoped chart returns 404, so a genre
ranking can only ever be the overall chart filtered. Both facts are stated in
the output rather than left for a caller to infer from a thin result.

Apple has no endpoint for "where does this show rank", so `find_chart_position`
fetches each chart and looks the show up by id. Matching is by id rather than
name: titles collide and pick up suffixes between the catalog and the chart, and
a name match reports the wrong show as ranked.

The reviews feed is an old iTunes RSS endpoint wearing a JSON coat. It caps at
50 per page and 10 pages, and page 11 returns something that is not JSON at all,
so paging stops on a short page rather than trusting a count. Apple also
prepends a feed-description object to page 1 with the show's own blurb where a
review's title goes; it is dropped by shape rather than by index, because it is
absent on later pages. Left in, every summary opens with a fake five-star review.

### Apple's API answers 200 for failures

A malformed Search API query returns HTTP 200 with an `errorMessage` field and
zero results. Handled by status alone that is indistinguishable from a search
that matched nothing, and a model told a search found nothing concludes the show
does not exist. Every response body is inspected on success, not only on failure.

Rate limiting is the other silent one: roughly 20 requests a minute per IP,
answered with 403 and an HTML body, with no `Retry-After` and no quota endpoint.
Requests are queued behind a minimum interval rather than fired in parallel, and
responses are cached briefly, so comparing six shows fetches the chart once.

### Two dependencies

The MCP SDK and zod. RSS parsing and SQLite reading are both built in.

A general XML library is a large answer to a narrow question, and every
transitive package is paid for on every `npx` cold start, so the reader here
handles the parts podcast RSS actually uses: CDATA, entities, namespace
prefixes, self-closing tags, and a `>` inside a quoted attribute. It never throws
on malformed input, because half a parsed feed beats an exception.

SQLite is read through Node's built-in `node:sqlite` where available, with the
`sqlite3` command that ships with macOS as the fallback for Node 20 and 21. That
avoids a native module, which would turn a download into a build. Both open the
database read-only through an immutable URI, which is also what makes reads work
while the Podcasts app holds the file open.

### Almost nothing writes

There is no Apple Podcasts write API and this server does not invent one. 31 of
32 tools only read, so the confirmation machinery that earns its place on a
publishing server would be theatre here. `export_subscriptions` is guarded
because it writes a file and would overwrite one.

The control that matters is privacy instead: `APPLE_PODCASTS_LIBRARY=0` removes
the seven library tools from the list entirely. The HTTP transport refuses to
start bound to anything but loopback while the library is enabled, because a
hosted instance would otherwise serve one person's subscriptions and cached
transcripts to every caller.
