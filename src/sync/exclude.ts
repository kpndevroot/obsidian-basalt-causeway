/**
 * Which vault paths never leave the machine.
 *
 * This is the single most safety-critical pure function in the plugin. `saveData()` writes
 * the GitHub token in plaintext to `<vault>/.obsidian/plugins/basalt-sync/data.json` — which
 * lives *inside the very vault this plugin pushes*. Without `.obsidian/**` excluded, the
 * first sync commits your token to GitHub. `plan.ts` applies this filter before anything
 * reaches the tree builder, and `assertNoSecrets` in `plan.ts` re-checks it at the boundary.
 *
 * Patterns are a deliberately small glob subset — enough for the defaults and for what a
 * user will actually type, and nothing more:
 *   - `*`  matches any run of characters except `/`
 *   - `**` matches any run of characters including `/`
 *   - `?`  matches one character except `/`
 *   - a pattern with no `/` is matched against the **basename** (`.DS_Store`, `*.tmp`)
 *   - a pattern with a `/` is matched against the full vault-relative path
 */

/**
 * Excluding Obsidian's own config is correct, not a limitation: Basalt renders markdown
 * through its own `markdown-it` pipeline and has no use for your desktop theme, hotkeys, or
 * workspace layout. `*.conflict-*` keeps M3's sidecars local — pushing one would land it on
 * the phone as a genuine note.
 */
export const DEFAULT_EXCLUDE = ['.obsidian/**', '.trash/**', '.git/**', '.DS_Store', '*.tmp', '*.conflict-*'];

/** Paths that may never be pushed, whatever the user's exclude list says. See `assertNoSecrets`. */
export const FORBIDDEN_PREFIXES = ['.obsidian/', '.git/'];

function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `foo/**` should also match `foo` itself, so the trailing slash is optional.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export type ExcludeMatcher = (path: string) => boolean;

/** Compile once per sync; the matcher is called for every file in the vault. */
export function compileExclude(patterns: string[]): ExcludeMatcher {
  const compiled = patterns
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0 && !raw.startsWith('#'))
    .map((raw) => ({ regex: globToRegExp(raw), basenameOnly: !raw.includes('/') }));

  return (path: string) => {
    const basename = path.slice(path.lastIndexOf('/') + 1);
    return compiled.some(({ regex, basenameOnly }) => regex.test(basenameOnly ? basename : path));
  };
}
