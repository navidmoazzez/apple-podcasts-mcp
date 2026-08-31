# apple-podcasts-mcp

For agents working **on** this repo. Users want the README.

## What this is

An MCP server over Apple Podcasts. TypeScript, ESM, Node 20+, published as
`@thenavidm/apple-podcasts-mcp`.

## The one thing to understand first

**This is four sources, not one API**, and nearly every design decision follows
from that. Before changing anything, know which surface you are in:

| Surface | Module | Credential |
|---|---|---|
| Search API | `src/api/itunes.ts` | none |
| Charts | `src/api/charts.ts` | none |
| Reviews | `src/api/reviews.ts` | none |
| RSS feeds | `src/api/feed.ts`, `src/api/xml.ts` | none |
| Local library | `src/library/` | none, macOS only |
| Podcasts Connect | `src/api/reporter.ts` | vendor number and token |

Every tool declares its `surface` and its `risk`. `server.ts` uses `surface` to
filter the tool list, so a new library tool is hidden by
`APPLE_PODCASTS_LIBRARY=0` automatically. Do not add a tool without both.

## Layout

```
src/
  index.ts        entry: stdio, --http, doctor
  server.ts       tools, resources, prompts, instructions
  config.ts       settings, storefronts, credentials
  clients.ts      the four clients, assembled once
  safety.ts       risk levels, annotations, the untrusted-text fence
  doctor.ts       per-surface diagnosis
  api/            one module per upstream, plus errors.ts and http.ts
  library/        db.ts is the SQLite backend, library.ts is the queries
  format/         tagged output for a model
  tools/          one module per group, kit.ts is the registration plumbing
  transport/      stdio and streamable HTTP
```

## Facts that are easy to get wrong

Verified against the live services. Do not "fix" these back.

- **The Search API returns 200 for failures**, with an `errorMessage` field.
  Always run a response through `inBandError` before trusting its results.
- **Rate limit is ~20 requests/minute per IP**, signalled by 403 with an HTML
  body. No `Retry-After`. This is why `http.ts` queues rather than parallelises.
- **Charts cap at 100** and **there are no genre charts** (404). Do not add a
  `genreId` to a chart URL.
- **Reviews cap at 50 per page, 10 pages.** Page 11 returns non-JSON. The first
  entry on page 1 is a feed description, not a review; it is filtered by the
  absence of a rating, not by index.
- **Apple's TTML transcripts are 403 on every mzstatic host.** Do not add a tool
  that claims to fetch them. Only `<podcast:transcript>` from a feed is public.
- **Core Data dates are seconds since 2001-01-01**, offset 978307200.
- **Play columns are empty on a Mac.** Never infer listening history. The
  usability check in `library.stats()` is a share of the library, not a count,
  because a dozen stray rows out of 60k is noise.
- **Reporter is a form POST**, `jsonRequest=<url-encoded JSON>`, and the
  `queryInput` must be wrapped as `[p=Reporter.properties, <command>]` even
  though no properties file exists. Reports come back as gzipped TSV.

## Conventions

- Comments say **why**, never what. If a line needs explaining, explain the
  constraint that forced it.
- No em dashes, in code comments or docs.
- Tool descriptions are the interface. They are read by a model that cannot see
  the code, so platform constraints belong in them, not only in the README.
- Errors are returned as results with `isError`, never thrown past `kit.ts`. A
  thrown MCP error reaches the model with no structure, which throws away every
  carefully written message in `api/errors.ts`.
- Output keys are `snake_case`, matching the tagged format.
- Any text a third party wrote goes through `fence()` in `safety.ts` before it
  reaches a model.

## Testing

`npm test`. Faked transport only: never the network, never a credential, never
the real library. `tests/parsing.test.ts` covers the parsers, where being wrong
is silent. `tests/server.test.ts` covers registration, gating and the HTTP layer.

Adding a tool means updating the count in `package.json`'s description, the
README, and the CI smoke test.

## Before pushing

```bash
npm run typecheck && npm run build && npm test && node dist/index.js doctor
```

Never put Claude in a commit message. Never name another project in this repo.
