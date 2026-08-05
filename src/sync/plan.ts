/**
 * The push planner: `(local files, remote tree, baseline) → PushPlan`. Pure — no vault, no
 * network, no clock. Everything the `Basalt Causeway: dry run` command prints comes from here,
 * which is the point: you can read exactly what a sync would do before it does it.
 */

import { compare } from './conflict';
import { forbiddenFolders, isForbiddenPath, normalizeSubfolder } from './exclude';

export type LocalFile = {
  /** Repo-relative — the subfolder prefix is already applied by the caller. */
  path: string;
  sha: string;
  size: number;
  binary: boolean;
  /**
   * False when the published form of this note cannot currently be computed — a Dataview note
   * while Dataview is unavailable. Such a file is held, not published: `sha` describes the raw
   * bytes, which are emphatically *not* what belongs in the repo.
   */
  renderable?: boolean;
};

export type PushOp =
  | { op: 'add' | 'modify'; path: string; binary: boolean }
  | { op: 'delete'; path: string; binary: false };

export type PlanConflict = {
  path: string;
  /** What the remote holds now, or null when the remote deleted it. */
  remoteSha: string | null;
  /** What we hold now, or null when we deleted it. */
  localSha: string | null;
};

export type SkippedFile = {
  path: string;
  reason: 'too-large' | 'dataview-unavailable';
  size: number;
};

export type PushPlan = {
  ops: PushOp[];
  conflicts: PlanConflict[];
  skipped: SkippedFile[];
  counts: { added: number; changed: number; deleted: number };
};

export type PlanInput = {
  /** Already exclude-filtered and subfolder-mapped. */
  local: LocalFile[];
  /** Repo path → blob sha, as GitHub has it at HEAD right now. */
  remote: Record<string, string>;
  /** Repo path → blob sha, as of the last successful sync. */
  baseline: Record<string, string>;
  maxFileBytes: number;
};

export function buildPushPlan(input: PlanInput): PushPlan {
  const { local, remote, baseline, maxFileBytes } = input;

  const ops: PushOp[] = [];
  const conflicts: PlanConflict[] = [];
  const skipped: SkippedFile[] = [];
  const seen = new Set<string>();

  for (const file of local) {
    seen.add(file.path);

    // Held rather than published. Pushing the raw query would overwrite the rendered table the
    // last successful sync produced — and it would flip straight back the moment Dataview loads,
    // committing in both directions forever. Skipping also keeps it in `seen`, so the
    // baseline-driven delete sweep below does not mistake it for a removal.
    if (file.renderable === false) {
      skipped.push({ path: file.path, reason: 'dataview-unavailable', size: file.size });
      continue;
    }

    // GitHub's blob limits would reject this anyway, and a 25 MB inline body is a bad way to
    // find that out. Skipping is not a silent drop — the caller surfaces every entry here.
    if (file.size > maxFileBytes) {
      skipped.push({ path: file.path, reason: 'too-large', size: file.size });
      continue;
    }

    const remoteSha = remote[file.path] ?? null;
    const baseSha = baseline[file.path] ?? null;

    switch (compare(remoteSha, file.sha, baseSha)) {
      case 'mine':
        // Remote already has these exact bytes. Nothing to write — and this is what makes a
        // sync that crashed after `createCommit` idempotent on re-run.
        break;
      case 'base':
        ops.push({ op: remoteSha === null ? 'add' : 'modify', path: file.path, binary: file.binary });
        break;
      case 'diverged':
        conflicts.push({ path: file.path, remoteSha, localSha: file.sha });
        break;
    }
  }

  // Deletions are driven by the **baseline**, never by "present on GitHub, absent locally".
  // A path we never synced is somebody else's file — a README committed on the web, a CI
  // workflow — and a first sync from a fresh vault must not propose wiping the repo.
  for (const path of Object.keys(baseline)) {
    if (seen.has(path)) continue;

    const remoteSha = remote[path] ?? null;
    const baseSha = baseline[path]!;

    switch (compare(remoteSha, null, baseSha)) {
      case 'mine':
        // Already gone on both sides.
        break;
      case 'base':
        ops.push({ op: 'delete', path, binary: false });
        break;
      case 'diverged':
        // We deleted it; they edited it. Deleting now would destroy their edit.
        conflicts.push({ path, remoteSha, localSha: null });
        break;
    }
  }

  ops.sort((a, b) => a.path.localeCompare(b.path));

  return {
    ops,
    conflicts,
    skipped,
    counts: {
      added: ops.filter((o) => o.op === 'add').length,
      changed: ops.filter((o) => o.op === 'modify').length,
      deleted: ops.filter((o) => o.op === 'delete').length,
    },
  };
}

/**
 * The last line of defence before a tree is built.
 *
 * The exclude filter already runs upstream, so reaching this throw means a bug — a mangled
 * user pattern, a subfolder prefix applied twice, a refactor that reordered the pipeline.
 * The cost of that bug is publishing a GitHub token to GitHub, so it gets a second,
 * unconditional check that does not depend on the user's settings being right.
 */
export function assertNoSecrets(paths: string[], subfolder: string, configDir: string): void {
  // Normalized through the same helper the engine uses. A hand-edited `data.json` holding
  // `subfolder: "vault/"` would otherwise build the prefix `vault//`, which matches nothing —
  // silently turning this last line of defence into a no-op.
  const normalized = normalizeSubfolder(subfolder);
  const prefix = normalized ? `${normalized}/` : '';

  for (const path of paths) {
    const vaultPath = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    if (isForbiddenPath(vaultPath, configDir)) {
      throw new Error(
        `Refusing to push "${path}": paths containing ${forbiddenFolders(configDir).join(' or ')} are never ` +
          'published. This is a bug in the exclude filter — your token may be in that folder.',
      );
    }
  }
}

/** Human-readable `PushPlan`, for the dry-run command and the console. */
export function describePlan(plan: PushPlan): string {
  const lines: string[] = [];
  lines.push(
    `${plan.counts.added} added, ${plan.counts.changed} changed, ${plan.counts.deleted} deleted`,
  );
  for (const op of plan.ops) lines.push(`  ${op.op.padEnd(6)} ${op.path}`);
  if (plan.conflicts.length > 0) {
    lines.push(`${plan.conflicts.length} conflict(s) — not pushed:`);
    for (const c of plan.conflicts) lines.push(`  diverge ${c.path}`);
  }
  if (plan.skipped.length > 0) {
    lines.push(`${plan.skipped.length} skipped:`);
    for (const s of plan.skipped) {
      const detail = s.reason === 'too-large' ? ` (${(s.size / 1024 / 1024).toFixed(1)} MB)` : '';
      lines.push(`  ${s.reason} ${s.path}${detail}`);
    }
  }
  return lines.join('\n');
}
