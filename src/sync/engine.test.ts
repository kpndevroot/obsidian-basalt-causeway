import { beforeEach, describe, expect, it } from 'vitest';

import { ScopeError } from '../github/errors';
import { FakeGitHub } from '../test/fakeGitHub';
import { FakeVault } from '../test/fakeVault';
import { clearNotices, notices } from '../test/obsidian';
import { DEFAULT_SETTINGS, EMPTY_BASELINE, type Baseline, type BasaltSyncSettings } from '../types';
import { SyncEngine } from './engine';

function harness(
  vaultFiles: Record<string, string | Uint8Array> = {},
  repoFiles: Record<string, string | Uint8Array> = {},
  overrides: Partial<BasaltSyncSettings> = {},
) {
  const vault = new FakeVault(vaultFiles);
  const github = new FakeGitHub(repoFiles);
  const settings: BasaltSyncSettings = {
    ...DEFAULT_SETTINGS,
    owner: 'kpndevroot',
    repo: 'my-vault',
    branch: 'main',
    token: 'gh-token',
    ...overrides,
  };
  let baseline: Baseline = { commitSha: null, files: {}, conflicts: {} };

  const engine = new SyncEngine({
    vault: vault.asVault(),
    transport: github.transport(),
    settings: () => settings,
    baseline: () => baseline,
    saveBaseline: async (next) => {
      baseline = next;
    },
    onStatus: () => {},
  });

  return {
    vault,
    github,
    engine,
    settings,
    get baseline() {
      return baseline;
    },
    /** Wipe the baseline the way a lost data.json or a user-triggered reset does. */
    resetBaseline() {
      baseline = { commitSha: null, files: {}, conflicts: {} };
    },
  };
}

beforeEach(() => clearNotices());

describe('the first sync', () => {
  it('publishes the whole vault as a single commit', async () => {
    const h = harness({ 'a.md': 'alpha', 'notes/b.md': 'beta', 'notes/c.md': 'gamma' });

    const report = await h.engine.sync();

    expect(h.github.history()).toHaveLength(2); // the seed, plus exactly one of ours
    expect(h.github.files()).toEqual({ 'a.md': 'alpha', 'notes/b.md': 'beta', 'notes/c.md': 'gamma' });
    expect(report.plan.counts).toEqual({ added: 3, changed: 0, deleted: 0 });
  });

  it('carries the (via Obsidian) provenance marker in the commit message', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    expect(h.github.history()[0]!.message).toMatch(/^vault: 1 added \(via Obsidian\) \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  // The hazard the whole exclude design exists for: data.json holds the GitHub token in
  // plaintext and lives inside the vault being published.
  it('never publishes the plugin config holding the token', async () => {
    const h = harness({
      'a.md': 'alpha',
      '.obsidian/plugins/basalt-sync/data.json': '{"token":"github_pat_SECRET"}',
      '.obsidian/appearance.json': '{}',
      '.trash/old.md': 'deleted',
      '.DS_Store': 'junk',
    });

    await h.engine.sync();

    expect(Object.keys(h.github.files())).toEqual(['a.md']);
    expect(JSON.stringify(h.github.files())).not.toContain('github_pat_SECRET');
  });

  it('overwrites neither side when the repo already holds a different version', async () => {
    const h = harness({ 'a.md': 'mine' }, { 'a.md': 'theirs', 'README.md': 'repo readme' });

    const report = await h.engine.sync();

    // With no baseline there is no way to tell who moved, so this is a genuine conflict —
    // not a reason to pick a winner.
    expect(h.vault.contentOf('a.md')).toBe('mine');
    expect(h.github.files()['a.md']).toBe('theirs');
    expect(report.conflicts).toEqual(['a.md']);
  });

  // A first sync against a repo that already has files must not propose deleting them.
  it('leaves repo files the vault never had alone', async () => {
    const h = harness({ 'a.md': 'alpha' }, { 'README.md': 'repo readme', '.github/ci.yml': 'ci' });

    const report = await h.engine.sync();

    expect(report.plan.counts.deleted).toBe(0);
    expect(h.github.files()['README.md']).toBe('repo readme');
    expect(h.github.files()['.github/ci.yml']).toBe('ci');
  });
});

describe('push', () => {
  it('writes nothing on a second sync with no changes', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    const after = h.github.history().length;

    const report = await h.engine.sync();

    expect(h.github.history()).toHaveLength(after);
    expect(report.plan.ops).toEqual([]);
  });

  it('publishes an edit as one commit touching one file', async () => {
    const h = harness({ 'a.md': 'alpha', 'b.md': 'beta' });
    await h.engine.sync();

    h.vault.set('a.md', 'alpha edited');
    const report = await h.engine.sync();

    expect(report.plan.counts).toEqual({ added: 0, changed: 1, deleted: 0 });
    expect(h.github.files()).toEqual({ 'a.md': 'alpha edited', 'b.md': 'beta' });
    expect(h.github.history()).toHaveLength(3);
  });

  it('batches many edits into a single commit', async () => {
    const h = harness({ 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' });
    await h.engine.sync();

    h.vault.set('a.md', 'a2');
    h.vault.set('b.md', 'b2');
    h.vault.set('d.md', 'd');
    await h.engine.sync();

    // The economy of the Trees API: three changes, one new HEAD, so Basalt pulls once.
    expect(h.github.history()).toHaveLength(3);
    expect(h.github.countRequests('/git/commits', 'POST')).toBe(2);
  });

  it('propagates a deletion the baseline says we published', async () => {
    const h = harness({ 'a.md': 'alpha', 'b.md': 'beta' });
    await h.engine.sync();

    h.vault.remove('b.md');
    const report = await h.engine.sync();

    expect(report.plan.counts.deleted).toBe(1);
    expect(h.github.files()).toEqual({ 'a.md': 'alpha' });
  });

  it('lands a rename as a delete and a create in one commit', async () => {
    const h = harness({ 'old.md': 'content' });
    await h.engine.sync();
    const before = h.github.history().length;

    h.vault.remove('old.md');
    h.vault.set('new.md', 'content');
    const report = await h.engine.sync();

    expect(report.plan.counts).toEqual({ added: 1, changed: 0, deleted: 1 });
    expect(h.github.history()).toHaveLength(before + 1);
    expect(h.github.files()).toEqual({ 'new.md': 'content' });
  });

  it('uploads a binary as a blob and round-trips its bytes intact', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
    const h = harness({ 'attachments/img.png': png, 'a.md': 'alpha' });

    await h.engine.sync();

    // A binary has no inline form, so exactly one blob upload — and text got none.
    expect(h.github.countRequests('/git/blobs', 'POST')).toBe(1);
    expect(h.github.bytes('attachments/img.png')).toEqual(png);
  });

  it('skips an oversized file and says so, instead of failing the whole sync', async () => {
    const h = harness({ 'a.md': 'alpha', 'big.bin': 'x'.repeat(2000) }, {}, { maxFileBytes: 1000 });

    const report = await h.engine.sync();

    expect(report.plan.skipped.map((s) => s.path)).toEqual(['big.bin']);
    expect(Object.keys(h.github.files())).toEqual(['a.md']);
    expect(notices.some((n) => n.includes('big.bin'))).toBe(true);
  });

  it('publishes under the configured subfolder', async () => {
    const h = harness({ 'a.md': 'alpha' }, {}, { subfolder: 'vault' });

    await h.engine.sync();

    expect(Object.keys(h.github.files())).toEqual(['vault/a.md']);
  });

  it('surfaces a token that cannot write, without inventing a commit', async () => {
    const h = harness({ 'a.md': 'alpha' });
    h.github.failNext('/git/trees', 403, '{"message":"Resource not accessible by personal access token"}', 'POST');

    await expect(h.engine.sync()).rejects.toBeInstanceOf(ScopeError);
    expect(h.github.history()).toHaveLength(1);
  });
});

describe('pull', () => {
  it('applies a remote addition to the vault', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();

    h.github.commit({ 'from-phone.md': 'written in Basalt' });
    const report = await h.engine.sync();

    expect(h.vault.contentOf('from-phone.md')).toBe('written in Basalt');
    expect(report.pulled.written).toBe(1);
  });

  it('applies a remote edit to an untouched local file', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();

    h.github.commit({ 'a.md': 'edited on the phone' });
    await h.engine.sync();

    expect(h.vault.contentOf('a.md')).toBe('edited on the phone');
  });

  it('creates missing parent folders for an incoming nested note', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();

    h.github.commit({ 'deep/nested/note.md': 'incoming' });
    await h.engine.sync();

    expect(h.vault.contentOf('deep/nested/note.md')).toBe('incoming');
  });

  // `trash`, never `delete`: a deletion arriving from another device must stay recoverable.
  it('trashes a remotely deleted file rather than destroying it', async () => {
    const h = harness({ 'a.md': 'alpha', 'b.md': 'beta' });
    await h.engine.sync();

    h.github.commit({ 'b.md': null });
    const report = await h.engine.sync();

    expect(h.vault.has('b.md')).toBe(false);
    expect(h.vault.trashed).toEqual(['b.md']);
    expect(h.vault.hardDeleted).toEqual([]);
    expect(report.pulled.deleted).toBe(1);
  });

  it('does not re-push what it just pulled', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();

    h.github.commit({ 'from-phone.md': 'written in Basalt' });
    const report = await h.engine.sync();

    // The pull ran first, so the push planner sees the incoming note as already ours.
    expect(report.plan.ops).toEqual([]);
    expect(h.github.history()[0]!.message).toBe('external');
  });

  it('ignores remote paths outside the configured subfolder', async () => {
    const h = harness({ 'a.md': 'alpha' }, {}, { subfolder: 'vault' });
    await h.engine.sync();

    h.github.commit({ 'README.md': 'repo readme', 'vault/b.md': 'incoming' });
    await h.engine.sync();

    expect(h.vault.has('README.md')).toBe(false);
    expect(h.vault.contentOf('b.md')).toBe('incoming');
  });
});

describe('conflicts', () => {
  /** The parked remote copy. Found by shape so the test does not restate the naming rule. */
  function sidecarIn(vault: FakeVault): string {
    const found = vault.paths().filter((p) => p.includes('.conflict-'));
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  it('parks the remote version beside an untouched local file', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();

    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': 'their phone edit' });

    const report = await h.engine.sync();

    expect(h.vault.contentOf('a.md')).toBe('my desktop edit'); // never touched
    expect(h.vault.contentOf(sidecarIn(h.vault))).toBe('their phone edit');
    expect(report.conflicts).toEqual(['a.md']);
    expect(notices.some((n) => n.includes('conflict on a.md'))).toBe(true);
  });

  it('parks the sidecar only once, however many times you sync', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': 'their phone edit' });

    await h.engine.sync();
    await h.engine.sync();
    await h.engine.sync();

    expect(h.vault.paths().filter((p) => p.includes('.conflict-'))).toHaveLength(1);
  });

  it('does not push either side of a conflict', async () => {
    const h = harness({ 'a.md': 'alpha', 'b.md': 'beta' });
    await h.engine.sync();

    h.vault.set('a.md', 'my desktop edit');
    h.vault.set('b.md', 'b edited safely');
    h.github.commit({ 'a.md': 'their phone edit' });

    await h.engine.sync();

    // The unconflicted file still publishes; the conflicted one keeps the remote version.
    expect(h.github.files()['b.md']).toBe('b edited safely');
    expect(h.github.files()['a.md']).toBe('their phone edit');
  });

  it('keeps reporting a conflict until it is resolved', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': 'their phone edit' });
    await h.engine.sync();

    // The baseline is deliberately not advanced for a diverged path, so a second sync that
    // changes nothing must not quietly decide the conflict went away.
    const second = await h.engine.sync();

    expect(second.conflicts).toEqual(['a.md']);
    expect(h.vault.contentOf('a.md')).toBe('my desktop edit');
  });

  it('re-detects the disagreement after a baseline reset rather than picking a winner', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': 'their phone edit' });
    await h.engine.sync();

    h.resetBaseline();
    const report = await h.engine.sync();

    // Forgetting the baseline removes the *evidence* of who moved, not the disagreement
    // itself — so the two sides still differ and it is still a conflict. A reset is not a
    // back door around "never silently overwrite"; "Keep my version" is the way out.
    expect(report.conflicts).toEqual(['a.md']);
    expect(h.github.files()['a.md']).toBe('their phone edit');
    expect(h.vault.contentOf('a.md')).toBe('my desktop edit');
  });

  // Deleting the sidecar is the documented resolution gesture, and the only thing that
  // advances the baseline for a conflicted path.
  it('resolves once the user merges by hand and deletes the sidecar', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': 'their phone edit' });
    await h.engine.sync();

    h.vault.set('a.md', 'merged by hand');
    h.vault.remove(sidecarIn(h.vault));
    const report = await h.engine.sync();

    expect(report.conflicts).toEqual([]);
    expect(h.github.files()['a.md']).toBe('merged by hand');
  });

  it('writes nothing when the user resolves by taking the remote version wholesale', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': 'their phone edit' });
    await h.engine.sync();
    const before = h.github.history().length;

    h.vault.set('a.md', 'their phone edit');
    h.vault.remove(sidecarIn(h.vault));
    const report = await h.engine.sync();

    expect(report.conflicts).toEqual([]);
    expect(h.github.history()).toHaveLength(before);
  });

  it('keeps reporting the conflict while the sidecar is still sitting there', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': 'their phone edit' });
    await h.engine.sync();

    // Merged, but the sidecar is still present — the user has not signed off yet.
    h.vault.set('a.md', 'merged by hand');
    const report = await h.engine.sync();

    expect(report.conflicts).toEqual(['a.md']);
    expect(h.github.files()['a.md']).toBe('their phone edit');
  });

  it('re-parks against the newer remote version if the other side moves again', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': 'their first edit' });
    await h.engine.sync();

    h.github.commit({ 'a.md': 'their second edit' });
    await h.engine.sync();

    const sidecars = h.vault.paths().filter((p) => p.includes('.conflict-'));
    expect(sidecars).toHaveLength(2);
    expect(sidecars.map((p) => h.vault.contentOf(p)).sort()).toEqual(['their first edit', 'their second edit']);
  });

  it('keeps the local copy when a file we changed was deleted remotely', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();

    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': null });

    const report = await h.engine.sync();

    expect(h.vault.contentOf('a.md')).toBe('my desktop edit');
    expect(h.vault.trashed).toEqual([]);
    expect(report.conflicts).toEqual(['a.md']);
    expect(h.vault.paths().some((p) => p.includes('.conflict-'))).toBe(false);
  });

  // That shape parks no sidecar, so it has no delete-the-file gesture — the modal's explicit
  // action is its only way out.
  it('republishes a remotely deleted file after "Keep my version"', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': null });
    await h.engine.sync();

    await h.engine.keepLocalVersion('a.md');
    const report = await h.engine.sync();

    expect(report.conflicts).toEqual([]);
    expect(h.github.files()['a.md']).toBe('my desktop edit');
  });

  it('publishes the local version after "Keep my version" and clears the sidecar', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': 'their phone edit' });
    await h.engine.sync();

    await h.engine.keepLocalVersion('a.md');
    const report = await h.engine.sync();

    expect(report.conflicts).toEqual([]);
    expect(h.github.files()['a.md']).toBe('my desktop edit');
    expect(h.vault.paths().some((p) => p.includes('.conflict-'))).toBe(false);
  });

  it('remembers an unresolved conflict across a restart', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': 'their phone edit' });
    await h.engine.sync();

    // A conflict lives in data.json, not in engine memory, or a restart would forget it and
    // the next sync would happily overwrite one side.
    expect(Object.keys(h.baseline.conflicts)).toEqual(['a.md']);
  });

  it('never publishes a conflict sidecar as a real note', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.vault.set('a.md', 'my desktop edit');
    h.github.commit({ 'a.md': 'their phone edit' });

    await h.engine.sync();

    expect(Object.keys(h.github.files()).some((p) => p.includes('.conflict-'))).toBe(false);
  });
});

describe('resilience', () => {
  it('recomputes against the new HEAD when the branch moves mid-push, and never forces', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();

    h.vault.set('a.md', 'my edit');
    // Land a commit the moment our ref update is attempted: the first PATCH is a 409.
    h.github.failNext('/git/refs/heads/main', 409, '{"message":"Update is not a fast forward"}');
    h.github.commit({ 'unrelated.md': 'landed while we worked' });

    await h.engine.sync();

    expect(h.github.files()['a.md']).toBe('my edit');
    // The concurrent commit survived — a force push would have discarded it.
    expect(h.github.files()['unrelated.md']).toBe('landed while we worked');
  });

  it('gives up rather than looping forever against a branch that keeps moving', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.vault.set('a.md', 'my edit');

    for (let i = 0; i < 3; i += 1) {
      h.github.failNext('/git/refs/heads/main', 409, '{"message":"Update is not a fast forward"}');
    }

    await expect(h.engine.sync()).rejects.toThrow(/branch/i);
  });

  // The idempotency claim behind checking `mine` before `base`.
  it('makes no duplicate commit when the baseline is lost after a successful push', async () => {
    const h = harness({ 'a.md': 'alpha', 'b.md': 'beta' });
    await h.engine.sync();
    const after = h.github.history().length;

    h.resetBaseline(); // as if the write of data.json never landed

    const report = await h.engine.sync();

    expect(h.github.history()).toHaveLength(after);
    expect(report.plan.ops).toEqual([]);
  });

  it('re-establishes the baseline after a reset, so deletions work again', async () => {
    const h = harness({ 'a.md': 'alpha', 'b.md': 'beta' });
    await h.engine.sync();

    h.resetBaseline();
    await h.engine.sync(); // no ops, but must still record where we are
    expect(h.baseline.files['b.md']).toBeDefined();

    h.vault.remove('b.md');
    await h.engine.sync();

    expect(h.github.files()).toEqual({ 'a.md': 'alpha' });
  });

  it('refuses to run two syncs at once', async () => {
    const h = harness({ 'a.md': 'alpha' });
    const first = h.engine.sync();

    await expect(h.engine.sync()).rejects.toThrow(/already running/);
    await first;
  });

  it('refuses to sync before the repository is configured', async () => {
    const h = harness({ 'a.md': 'alpha' }, {}, { owner: '', repo: '' });
    await expect(h.engine.sync()).rejects.toThrow(/owner and repository/i);
  });

  it('refuses to sync without a token', async () => {
    const h = harness({ 'a.md': 'alpha' }, {}, { token: '' });
    await expect(h.engine.sync()).rejects.toThrow(/token/i);
  });
});

describe('dry run', () => {
  it('reports the full plan and writes absolutely nothing', async () => {
    const h = harness({ 'a.md': 'alpha', 'b.md': 'beta' });

    const report = await h.engine.sync({ dryRun: true });

    expect(report.plan.counts).toEqual({ added: 2, changed: 0, deleted: 0 });
    expect(h.github.history()).toHaveLength(1);
    expect(h.github.countRequests('/git/trees', 'POST')).toBe(0);
    expect(h.baseline.commitSha).toBeNull();
  });

  it('applies no remote changes to the vault either', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();
    h.github.commit({ 'from-phone.md': 'incoming' });

    await h.engine.sync({ dryRun: true });

    expect(h.vault.has('from-phone.md')).toBe(false);
  });
});

describe('pendingCount', () => {
  it('counts everything before the first sync and nothing after', async () => {
    const h = harness({ 'a.md': 'alpha', 'b.md': 'beta' });
    expect(await h.engine.pendingCount()).toBe(2);

    await h.engine.sync();

    expect(await h.engine.pendingCount()).toBe(0);
  });

  it('counts an edit and a deletion', async () => {
    const h = harness({ 'a.md': 'alpha', 'b.md': 'beta' });
    await h.engine.sync();

    h.vault.set('a.md', 'edited');
    h.vault.remove('b.md');

    expect(await h.engine.pendingCount()).toBe(2);
  });

  it('ignores excluded files, so the status bar never nags about the token file', async () => {
    const h = harness({ 'a.md': 'alpha' });
    await h.engine.sync();

    h.vault.set('.obsidian/plugins/basalt-sync/data.json', '{"token":"x"}');

    expect(await h.engine.pendingCount()).toBe(0);
  });
});
