import { describe, expect, it, vi } from 'vitest';

import {
  discoverWith,
  findGhBinary,
  parseGhHosts,
  resolveTokenWith,
  type CliDeps,
  type DiscoveryDeps,
} from './ghAccounts';

/**
 * The shape a current `gh` actually writes: logins listed, **no tokens** — those live in the
 * OS keychain. An earlier version of this parser assumed tokens were inline and silently found
 * nothing on a real machine, which is why this fixture leads.
 */
const MODERN = `github.com:
    git_protocol: https
    users:
        kpndevrootentri:
        kpndevroot:
    user: kpndevroot
`;

describe('parseGhHosts', () => {
  it('finds every signed-in login when the file holds no tokens', () => {
    expect(parseGhHosts(MODERN)).toEqual([
      { host: 'github.com', login: 'kpndevrootentri', token: null },
      { host: 'github.com', login: 'kpndevroot', token: null },
    ]);
  });

  it('does not list the active user twice', () => {
    // `user:` names which account is active; the users map already listed it.
    expect(parseGhHosts(MODERN).filter((a) => a.login === 'kpndevroot')).toHaveLength(1);
  });

  it('still reads the legacy inline token form', () => {
    const legacy = `github.com:
    user: kpndevroot
    oauth_token: gho_cccccccccccccccccccc
    git_protocol: ssh
`;
    expect(parseGhHosts(legacy)).toEqual([
      { host: 'github.com', login: 'kpndevroot', token: 'gho_cccccccccccccccccccc' },
    ]);
  });

  it('reads an inline token nested under a user', () => {
    const nested = `github.com:
    users:
        kpndevroot:
            oauth_token: gho_aaaaaaaaaaaaaaaaaaaa
`;
    expect(parseGhHosts(nested)).toEqual([
      { host: 'github.com', login: 'kpndevroot', token: 'gho_aaaaaaaaaaaaaaaaaaaa' },
    ]);
  });

  it('keeps enterprise hosts apart from github.com', () => {
    const enterprise = `github.com:
    users:
        personal:
git.example.com:
    users:
        work:
`;
    expect(parseGhHosts(enterprise)).toEqual([
      { host: 'github.com', login: 'personal', token: null },
      { host: 'git.example.com', login: 'work', token: null },
    ]);
  });

  it('strips quoting from an inline token', () => {
    const quoted = `github.com:
    user: kpndevroot
    oauth_token: "gho_ffffffffffffffffffff"
`;
    expect(parseGhHosts(quoted)[0]!.token).toBe('gho_ffffffffffffffffffff');
  });

  it('ignores comments and blank lines', () => {
    const commented = `# written by gh

github.com:
    users:
        kpndevroot:
`;
    expect(parseGhHosts(commented)).toHaveLength(1);
  });

  it('yields no accounts for content it does not understand', () => {
    expect(parseGhHosts('')).toEqual([]);
    expect(parseGhHosts('not yaml at all')).toEqual([]);
    expect(parseGhHosts('{"json": true}')).toEqual([]);
  });
});

describe('discoverWith', () => {
  function deps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
    return {
      homedir: () => '/Users/someone',
      exists: () => true,
      readText: () => MODERN,
      join: (...parts) => parts.join('/'),
      ...overrides,
    };
  }

  it('reads the default config location', () => {
    let asked = '';
    const accounts = discoverWith(deps({ exists: (p) => ((asked = p), true) }));
    expect(asked).toBe('/Users/someone/.config/gh/hosts.yml');
    expect(accounts).toHaveLength(2);
  });

  it('honours GH_CONFIG_DIR, matching the CLI', () => {
    let asked = '';
    discoverWith(deps({ configDirOverride: '/custom/gh', exists: (p) => ((asked = p), true) }));
    expect(asked).toBe('/custom/gh/hosts.yml');
  });

  it('returns nothing when gh was never used here', () => {
    expect(discoverWith(deps({ exists: () => false }))).toEqual([]);
  });

  // A convenience feature must never be the reason the settings tab fails to open.
  it('swallows a read failure rather than propagating it', () => {
    expect(
      discoverWith(
        deps({
          readText: () => {
            throw new Error('EACCES');
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe('findGhBinary', () => {
  // An app launched from the Dock inherits a minimal PATH with no Homebrew in it, so the
  // binary has to be located by absolute path or the feature works only from a terminal.
  it('finds Homebrew on Apple silicon', () => {
    expect(findGhBinary({ exists: (p) => p === '/opt/homebrew/bin/gh' })).toBe('/opt/homebrew/bin/gh');
  });

  it('falls back to the Intel Homebrew location', () => {
    expect(findGhBinary({ exists: (p) => p === '/usr/local/bin/gh' })).toBe('/usr/local/bin/gh');
  });

  it('returns null when gh is not installed', () => {
    expect(findGhBinary({ exists: () => false })).toBeNull();
  });
});

describe('resolveTokenWith', () => {
  const account = { host: 'github.com', login: 'kpndevroot', token: null };

  function cli(overrides: Partial<CliDeps> = {}): CliDeps {
    return { exists: () => true, run: () => 'gho_resolved\n', ...overrides };
  }

  it('asks gh for the token of that specific account', () => {
    const run = vi.fn(() => 'gho_resolved\n');
    expect(resolveTokenWith(cli({ run }), account)).toBe('gho_resolved');
    expect(run).toHaveBeenCalledWith('/opt/homebrew/bin/gh', [
      'auth',
      'token',
      '--hostname',
      'github.com',
      '--user',
      'kpndevroot',
    ]);
  });

  it('does not shell out when the token was already inline', () => {
    const run = vi.fn(() => 'unused');
    const inline = { host: 'github.com', login: 'kpndevroot', token: 'gho_inline' };
    expect(resolveTokenWith(cli({ run }), inline)).toBe('gho_inline');
    expect(run).not.toHaveBeenCalled();
  });

  it('returns null when gh is not installed', () => {
    expect(resolveTokenWith(cli({ exists: () => false }), account)).toBeNull();
  });

  it('returns null when gh fails, so the UI can fall back to pasting', () => {
    expect(
      resolveTokenWith(
        cli({
          run: () => {
            throw new Error('not logged in');
          },
        }),
        account,
      ),
    ).toBeNull();
  });

  it('treats empty output as no token', () => {
    expect(resolveTokenWith(cli({ run: () => '  \n' }), account)).toBeNull();
  });
});
