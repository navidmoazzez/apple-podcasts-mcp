/**
 * Shared plumbing every tool uses.
 *
 * Registering thirty-one tools by hand is thirty-one chances to forget an
 * annotation, leak a stack trace, or return a shape a model cannot read. This
 * wraps all of it once, so a tool module only describes what it actually does.
 *
 * The one piece of real logic here is how a tool declares which of the four
 * sources it needs. That declaration does two jobs: `server.ts` uses it to keep
 * the library tools out of the list when the library is switched off, and the
 * error path uses it to say "this needs a credential you have not set" rather
 * than surfacing a failure from three layers down.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { AppleError } from "../api/errors.js";
import type { Config } from "../config.js";
import { annotationsFor, type Risk, type Surface, type WriteGuard } from "../safety.js";
import type { Clients } from "../clients.js";

export type ToolContext = {
  clients: Clients;
  config: Config;
  guard: WriteGuard;
  /** Resolve the storefront a call acts in, defaulting from config. */
  storefront: (hint?: string) => string;
};

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * A tool returns either pre-rendered text or a value to serialise.
 *
 * The reading tools return the tagged format from `format/podcasts.ts`, which
 * is already text. The summarising tools return a small object, where JSON is
 * clearer than tags. Both go through here so neither has to think about the
 * MCP content envelope.
 */
export function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

/**
 * Errors come back as a normal result with `isError`, not a thrown exception.
 *
 * A thrown MCP error reaches the model as a protocol failure with no structure.
 * A result it can read tells it what went wrong and usually how to fix it,
 * which is the difference between a correct retry and a give-up. Every message
 * in `api/errors.ts` is written on that assumption, and throwing here would
 * throw all of them away.
 */
export function fail(error: unknown): ToolResult {
  const payload =
    error instanceof AppleError
      ? error.toJSON()
      : { error: (error as Error)?.message ?? String(error) };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

/** The optional storefront argument, on every tool that reads Apple's catalog. */
export const storefrontArg = {
  storefront: z
    .string()
    .optional()
    .describe(
      "Two-letter country code for the Apple storefront to read, such as us, gb, se or de. Apple's catalog, charts and reviews are all per country and they differ, so this changes the answer rather than just the language. Defaults to APPLE_PODCASTS_STOREFRONT, which is us unless configured otherwise.",
    ),
};

/** The confirmation argument on the one tool that writes a file. */
export const confirmArg = {
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Must be true for this to run. It writes a file and will overwrite whatever is already at that path.",
    ),
};

export const limitArg = (max: number, note: string) => ({
  limit: z.number().int().min(1).max(max).optional().describe(`How many to return, 1-${max}. ${note}`),
});

/** Anything a tool takes that names a show, in the shapes people actually have. */
export const showArg = {
  show: z
    .string()
    .describe(
      "The show, as an Apple Podcasts numeric id (1469759170), or a full Apple Podcasts URL, which is what someone pasting a link will have. A URL carrying a storefront in its path sets the storefront for the call unless one is passed explicitly.",
    ),
};

export type ToolSpec<S extends ZodRawShape> = {
  name: string;
  /** One line, imperative. Shown in tool pickers. */
  title: string;
  description: string;
  schema: S;
  risk: Risk;
  surface: Surface;
  /** True when calling twice has the same effect as calling once. */
  idempotent?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
  /** One line for the audit log and the confirm message, when this writes. */
  summary?: (args: z.infer<z.ZodObject<S>>) => string;
};

export function defineTool<S extends ZodRawShape>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

/**
 * A tool of any shape, for the one place tools are collected into a list.
 *
 * `ToolSpec` is generic over its schema, so a list of tools with different
 * schemas has no single type: each handler takes a different argument shape and
 * function parameters are contravariant. The type safety that matters lives
 * inside each `defineTool` call, where schema and handler are checked against
 * each other. This only loosens the seam where they are gathered.
 */
export type AnyToolSpec = Omit<ToolSpec<ZodRawShape>, "handler" | "summary"> & {
  handler: (args: never, ctx: ToolContext) => Promise<unknown>;
  summary?: (args: never) => string;
};

/** Register one tool against the server, with guarding and error handling. */
export function register(
  server: McpServer,
  contextFor: (extra: unknown) => ToolContext,
  spec: AnyToolSpec,
): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.schema,
      annotations: {
        title: spec.title,
        ...annotationsFor(spec.risk, spec.surface, { idempotent: spec.idempotent }),
      },
    },
    // The SDK derives its callback type from the schema generic. This wrapper is
    // generic over the same shape, but TypeScript cannot prove the two equal
    // through the indirection, so the cast lives at this single boundary rather
    // than in every tool definition.
    (async (args: Record<string, unknown>, extra: unknown) => {
      try {
        const ctx = contextFor(extra);
        if (spec.risk !== "read") {
          const summary = spec.summary?.(args as never) ?? spec.name;
          const confirm = (args as { confirm?: boolean }).confirm;
          ctx.guard.check(spec.name, spec.risk, confirm, summary);
        }
        return ok(await spec.handler(args as never, ctx));
      } catch (error) {
        return fail(error);
      }
    }) as never,
  );
}

/** Clamp a caller-supplied limit into a range the upstream will accept. */
export function clamp(value: number | undefined, fallback: number, max = 100): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/** Trim a summary to one readable line for the audit log. */
export function snippet(text: string | undefined, length = 60): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}
