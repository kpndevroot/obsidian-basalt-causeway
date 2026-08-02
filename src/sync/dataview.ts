/**
 * Publishing Dataview queries as their results.
 *
 * A `dataview` fence holds a *query*, not an answer. Dataview computes the answer at render
 * time from Obsidian's metadata cache, so the bytes on disk contain nothing to display — which
 * is exactly why such a note reaches the phone looking empty. Basalt renders markdown with
 * markdown-it and has no query engine, and it never will: the whole vault index it would need
 * is a different product.
 *
 * So the transformation happens on the way out. The vault keeps the live query; the repo gets
 * the rendered table. That has one consequence which shapes the rest of the design — the
 * published bytes are no longer the file's bytes — and `engine.ts` carries the invariants that
 * follow from it.
 *
 * Pure: fence scanning here, the actual query execution injected as `render`.
 */

export type DataviewKind = 'dataview' | 'dataviewjs';

export type DataviewBlock = {
  kind: DataviewKind;
  /** The query text, without the fence lines. */
  query: string;
  /** Leading whitespace of the opening fence, so a replacement can keep a list item intact. */
  indent: string;
  /** Offsets of the whole fence, opening and closing lines included. */
  start: number;
  end: number;
};

/**
 * The info string is captured as `(.*)` and the *language* taken as its first word.
 *
 * An earlier `([^\s`~]*)\s*$` required the info string to be a single bare word, so
 * ```` ```js {1,3} ````, ```` ```python title="x" ```` and ```` ```mermaid graph LR ```` matched
 * nothing at all. The fence then never opened, its closing ``` ``` ``` was read as an *opening*
 * fence, and the scanner's in/out state was inverted for the rest of the note — silently
 * publishing raw queries below it, or baking an example the author wrote as documentation.
 */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** CommonMark: four spaces of indent makes it an indented code block, not a fence. */
const MAX_FENCE_INDENT = 3;

/**
 * Every Dataview fence in the document.
 *
 * Fence tracking is a real scan rather than a regex over the whole text, because a ```` ``` ````
 * inside a `~~~` block is just text, and a fence only closes on its own character repeated at
 * least as many times. Getting that wrong would mean baking a query that a user had
 * deliberately shown as an example.
 */
export function findDataviewBlocks(content: string): DataviewBlock[] {
  const blocks: DataviewBlock[] = [];
  const lines = content.split('\n');

  let offset = 0;
  let open: {
    marker: string;
    kind: DataviewKind | null;
    indent: string;
    bodyStart: number;
    fenceStart: number;
  } | null = null;

  for (const line of lines) {
    const lineLength = line.length + 1; // The '\n' that `split` removed.
    // A CRLF document leaves '\r' at the end of every line. Left in place it reaches Dataview
    // inside the query text and shows up in the closing-fence match.
    const match = FENCE.exec(line.replace(/\r$/, ''));

    if (open) {
      // Closing needs the same character, at least as long, and nothing after it.
      if (
        match &&
        match[2]![0] === open.marker[0] &&
        match[2]!.length >= open.marker.length &&
        match[3]!.trim() === ''
      ) {
        if (open.kind) {
          blocks.push({
            kind: open.kind,
            query: content.slice(open.bodyStart, offset === 0 ? 0 : offset - 1).replace(/\r$/gm, ''),
            indent: open.indent,
            start: open.fenceStart,
            end: offset + lineLength,
          });
        }
        open = null;
      }
    } else if (match && match[1]!.length <= MAX_FENCE_INDENT) {
      const info = match[3]!.trim().split(/\s+/)[0]!.toLowerCase();
      const kind: DataviewKind | null = info === 'dataview' ? 'dataview' : info === 'dataviewjs' ? 'dataviewjs' : null;
      open = {
        marker: match[2]!,
        kind,
        indent: match[1]!,
        bodyStart: offset + lineLength,
        fenceStart: offset,
      };
    }

    offset += lineLength;
  }

  // An unclosed fence is left alone: it renders as a code block everywhere, and rewriting it
  // would mean guessing where the user meant it to end.
  return blocks;
}

export function containsDataview(content: string): boolean {
  return findDataviewBlocks(content).length > 0;
}

/**
 * Run one query. Returning `null` means "leave this fence exactly as it is" — used for
 * `dataviewjs`, which is arbitrary JavaScript rendering into a DOM node and has no static
 * markdown form, and for a query that fails to execute.
 */
export type RenderQuery = (query: string, kind: DataviewKind, path: string) => Promise<string | null>;

/**
 * The markers are HTML comments, which Basalt's markdown-it renders invisibly (`html: true`)
 * and GitHub hides too. They exist so a human reading the repo can tell generated content from
 * something they wrote — silently substituting one for the other would be the kind of thing you
 * discover much later and cannot explain.
 *
 * Deliberately `basalt:` and not the plugin's own name. This is a wire format: it is written
 * into commits that outlive any release, so a rename must not change it — every marker ever
 * published would otherwise stop being recognisable as generated. `basalt` is the part that
 * will not change.
 */
const OPEN_MARKER = '<!-- basalt: generated from a dataview query — edit the note in Obsidian -->';
const CLOSE_MARKER = '<!-- /basalt -->';

/** Replace each `dataview` fence with its rendered result. Never mutates the caller's string. */
export async function bakeDataview(content: string, path: string, render: RenderQuery): Promise<string> {
  const blocks = findDataviewBlocks(content);
  if (blocks.length === 0) return content;

  // Match the document rather than assuming '\n'. Splicing LF into a CRLF note leaves it with
  // mixed line endings, which shows up as a whole-file diff in git the next time anything
  // rewrites it.
  const eol = content.includes('\r\n') ? '\r\n' : '\n';

  let out = '';
  let cursor = 0;

  for (const block of blocks) {
    const rendered = await render(block.query, block.kind, path);
    out += content.slice(cursor, block.start);

    if (rendered === null) {
      out += content.slice(block.start, block.end);
    } else {
      // Re-apply the fence's own indentation to every emitted line. A query inside a list item
      // is indented, and an unindented replacement silently ends the list.
      const body = [OPEN_MARKER, ...rendered.trim().split(/\r?\n/), CLOSE_MARKER]
        .map((line) => (line === '' ? line : block.indent + line))
        .join(eol);
      out += body + eol;
    }
    cursor = block.end;
  }

  return out + content.slice(cursor);
}
