/**
 * A small XML reader, enough for podcast RSS and nothing more.
 *
 * Written rather than pulled in, for one reason worth stating: this server has
 * two dependencies, the MCP SDK and zod, and a reader installing it through
 * `npx` pays for every transitive package on every cold start. A general XML
 * library is a large answer to a narrow question. Podcast RSS is a shallow,
 * well-behaved dialect, and the parts of XML it actually uses fit here.
 *
 * What it handles, because feeds in the wild contain all of it:
 *
 *   CDATA            show notes are almost always wrapped in it, and they
 *                    contain raw HTML that would otherwise break parsing
 *   entities         named and numeric, including hex
 *   namespaces       itunes:, podcast:, content:, atom:, kept as written so a
 *                    caller can ask for the prefixed name it expects
 *   self-closing     <itunes:image href="..." />
 *   comments         skipped
 *   doctype and PIs  skipped
 *
 * What it deliberately does not handle: DTD entity definitions, namespace
 * resolution to URIs, mixed-content ordering, and schema validation. No podcast
 * feed needs them, and supporting them is where an XML parser stops being small.
 *
 * The parser never throws on malformed input. A feed with an unclosed tag is
 * common, and half a parsed feed is more useful than an exception, so recovery
 * is preferred to strictness everywhere.
 */

export type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated text directly inside this element, entities already decoded. */
  text: string;
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the entities that actually turn up in feeds. */
export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Parse a document and return its root element.
 *
 * Returns undefined when there is no element at all, which is what an HTML
 * error page served under an XML content type looks like.
 */
export function parseXml(source: string): XmlNode | undefined {
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let i = 0;

  // A byte order mark ahead of the declaration is common and breaks a naive
  // check for a leading "<".
  if (source.charCodeAt(0) === 0xfeff) i = 1;

  while (i < source.length) {
    const lt = source.indexOf("<", i);

    if (lt === -1) {
      appendText(stack, source.slice(i));
      break;
    }

    if (lt > i) appendText(stack, source.slice(i, lt));

    // <![CDATA[ ... ]]>
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      const value = end === -1 ? source.slice(lt + 9) : source.slice(lt + 9, end);
      // CDATA is literal by definition: no entity decoding.
      if (stack.length) stack[stack.length - 1]!.text += value;
      i = end === -1 ? source.length : end + 3;
      continue;
    }

    // Comments, doctype, processing instructions: skipped whole.
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!", lt) || source.startsWith("<?", lt)) {
      const end = source.indexOf(">", lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const gt = findTagEnd(source, lt);
    if (gt === -1) {
      // Unterminated tag at the end of a truncated download. Stop, keep what
      // was parsed.
      break;
    }

    const raw = source.slice(lt + 1, gt);
    i = gt + 1;

    // Closing tag.
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      // Unwind to the matching open tag rather than assuming the top of the
      // stack matches. Feeds with a stray close tag are common, and popping
      // blindly reparents everything after it.
      for (let depth = stack.length - 1; depth >= 0; depth--) {
        if (stack[depth]!.name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const inner = selfClosing ? raw.slice(0, -1) : raw;
    const node = parseTag(inner);
    if (!node) continue;

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (!root) root = node;

    if (!selfClosing) stack.push(node);
  }

  return root ?? undefined;
}

/**
 * Find the `>` that closes a tag, ignoring any inside a quoted attribute.
 *
 * A show notes URL in an attribute regularly contains a `>` after an HTML entity
 * pass, and scanning for the next `>` truncates the tag mid-attribute.
 */
function findTagEnd(source: string, from: number): number {
  let quote: string | undefined;
  for (let i = from + 1; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

function parseTag(raw: string): XmlNode | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const nameMatch = trimmed.match(/^([^\s/>]+)/);
  if (!nameMatch?.[1]) return undefined;

  const name = nameMatch[1];
  const attrs: Record<string, string> = {};

  const attrPattern = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  const rest = trimmed.slice(name.length);
  while ((match = attrPattern.exec(rest)) !== null) {
    const key = match[1]!;
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    attrs[key] = decodeEntities(value);
  }

  return { name, attrs, children: [], text: "" };
}

function appendText(stack: XmlNode[], chunk: string): void {
  if (!stack.length) return;
  if (!chunk.trim()) return;
  stack[stack.length - 1]!.text += decodeEntities(chunk);
}

/**
 * First direct child with any of these names.
 *
 * Several names because feeds disagree on which namespace a field lives in.
 * A duration is `itunes:duration` almost always and bare `duration` sometimes,
 * and a caller should not have to know which this particular feed chose.
 */
export function child(node: XmlNode | undefined, ...names: string[]): XmlNode | undefined {
  if (!node) return undefined;
  for (const name of names) {
    const found = node.children.find((c) => c.name === name);
    if (found) return found;
  }
  return undefined;
}

/** Every direct child with this name. */
export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  if (!node) return [];
  return node.children.filter((c) => c.name === name);
}

/** Trimmed text of the first matching child, or undefined when empty. */
export function childText(node: XmlNode | undefined, ...names: string[]): string | undefined {
  const found = child(node, ...names);
  const text = found?.text.trim();
  return text ? text : undefined;
}

/** An attribute from the first matching child. */
export function childAttr(
  node: XmlNode | undefined,
  name: string,
  attr: string,
): string | undefined {
  const found = child(node, name);
  const value = found?.attrs[attr]?.trim();
  return value ? value : undefined;
}
