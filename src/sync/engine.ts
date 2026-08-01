/**
 * The orchestration layer: the only place that touches both the Vault and the network.
 *
 * A sync is always **pull, then push**. Pulling first means the push planner sees a local
 * tree that has already absorbed whatever the phone sent, so a note Basalt edited comes back
 * as `mine` (nothing to do) rather than being re-pushed as a change. The reverse order would
 * make every phone edit produce a redundant desktop commit.
 */

import { arrayBufferToBase64, base64ToArrayBuffer, Notice, type TFile, type Vault } from 'obsidian';

import { gitBlobSha } from '../github/blobSha';
import { call, type GitHubContext, type Transport } from '../github/client';
import { compareCommits, readBlob } from '../github/compare';
import { ConflictError, describeError } from '../github/errors';
import { createBlob, createCommit, createTree, readHead, readTree, updateRef, type TreeEntry } from '../github/trees';
import type { Baseline, BasaltSyncSettings } from '../types';
import { pushMessage } from './commitMessages';
import { compare, conflictSidecarPath } from './conflict';
import { compileExclude } from './exclude';
import { assertNoSecrets, buildPushPlan, type LocalFile, type PushPlan } from './plan';

/**
 * Extensions read and written as UTF-8 text; everything else round-trips as bytes.
 *
 * An allowlist rather than a "is it binary?" sniff, because guessing wrong in the text
 * direction is silently destructive: decoding a PNG as UTF-8 replaces every invalid byte
 * with U+FFFD and re-encodes a corrupted file. An unknown extension going through the binary
 * path costs one extra blob upload and loses nothing.
 */
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'ini',
  'html', 'htm', 'xml', 'svg', 'css', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'sh', 'bash', 'zsh', 'sql',
  'canvas', 'base', 'gitignore', 'env',
]);

function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot <= path.lastIndexOf('/')) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export type SyncPhase = 'idle' | 'syncing' | 'error';

export type SyncStatus = {
  phase: SyncPhase;
  /** Local changes waiting to go out — what the status bar shows as `↑3`. */
  pending: number;
  conflicts: string[];
  message: string;
};

export type SyncReport = {
  dryRun: boolean;
  plan: PushPlan;
  pulled: { written: number; deleted: number };
  conflicts: string[];
  commitSha: string | null;
};

export type EngineDeps = {
  vault: Vault;
  transport: Transport;
  settings: () => BasaltSyncSettings;
  baseline: () => Baseline;
  saveBaseline: (baseline: Baseline) => Promise<void>;
  onStatus: (status: SyncStatus) => void;
};

/** A file's identity as of the last time we hashed it, keyed by vault path. */
type HashEntry = { mtime: number; size: number; sha: string };

export class SyncEngine {
  private running = false;
  private conflicts: string[] = [];

  /**
   * In-memory only. With auto-sync on, `sync()` runs every few seconds of idle typing, and
   * re-hashing the entire vault each time is the difference between unnoticeable and a
   * visible stall on a large vault. Keyed on (mtime, size), so any real edit invalidates it;
   * a dropped cache costs one full rehash and can never produce a wrong answer.
   */
  private hashCache = new Map<string, HashEntry>();

  constructor(private readonly deps: EngineDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  private status(phase: SyncPhase, message: string, pending = 0): void {
    this.deps.onStatus({ phase, pending, conflicts: [...this.conflicts], message });
  }

  private context(): GitHubContext {
    const s = this.deps.settings();
    if (!s.owner || !s.repo) throw new Error('Set the GitHub owner and repository in Basalt Sync settings.');
    if (!s.token) throw new Error('Add a GitHub token in Basalt Sync settings.');
    if (!s.branch) throw new Error('Set the branch in Basalt Sync settings.');
    return { transport: this.deps.transport, owner: s.owner, repo: s.repo, token: s.token };
  }

  /** Vault path → repo path. The subfolder lets one repo hold the vault under a prefix. */
  private toRepoPath(vaultPath: string): string {
    const sub = this.deps.settings().subfolder.replace(/^\/+|\/+$/g, '');
    return sub ? `${sub}/${vaultPath}` : vaultPath;
  }

  /** Repo path → vault path, or null when the path lies outside our subfolder entirely. */
  private toVaultPath(repoPath: string): string | null {
    const sub = this.deps.settings().subfolder.replace(/^\/+|\/+$/g, '');
    if (!sub) return repoPath;
    if (!repoPath.startsWith(`${sub}/`)) return null;
    return repoPath.slice(sub.length + 1);
  }

  private async hash(file: TFile): Promise<string> {
    const cached = this.hashCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) return cached.sha;

    const sha = isTextPath(file.path)
      ? gitBlobSha(await this.deps.vault.cachedRead(file))
      : gitBlobSha(new Uint8Array(await this.deps.vault.readBinary(file)));

    this.hashCache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, sha });
    return sha;
  }

  /**
   * Every publishable file, hashed. `getFiles()` and not `getMarkdownFiles()` — attachments
   * are half of what makes a vault render correctly on the phone.
   */
  private async enumerate(): Promise<LocalFile[]> {
    const excluded = compileExclude(this.deps.settings().exclude);
    const files = this.deps.vault.getFiles().filter((file) => !excluded(file.path));

    const out: LocalFile[] = [];
    for (const file of files) {
      out.push({
        path: this.toRepoPath(file.path),
        sha: await this.hash(file),
        size: file.stat.size,
        binary: !isTextPath(file.path),
      });
    }
    return out;
  }

  /** How many local changes are waiting. Cheap enough to run on the debounce tick. */
  async pendingCount(): Promise<number> {
    const baseline = this.deps.baseline().files;
    const local = await this.enumerate();
    const seen = new Set<string>();
    let pending = 0;
    for (const file of local) {
      seen.add(file.path);
      if (baseline[file.path] !== file.sha) pending += 1;
    }
    for (const path of Object.keys(baseline)) if (!seen.has(path)) pending += 1;
    return pending;
  }

  async sync(options: { dryRun?: boolean } = {}): Promise<SyncReport> {
    // Two overlapping syncs would build two trees from the same HEAD and the loser's commit
    // would be silently dropped by the non-fast-forward guard. Serialise instead.
    if (this.running) throw new Error('A sync is already running.');
    this.running = true;
    this.conflicts = [];
    this.status('syncing', options.dryRun ? 'Dry run…' : 'Syncing…');

    try {
      if (options.dryRun !== true) await this.resolveClearedConflicts();
      this.conflicts = Object.keys(this.deps.baseline().conflicts)
        .map((repoPath) => this.toVaultPath(repoPath) ?? repoPath)
        .sort();

      const report = await this.run(options.dryRun === true);
      this.status(
        this.conflicts.length > 0 ? 'error' : 'idle',
        this.conflicts.length > 0 ? `${this.conflicts.length} conflict(s)` : 'Up to date',
      );
      return report;
    } catch (err) {
      this.status('error', describeError(err));
      throw err;
    } finally {
      this.running = false;
    }
  }

  private async run(dryRun: boolean): Promise<SyncReport> {
    const ctx = this.context();
    const settings = this.deps.settings();
    let head = await readHead(ctx, settings.branch);

    const pulled = dryRun ? { written: 0, deleted: 0 } : await this.pull(ctx, head.commitSha);
    if (!dryRun && pulled.written + pulled.deleted > 0) {
      // Applying remote changes rewrote local files; their mtimes moved, so the cache entries
      // for those paths are stale by construction. Re-read HEAD too — a pull that took a
      // while may have been overtaken.
      head = await readHead(ctx, settings.branch);
    }

    const { plan, commitSha } = await this.push(ctx, head.commitSha, dryRun);

    return { dryRun, plan, pulled, conflicts: [...this.conflicts], commitSha };
  }

  // ---- conflict resolution --------------------------------------------------

  /**
   * The user's resolution gesture: they deleted the sidecar.
   *
   * Its presence is the unresolved marker — so its absence, once we know we put it there,
   * means "I looked at both versions and dealt with it". Only then does the baseline advance
   * to the remote sha we conflicted against, which lets the ordinary three-way compare do the
   * rest: a hand-merged file now reads as `base` and publishes, and a file the user replaced
   * with the remote copy reads as `mine` and writes nothing.
   */
  private async resolveClearedConflicts(): Promise<void> {
    const baseline = this.deps.baseline();
    const entries = Object.entries(baseline.conflicts);
    if (entries.length === 0) return;

    const files = { ...baseline.files };
    const conflicts = { ...baseline.conflicts };
    let changed = false;

    for (const [repoPath, record] of entries) {
      if (record.sidecar === null) continue; // A remote deletion parks no file; see `keepLocalVersion`.
      if (this.deps.vault.getFileByPath(record.sidecar) !== null) continue;

      if (record.remoteSha === null) delete files[repoPath];
      else files[repoPath] = record.remoteSha;
      delete conflicts[repoPath];
      changed = true;
    }

    if (changed) await this.deps.saveBaseline({ ...baseline, files, conflicts });
  }

  /**
   * The explicit resolution, from the conflict modal: keep what is in the vault and let the
   * next sync publish it over the remote.
   *
   * This is the only route out of a remote-deleted-but-locally-edited conflict, which parks no
   * sidecar and so has no file for the user to delete.
   */
  async keepLocalVersion(vaultPath: string): Promise<void> {
    const repoPath = this.toRepoPath(vaultPath);
    const baseline = this.deps.baseline();
    const record = baseline.conflicts[repoPath];
    if (!record) return;

    if (record.sidecar !== null) {
      const sidecar = this.deps.vault.getFileByPath(record.sidecar);
      if (sidecar) await this.deps.vault.trash(sidecar, true);
    }

    const files = { ...baseline.files };
    if (record.remoteSha === null) delete files[repoPath];
    else files[repoPath] = record.remoteSha;

    const conflicts = { ...baseline.conflicts };
    delete conflicts[repoPath];

    this.conflicts = this.conflicts.filter((path) => path !== vaultPath);
    await this.deps.saveBaseline({ ...baseline, files, conflicts });
  }

  /**
   * Park the remote version of every newly diverged path beside the local file.
   *
   * Done here, off the push plan, rather than during the pull: the plan compares against the
   * full remote tree, so it sees divergences the `/compare` window misses — a path that
   * conflicted several syncs ago and has been stale ever since.
   */
  private async recordConflicts(ctx: GitHubContext, plan: PushPlan): Promise<void> {
    if (plan.conflicts.length === 0) return;

    const baseline = this.deps.baseline();
    const conflicts = { ...baseline.conflicts };
    let changed = false;

    for (const conflict of plan.conflicts) {
      const vaultPath = this.toVaultPath(conflict.path);
      if (vaultPath === null) continue;

      const existing = conflicts[conflict.path];
      // Already parked against this same remote version — leave the user's copy alone.
      if (existing && existing.remoteSha === conflict.remoteSha) continue;

      if (conflict.remoteSha === null) {
        conflicts[conflict.path] = { sidecar: null, remoteSha: null };
        new Notice(`Basalt Sync: ${vaultPath} was deleted remotely but changed here — kept your copy.`);
      } else {
        const sidecar = conflictSidecarPath(vaultPath, conflict.remoteSha);
        await this.write(sidecar, await readBlob(ctx, conflict.remoteSha));
        conflicts[conflict.path] = { sidecar, remoteSha: conflict.remoteSha };
        new Notice(`Basalt Sync: conflict on ${vaultPath} — remote copy saved as ${sidecar}`);
      }
      changed = true;
    }

    if (changed) await this.deps.saveBaseline({ ...this.deps.baseline(), conflicts });
  }

  // ---- pull -----------------------------------------------------------------

  /**
   * Apply everything that moved between our baseline commit and remote HEAD.
   *
   * Skipped entirely on the very first sync (no baseline commit): there is nothing to diff
   * against, and the alternative — treating the whole repo as incoming — would overwrite a
   * vault the user just pointed at an existing repo. The first sync publishes; the second
   * onwards is a real two-way loop.
   */
  private async pull(ctx: GitHubContext, headSha: string): Promise<{ written: number; deleted: number }> {
    const baseline = this.deps.baseline();
    if (!baseline.commitSha || baseline.commitSha === headSha) return { written: 0, deleted: 0 };

    const excluded = compileExclude(this.deps.settings().exclude);
    const { files } = await compareCommits(ctx, baseline.commitSha, headSha);

    const nextFiles = { ...baseline.files };
    let written = 0;
    let deleted = 0;

    // A rename arrives as one entry naming both paths. Expanding it into a removal plus an
    // addition lets the same two code paths handle it, with no rename-specific branch.
    type Incoming = { repoPath: string; sha: string | null };
    const incoming: Incoming[] = [];
    for (const file of files) {
      if (file.status === 'renamed' && file.previousPath) {
        incoming.push({ repoPath: file.previousPath, sha: null });
      }
      incoming.push({ repoPath: file.path, sha: file.sha });
    }

    for (const { repoPath, sha: remoteSha } of incoming) {
      const vaultPath = this.toVaultPath(repoPath);
      if (vaultPath === null || excluded(vaultPath)) continue;

      const local = this.deps.vault.getFileByPath(vaultPath);
      const localSha = local ? await this.hash(local) : null;
      const baseSha = baseline.files[repoPath] ?? null;

      // The vault is what we are about to overwrite, so the vault is the side checked against
      // the baseline — the mirror of the push call. Passing these the other way round makes
      // every incoming new file look diverged.
      switch (compare(localSha, remoteSha, baseSha)) {
        case 'mine':
          // Already applied — typically our own push coming back around.
          if (remoteSha === null) delete nextFiles[repoPath];
          else nextFiles[repoPath] = remoteSha;
          break;

        case 'base':
          if (remoteSha === null) {
            // `trash`, never `delete`: a remote deletion must stay recoverable locally.
            if (local) await this.deps.vault.trash(local, true);
            delete nextFiles[repoPath];
            this.hashCache.delete(vaultPath);
            deleted += 1;
          } else {
            await this.write(vaultPath, await readBlob(ctx, remoteSha));
            nextFiles[repoPath] = remoteSha;
            this.hashCache.delete(vaultPath);
            written += 1;
          }
          break;

        case 'diverged':
          // Write nothing, and deliberately do NOT advance the baseline entry: leaving it
          // stale is what keeps the path reading as diverged in the push plan, which is where
          // the sidecar gets parked and the conflict recorded. Doing it here as well would
          // park it twice, once per direction.
          break;
      }
    }

    await this.deps.saveBaseline({ ...this.deps.baseline(), commitSha: headSha, files: nextFiles });
    return { written, deleted };
  }

  /** Create-or-update a vault path from base64 bytes, making parent folders as needed. */
  private async write(vaultPath: string, base64: string): Promise<void> {
    const bytes = base64ToArrayBuffer(base64);
    const slash = vaultPath.lastIndexOf('/');
    if (slash > 0) {
      const folder = vaultPath.slice(0, slash);
      if (!this.deps.vault.getFolderByPath(folder)) await this.deps.vault.createFolder(folder);
    }

    const existing = this.deps.vault.getFileByPath(vaultPath);
    if (isTextPath(vaultPath)) {
      const text = new TextDecoder().decode(bytes);
      // `process` rather than `modify`: it guarantees the file did not change between our
      // read and our write, which is exactly the race you hit when a pull lands while the
      // user is typing in that note.
      if (existing) await this.deps.vault.process(existing, () => text);
      else await this.deps.vault.create(vaultPath, text);
      return;
    }

    if (existing) await this.deps.vault.modifyBinary(existing, bytes);
    else await this.deps.vault.createBinary(vaultPath, bytes);
  }

  // ---- push -----------------------------------------------------------------

  private async push(
    ctx: GitHubContext,
    headSha: string,
    dryRun: boolean,
  ): Promise<{ plan: PushPlan; commitSha: string | null }> {
    const settings = this.deps.settings();
    let currentHead = headSha;

    // Bounded, because the retry only helps against a *finite* number of concurrent pushers.
    // An unbounded loop against a busy branch is an infinite loop that also writes commits.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const commit = await readHeadTree(ctx, currentHead);
      const local = await this.enumerate();

      const plan = buildPushPlan({
        local,
        remote: commit.remote,
        baseline: this.deps.baseline().files,
        maxFileBytes: settings.maxFileBytes,
      });

      for (const conflict of plan.conflicts) {
        const vaultPath = this.toVaultPath(conflict.path) ?? conflict.path;
        if (!this.conflicts.includes(vaultPath)) this.conflicts.push(vaultPath);
      }
      if (!dryRun) await this.recordConflicts(ctx, plan);

      for (const skipped of plan.skipped) {
        new Notice(
          `Basalt Sync: skipped ${skipped.path} — ${(skipped.size / 1024 / 1024).toFixed(1)} MB exceeds the size limit.`,
        );
      }

      if (dryRun) return { plan, commitSha: null };

      if (plan.ops.length === 0) {
        // Nothing to write, but the baseline must still be recorded. A sync can legitimately
        // find the remote already holding our exact bytes — after a crash between the commit
        // and the baseline save, or after a baseline reset — and returning early without
        // writing one would leave every file looking permanently unpublished, so deletions
        // could never be planned again.
        await this.deps.saveBaseline({
          ...this.deps.baseline(),
          commitSha: currentHead,
          files: nextBaselineFiles(this.deps.baseline().files, local, plan),
        });
        return { plan, commitSha: null };
      }

      assertNoSecrets(
        plan.ops.map((op) => op.path),
        settings.subfolder,
      );

      const entries = await this.treeEntries(ctx, plan);
      const treeSha = await createTree(ctx, commit.treeSha, entries);
      const commitSha = await createCommit(ctx, pushMessage(plan.counts), treeSha, currentHead);

      try {
        await updateRef(ctx, settings.branch, commitSha);
      } catch (err) {
        if (err instanceof ConflictError && attempt < 2) {
          // Someone pushed between our tree read and our ref move. The commit we just made is
          // orphaned and harmless; recompute against the new HEAD. Never force.
          currentHead = (await readHead(ctx, settings.branch)).commitSha;
          continue;
        }
        throw err;
      }

      await this.deps.saveBaseline({
        ...this.deps.baseline(),
        commitSha,
        files: nextBaselineFiles(this.deps.baseline().files, local, plan),
      });
      return { plan, commitSha };
    }

    throw new ConflictError('The branch kept moving; gave up after 3 attempts.');
  }

  /**
   * `PushPlan` → Trees API entries.
   *
   * Text files ride inline, which is the whole economy of this design: N text edits cost one
   * `POST /git/trees`, not N blob uploads. Binaries have no inline form, so each changed one
   * costs a `POST /git/blobs` first.
   */
  private async treeEntries(ctx: GitHubContext, plan: PushPlan): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = [];

    for (const op of plan.ops) {
      if (op.op === 'delete') {
        // `sha: null` is how the Trees API expresses "remove this path from the base tree".
        entries.push({ path: op.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }

      const vaultPath = this.toVaultPath(op.path);
      const file = vaultPath === null ? null : this.deps.vault.getFileByPath(vaultPath);
      if (!file) continue; // Deleted between the plan and now; the next sync will catch it.

      if (op.binary) {
        const sha = await createBlob(ctx, arrayBufferToBase64(await this.deps.vault.readBinary(file)));
        entries.push({ path: op.path, mode: '100644', type: 'blob', sha });
      } else {
        entries.push({
          path: op.path,
          mode: '100644',
          type: 'blob',
          content: await this.deps.vault.cachedRead(file),
        });
      }
    }

    return entries;
  }
}

async function readHeadTree(
  ctx: GitHubContext,
  commitSha: string,
): Promise<{ treeSha: string; remote: Record<string, string> }> {
  const commit = await call<{ tree: { sha: string } }>(ctx, `/git/commits/${commitSha}`);
  const tree = await readTree(ctx, commit.tree.sha);

  // A truncated listing looks exactly like a repo missing thousands of files, and the planner
  // would answer that with thousands of deletions. Refusing is the only safe response.
  if (tree.truncated) {
    throw new Error(
      'This repository is too large for a single tree listing, so a safe diff is not possible. ' +
        'Publish the vault to a smaller repo, or scope it with a subfolder.',
    );
  }

  const remote: Record<string, string> = {};
  for (const entry of tree.files) remote[entry.path] = entry.sha;
  return { treeSha: commit.tree.sha, remote };
}

/**
 * The baseline after a successful push: what both sides now agree on.
 *
 * Diverged paths keep their *old* entry on purpose — the push did not resolve them, so
 * advancing the baseline would erase the evidence and let the next sync overwrite whichever
 * side lost. Skipped (too-large) files keep their old entry for the same reason.
 */
function nextBaselineFiles(
  previous: Record<string, string>,
  local: LocalFile[],
  plan: PushPlan,
): Record<string, string> {
  const unresolved = new Set<string>([
    ...plan.conflicts.map((c) => c.path),
    ...plan.skipped.map((s) => s.path),
  ]);

  const next: Record<string, string> = {};
  for (const path of unresolved) {
    const prior = previous[path];
    if (prior !== undefined) next[path] = prior;
  }
  for (const file of local) {
    if (unresolved.has(file.path)) continue;
    next[file.path] = file.sha;
  }
  return next;
}
