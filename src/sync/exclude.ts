/**
 * Which vault paths never leave the machine.
 *
 * This is the single most safety-critical pure function in the plugin. `saveData()` writes
 * the GitHub token in plaintext to `<vault>/<configDir>/plugins/basalt-causeway/data.json` —
 * which lives *inside the very vault this plugin pushes*. Without that folder excluded, the
 * first sync commits your token to GitHub. `plan.ts` applies this filter before anything
 * reaches the tree builder, and `assertNoSecrets` in `plan.ts` re-checks it at the boundary.
 *
 * `configDir` is threaded in from `Vault#configDir` everywhere rather than assumed to be
 * `.obsidian`; the folder is user-renameable, and every guard here keys off it.
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
 *
 * Takes `configDir` rather than hardcoding `.obsidian`, because that folder is renameable and
 * a good number of people do rename it. See `forbiddenFolders` for why that is a security
 * property here and not a cosmetic one.
 *
 * The folder patterns lead with a double-star segment so they match at any depth. A pattern of
 * the bare `.obsidian` form is anchored at the vault root, which misses a *nested* vault — a
 * second config folder sitting in a subfolder of this one. The leading-double-star group compiles
 * to an optional prefix, so it still matches the root copy: one pattern covers both.
 */
export function defaultExclude(configDir: string): string[] {
  return [
    `**/${configDir}/**`,
    '**/.trash/**',
    '**/.git/**',
    '.DS_Store',
    '*.tmp',
    '*.conflict-*',
  ];
}

/**
 * Folder names that may never cross in **either** direction, whatever the user's exclude list
 * says — matched as a whole path *segment*, at any depth.
 *
 * `configDir` is `Vault#configDir`, not the literal `.obsidian`. A vault opened with a renamed
 * config folder — `--config-dir`, or the "Override config folder" setting — puts the plugin's
 * own `data.json`, and every other plugin's `main.js`, somewhere a hardcoded name would not have
 * matched: outbound the token in `data.json` becomes pushable, inbound a remote commit regains
 * the ability to write executable plugin code into the vault.
 */
export function forbiddenFolders(configDir: string): string[] {
  return [configDir, '.git'];
}

/** Path segments, with empty ones dropped so `a//b` and a trailing `/` cannot smuggle a match. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * The unconditional backstop, applied to pushes *and* pulls.
 *
 * Outbound it stops the token leaving. Inbound it is the more serious of the two: without it a
 * remote commit can write `.obsidian/plugins/<anything>/main.js` into the vault, and Obsidian
 * executes that file on next load. Anyone who can push to the repo — a collaborator, or whoever
 * holds a leaked token — would get code execution on the desktop. It can also overwrite this
 * plugin's own `data.json`.
 *
 * Deliberately independent of the user's exclude list, which is a free-text field they can empty.
 *
 * Matched **at any depth**, not as a root prefix. A `startsWith('.obsidian/')` test only ever
 * guarded the vault's own config folder, and a vault can contain another vault: a real leak
 * pushed `<subfolder>/.obsidian/plugins/basalt-causeway/data.json` — token and all — because
 * that path does not start with `.obsidian/`, so neither this check nor `assertNoSecrets`,
 * which asks the same question, refused it. Comparing whole segments closes that: any path with
 * a forbidden folder anywhere in it is out, in both directions.
 */
export function isForbiddenPath(vaultPath: string, configDir: string): boolean {
  const parts = segmentsOf(vaultPath);
  return forbiddenFolders(configDir).some((folder) => {
    // `configDir` is normally one segment, but it is user-supplied and may be a path — so match
    // it as a run of consecutive segments rather than assuming a single name.
    const needle = segmentsOf(folder);
    if (needle.length === 0) return false;
    return parts.some((_, start) => needle.every((segment, i) => parts[start + i] === segment));
  });
}

/** Trim stray slashes. Shared so every caller derives the same prefix from the same setting. */
export function normalizeSubfolder(subfolder: string): string {
  return subfolder.replace(/^\/+|\/+$/g, '');
}

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
