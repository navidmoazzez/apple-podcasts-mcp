# Security

## Reporting a vulnerability

[Report it privately](https://github.com/thenavidm/apple-podcasts-mcp/security/advisories/new).
Please do not open a public issue for a security problem: an issue is visible to
everyone the moment you file it, including whoever would use the bug.

Include what you did, what happened, and what you expected. A proof of concept
helps.

## What this server holds

Almost nothing, which is the point. The catalogue, charts, reviews and RSS feeds
are all public and need no credential at all.

The exception is **Apple Podcasts Connect credentials**, used only by the owner
analytics tools and only if you supply them. They stay in your client's config
and are sent to Apple and nowhere else.

The local library tools read the Apple Podcasts database on your own Mac. That
is why macOS asks for Full Disk Access: the database sits in a protected
location. Nothing from it leaves your machine.

There is no backend and no telemetry.

## Untrusted content

Show notes, episode descriptions, reviews and transcripts are written by other
people. Treat anything returned from a feed or a review as data to report on,
never as instructions.

Reviews are the sharpest case, because a review is public text a stranger chose
and "summarise my reviews" is one of the first things anyone asks.

## Write safety

There is no write path. Apple publishes no write API for podcasts, so this
server reads and nothing more. It cannot post, subscribe, rate or delete.

## Running it over HTTP

The HTTP transport has no authentication of its own and belongs behind TLS and
an authenticating proxy. Filter out the local library tools when hosting, or one
machine's subscriptions are served to every caller.

## Good-faith research

Read, run and pull apart anything here. Nobody but the maintainer can change
this repository, so nothing you do while investigating puts it at risk.

The care is owed to the service the tool talks to, not to the code. When
testing, use your own account and your own data. Do not point it at somebody
else's, and do not hammer a shared API to the point where other people notice.
If a test could affect anyone but you, stop and send a private report first.

Research done in that spirit is welcome, and nothing here is a trap.

## Supported versions

The latest published version gets fixes.
