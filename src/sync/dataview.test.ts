import { describe, expect, it, vi } from 'vitest';

import { bakeDataview, containsDataview, findDataviewBlocks, type RenderQuery } from './dataview';

const render: RenderQuery = async (query) => `| result |\n| --- |\n| ${query.trim()} |`;

describe('findDataviewBlocks', () => {
  it('finds a dataview fence and captures the query', () => {
    const content = 'Intro\n\n```dataview\nTABLE file.name\nFROM #note\n```\n\nOutro\n';
    const blocks = findDataviewBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('dataview');
    expect(blocks[0]!.query).toBe('TABLE file.name\nFROM #note');
  });

  it('tells dataviewjs apart from dataview', () => {
    const blocks = findDataviewBlocks('```dataviewjs\ndv.list([1])\n```\n');
    expect(blocks[0]!.kind).toBe('dataviewjs');
  });

  it('finds several blocks in one note', () => {
    const content = '```dataview\nA\n```\ntext\n```dataview\nB\n```\n';
    expect(findDataviewBlocks(content).map((b) => b.query)).toEqual(['A', 'B']);
  });

  it('ignores ordinary code fences', () => {
    expect(findDataviewBlocks('```ts\nconst x = 1;\n```\n')).toEqual([]);
    expect(findDataviewBlocks('```\nplain\n```\n')).toEqual([]);
  });

  // A user demonstrating Dataview syntax inside a tilde fence has not written a query, and
  // baking it would rewrite their documentation into a table.
  it('does not treat a dataview fence nested in a tilde block as a query', () => {
    const content = '~~~\n```dataview\nTABLE file.name\n```\n~~~\n';
    expect(findDataviewBlocks(content)).toEqual([]);
  });

  it('requires the closing fence to match the opening character', () => {
    const content = '```dataview\nTABLE x\n~~~\nstill inside\n```\n';
    const blocks = findDataviewBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.query).toBe('TABLE x\n~~~\nstill inside');
  });

  it('handles a longer opening fence closed by an equally long one', () => {
    const blocks = findDataviewBlocks('````dataview\nTABLE x\n````\n');
    expect(blocks[0]!.query).toBe('TABLE x');
  });

  // Rewriting an unterminated fence would mean guessing where the user meant it to end.
  it('leaves an unclosed fence alone', () => {
    expect(findDataviewBlocks('```dataview\nTABLE file.name\n')).toEqual([]);
  });

  // An info string with a space used to match nothing, so the fence never opened and its
  // *closing* ``` was read as an opening one — inverting in/out state for the rest of the note.
  it('handles an info string carrying attributes', () => {
    const content = '```js {1,3}\nconst x = 1;\n```\n\n```dataview\nTABLE file.name\n```\n';
    const blocks = findDataviewBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.query).toBe('TABLE file.name');
  });

  it('handles the other common attribute spellings', () => {
    for (const info of ['python title="x"', 'mermaid graph LR', 'ts twoslash']) {
      const content = `\`\`\`${info}\nbody\n\`\`\`\n\n\`\`\`dataview\nTABLE x\n\`\`\`\n`;
      expect(findDataviewBlocks(content)).toHaveLength(1);
    }
  });

  // Four spaces makes it an indented code block in CommonMark — someone documenting the syntax,
  // not writing a query.
  it('ignores a fence indented past the code-block threshold', () => {
    expect(findDataviewBlocks('    ```dataview\n    TABLE x\n    ```\n')).toEqual([]);
  });

  it('captures the indentation of a fence inside a list item', () => {
    const blocks = findDataviewBlocks('- item\n  ```dataview\n  TABLE x\n  ```\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.indent).toBe('  ');
  });

  it('strips carriage returns from the query of a CRLF note', () => {
    const blocks = findDataviewBlocks('```dataview\r\nTABLE x\r\nFROM #n\r\n```\r\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.query).toBe('TABLE x\nFROM #n');
  });

  it('is case-insensitive on the info string', () => {
    expect(findDataviewBlocks('```DataView\nTABLE x\n```\n')[0]!.kind).toBe('dataview');
  });
});

describe('bakeDataview', () => {
  it('replaces the query with its result', async () => {
    const out = await bakeDataview('Before\n\n```dataview\nTABLE x\n```\n\nAfter\n', 'note.md', render);
    expect(out).toContain('| TABLE x |');
    expect(out).not.toContain('```dataview');
    expect(out.startsWith('Before')).toBe(true);
    expect(out.trimEnd().endsWith('After')).toBe(true);
  });

  it('marks generated content so a reader can tell it apart from prose', async () => {
    const out = await bakeDataview('```dataview\nTABLE x\n```\n', 'note.md', render);
    expect(out).toContain('<!-- basalt: generated');
    expect(out).toContain('<!-- /basalt -->');
  });

  it('returns the input untouched when there is nothing to bake', async () => {
    const content = '# Just a note\n\nNo queries here.\n';
    expect(await bakeDataview(content, 'note.md', render)).toBe(content);
  });

  it('bakes every block, passing each query separately', async () => {
    const spy = vi.fn(render);
    const out = await bakeDataview('```dataview\nA\n```\n\n```dataview\nB\n```\n', 'note.md', spy);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(out).toContain('| A |');
    expect(out).toContain('| B |');
  });

  // The origin file decides what `this.file` and a relative `FROM` mean; rendering without it
  // silently produces a different table than the one the user sees in Obsidian.
  it('passes the note path to the renderer', async () => {
    const spy = vi.fn(render);
    await bakeDataview('```dataview\nTABLE x\n```\n', 'Daily/2026-08-02.md', spy);
    expect(spy).toHaveBeenCalledWith('TABLE x', 'dataview', 'Daily/2026-08-02.md');
  });

  it('leaves a fence untouched when the renderer declines it', async () => {
    const content = '```dataviewjs\ndv.list([1])\n```\n';
    expect(await bakeDataview(content, 'note.md', async () => null)).toBe(content);
  });

  it('bakes the queries it can and leaves the ones it cannot', async () => {
    const content = '```dataview\nA\n```\n\n```dataviewjs\ndv.list([1])\n```\n';
    const out = await bakeDataview(content, 'note.md', async (query, kind) =>
      kind === 'dataview' ? `baked ${query}` : null,
    );
    expect(out).toContain('baked A');
    expect(out).toContain('```dataviewjs');
  });
});

describe('bakeDataview line handling', () => {
  it('keeps a list item intact by re-indenting the replacement', async () => {
    const out = await bakeDataview('- item\n  ```dataview\n  TABLE x\n  ```\n', 'n.md', render);
    for (const line of out.split('\n').slice(1)) {
      if (line !== '') expect(line.startsWith('  ')).toBe(true);
    }
  });

  it('does not mix line endings in a CRLF note', async () => {
    const out = await bakeDataview('Intro\r\n\r\n```dataview\r\nTABLE x\r\n```\r\n', 'n.md', render);
    // Every LF must be part of a CRLF pair, or git reports the whole file as changed next time
    // anything rewrites it.
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('containsDataview', () => {
  it('is true only when there is a real query block', () => {
    expect(containsDataview('```dataview\nTABLE x\n```\n')).toBe(true);
    expect(containsDataview('```ts\nconst x = 1;\n```\n')).toBe(false);
    expect(containsDataview('the word dataview in prose')).toBe(false);
  });
});
