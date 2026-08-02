/**
 * GitHub accounts the `gh` CLI has already authenticated on this machine.
 *
 * This is the "don't make me mint a PAT just to try the plugin" path: `gh` has already done
 * the OAuth dance, so we can offer the result as a starting point.
 *
 * **Two steps, because tokens are not in the config file.** Modern `gh` records only *which*
 * accounts are signed in, in `hosts.yml`; the credentials themselves live in the OS keychain.
 * So discovery reads logins from the file, and the token for a chosen login is fetched on
 * demand with `gh auth token --user <login>`. Only older `gh` versions wrote `oauth_token:`
 * inline, and that form is still honoured when present.
 *
 * The consequence worth knowing: a token is only ever obtained for the account the user
 * explicitly picked, at the moment they pick it. Nothing scrapes credentials up front.
 *
 * **Desktop only** by nature — it reads `$HOME` and runs a binary through Node — but it does
 * not make the *plugin* desktop-only. Every entry point returns empty wherever those APIs are
 * absent, and callers treat "no accounts" as the ordinary case, so the manifest stays
 * `isDesktopOnly: false`.
 *
 * > A `gh` token is broadly scoped — typically `repo`, `gist`, `read:org` and `workflow`
 * > across every repository the user can reach — and adopting one copies it into `data.json`
 * > inside the vault. That is a real widening of blast radius next to a fine-grained token
 * > scoped to the single vault repo. The settings tab says so at the point of choice.
 */

export type LocalAccount = {
  host: string;
  login: string;
  /**
   * Present only for the legacy inline form. `null` means "ask the CLI for it when chosen" —
   * the normal case on a current `gh`.
   */
  token: string | null;
};

/**
 * Parse the subset of `hosts.yml` we need.
 *
 * Hand-rolled rather than taking a YAML dependency: the shape is tiny and fixed — a host, a
 * `users:` map of logins, and optionally an inline `oauth_token`. Anything unrecognised yields
 * no accounts, degrading to "paste a token by hand" rather than to a wrong account.
 */
export function parseGhHosts(yaml: string): LocalAccount[] {
  const accounts: LocalAccount[] = [];

  let host: string | null = null;
  let inUsers = false;
  let usersIndent = 0;
  let currentLogin: string | null = null;
  let hostUser: string | null = null;
  let hostToken: string | null = null;

  const remember = (login: string, token: string | null) => {
    if (!host) return;
    const existing = accounts.find((a) => a.host === host && a.login === login);
    if (existing) {
      if (token && !existing.token) existing.token = token;
      return;
    }
    accounts.push({ host, login, token });
  };

  /** The pre-`users:` layout, where the active login and its token sat under the host. */
  const flushHostLevel = () => {
    if (host && hostUser) remember(hostUser, hostToken);
    hostUser = null;
    hostToken = null;
  };

  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      flushHostLevel();
      host = trimmed.endsWith(':') ? trimmed.slice(0, -1) : null;
      inUsers = false;
      currentLogin = null;
      continue;
    }
    if (!host) continue;

    if (trimmed === 'users:') {
      inUsers = true;
      usersIndent = indent;
      currentLogin = null;
      continue;
    }

    // Dedented back out of the `users:` block.
    if (inUsers && indent <= usersIndent) {
      inUsers = false;
      currentLogin = null;
    }

    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, '');

    if (inUsers) {
      if (value === '') {
        // A login with nothing under it is the normal modern shape: signed in, token in the
        // keychain. It is an account, not an incomplete entry to skip.
        currentLogin = key;
        remember(key, null);
      } else if (key === 'oauth_token' && currentLogin) {
        remember(currentLogin, value);
      }
      continue;
    }

    if (key === 'user') hostUser = value;
    if (key === 'oauth_token') hostToken = value;
  }

  flushHostLevel();
  return accounts;
}

export type DiscoveryDeps = {
  homedir: () => string;
  configDirOverride?: string | undefined;
  exists: (path: string) => boolean;
  readText: (path: string) => string;
  join: (...parts: string[]) => string;
};

/** The pure half, so path precedence and failure behaviour are testable. */
export function discoverWith(deps: DiscoveryDeps): LocalAccount[] {
  try {
    // `GH_CONFIG_DIR` wins when set, matching the CLI's own precedence.
    const configDir = deps.configDirOverride || deps.join(deps.homedir(), '.config', 'gh');
    const hostsPath = deps.join(configDir, 'hosts.yml');
    if (!deps.exists(hostsPath)) return [];
    return parseGhHosts(deps.readText(hostsPath));
  } catch {
    return [];
  }
}

/**
 * Where to look for the `gh` binary.
 *
 * `PATH` alone is not enough. An app launched from Finder or the Dock inherits a minimal
 * environment — roughly `/usr/bin:/bin:/usr/sbin:/sbin` — which does not include Homebrew.
 * Obsidian is launched that way essentially always, so relying on `PATH` would make this
 * feature work from a terminal-launched Obsidian and mysteriously not otherwise.
 */
export const GH_SEARCH_PATHS = [
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/usr/bin/gh',
  '/home/linuxbrew/.linuxbrew/bin/gh',
];

export type CliDeps = {
  exists: (path: string) => boolean;
  /** Returns stdout, or throws if the command fails. */
  run: (binary: string, args: string[]) => string;
};

export function findGhBinary(deps: Pick<CliDeps, 'exists'>): string | null {
  return GH_SEARCH_PATHS.find((path) => deps.exists(path)) ?? null;
}

/**
 * Ask `gh` for the token of one account. Returns null if `gh` is absent, the account is not
 * signed in, or the keychain refuses — all of which mean "fall back to pasting a token".
 */
export function resolveTokenWith(deps: CliDeps, account: LocalAccount): string | null {
  if (account.token) return account.token; // Legacy inline form; no need to shell out.

  const binary = findGhBinary(deps);
  if (!binary) return null;

  try {
    const token = deps.run(binary, ['auth', 'token', '--hostname', account.host, '--user', account.login]).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Node's `require`, if we are in the Electron renderer.
 *
 * Fetched through the global rather than imported at the top of the file: a static
 * `import 'fs'` is evaluated on load, which would break the plugin outright on Obsidian
 * mobile — the platform this module is designed to be absent on.
 */
function nodeRequire(): ((id: string) => unknown) | null {
  const globalRequire = (globalThis as { require?: (id: string) => unknown }).require;
  return typeof globalRequire === 'function' ? globalRequire : null;
}

/**
 * Accounts `gh` has signed in on this machine. Returns `[]` on mobile, when `gh` was never
 * used, or if anything goes wrong — this is a convenience, and it must never become the reason
 * the settings tab fails to open.
 */
export function discoverLocalAccounts(): LocalAccount[] {
  const req = nodeRequire();
  if (!req) return [];

  try {
    const os = req('os') as { homedir: () => string };
    const path = req('path') as { join: (...parts: string[]) => string };
    const fs = req('fs') as {
      existsSync: (p: string) => boolean;
      readFileSync: (p: string, enc: string) => string;
    };
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

    return discoverWith({
      homedir: () => os.homedir(),
      configDirOverride: env?.GH_CONFIG_DIR,
      exists: (p) => fs.existsSync(p),
      readText: (p) => fs.readFileSync(p, 'utf8'),
      join: (...parts) => path.join(...parts),
    });
  } catch {
    return [];
  }
}

/** The token for one discovered account, fetched from the OS keychain via `gh`. */
export function resolveAccountToken(account: LocalAccount): string | null {
  if (account.token) return account.token;

  const req = nodeRequire();
  if (!req) return null;

  try {
    const fs = req('fs') as { existsSync: (p: string) => boolean };
    const child = req('child_process') as {
      execFileSync: (file: string, args: string[], options: { encoding: string; timeout: number }) => string;
    };

    return resolveTokenWith(
      {
        exists: (p) => fs.existsSync(p),
        // `execFileSync`, not `exec`: no shell, so a login from the config file can never be
        // interpreted as shell syntax. The timeout guards against a keychain prompt hanging
        // Obsidian's renderer, which is the thread this runs on.
        run: (binary, args) => child.execFileSync(binary, args, { encoding: 'utf8', timeout: 10_000 }),
      },
      account,
    );
  } catch {
    return null;
  }
}
