/**
 * A GitHub Git-Data server small enough to hold in your head, backed by real content-addressed
 * storage: blob shas are computed with the same `gitBlobSha` the plugin uses, so "the remote
 * already has our bytes" is a genuine hash agreement rather than a fixture that says so.
 *
 * It enforces the two rules the push path depends on:
 *   - `PATCH /git/refs` rejects a non-fast-forward move with 409 (the retry path).
 *   - a tree is layered on `base_tree`, so an entry list that forgets a file loses it.
 */

import { gitBlobSha } from '../github/blobSha';
import type { HttpRequest, HttpResponse, Transport } from '../github/client';

type Commit = { tree: string; parent: string | null; message: string };
type Snapshot = Map<string, string>; // path -> blob sha

export class FakeGitHub {
  private blobs = new Map<string, string>(); // blob sha -> base64
  private trees = new Map<string, Snapshot>();
  private commits = new Map<string, Commit>();
  private refs = new Map<string, string>(); // branch -> commit sha
  private ids = 0;

  /** Every request, for asserting the *shape* of a sync (one commit, N blob uploads). */
  readonly requests: HttpRequest[] = [];

  /** Queued failures, keyed by a URL fragment — used to force the retry and error paths. */
  private failures: { match: string; status: number; body: string; method?: string }[] = [];

  constructor(seed: Record<string, string | Uint8Array> = {}, branch = 'main') {
    const snapshot: Snapshot = new Map();
    for (const [path, content] of Object.entries(seed)) {
      snapshot.set(path, this.putBlob(content));
    }
    const treeSha = this.store(snapshot);
    const commitSha = this.nextId('commit');
    this.commits.set(commitSha, { tree: treeSha, parent: null, message: 'seed' });
    this.refs.set(branch, commitSha);
  }

  // ---- inspection -----------------------------------------------------------

  head(branch = 'main'): string {
    return this.refs.get(branch)!;
  }

  /** Every commit from the tip back to the root, newest first. */
  history(branch = 'main'): { sha: string; message: string }[] {
    const out: { sha: string; message: string }[] = [];
    let sha: string | null = this.refs.get(branch) ?? null;
    while (sha) {
      const commit: Commit = this.commits.get(sha)!;
      out.push({ sha, message: commit.message });
      sha = commit.parent;
    }
    return out;
  }

  /** The repo as a plain path → text map, at the branch tip. */
  files(branch = 'main'): Record<string, string> {
    const snapshot = this.trees.get(this.commits.get(this.refs.get(branch)!)!.tree)!;
    const out: Record<string, string> = {};
    for (const [path, sha] of snapshot) {
      out[path] = Buffer.from(this.blobs.get(sha)!, 'base64').toString('utf8');
    }
    return out;
  }

  bytes(path: string, branch = 'main'): Uint8Array {
    const snapshot = this.trees.get(this.commits.get(this.refs.get(branch)!)!.tree)!;
    return new Uint8Array(Buffer.from(this.blobs.get(snapshot.get(path)!)!, 'base64'));
  }

  countRequests(fragment: string, method?: string): number {
    return this.requests.filter(
      (req) => req.url.includes(fragment) && (method === undefined || req.method === method),
    ).length;
  }

  // ---- test levers ----------------------------------------------------------

  /** Commit directly, as the phone or the web UI would. */
  commit(changes: Record<string, string | null>, branch = 'main', message = 'external'): string {
    const parent = this.refs.get(branch)!;
    const snapshot = new Map(this.trees.get(this.commits.get(parent)!.tree)!);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) snapshot.delete(path);
      else snapshot.set(path, this.putBlob(content));
    }
    const sha = this.nextId('commit');
    this.commits.set(sha, { tree: this.store(snapshot), parent, message });
    this.refs.set(branch, sha);
    return sha;
  }

  /**
   * Fail the next matching request once. `method` matters more than it looks: `/git/trees` is
   * both a GET (reading HEAD's tree) and a POST (writing a new one), and they map through
   * different halves of the error taxonomy.
   */
  failNext(match: string, status: number, body = '{}', method?: string): void {
    this.failures.push({ match, status, body, method });
  }

  // ---- the transport --------------------------------------------------------

  transport(): Transport {
    return async (req: HttpRequest): Promise<HttpResponse> => {
      this.requests.push(req);

      const failure = this.failures.findIndex(
        (f) => req.url.includes(f.match) && (f.method === undefined || f.method === req.method),
      );
      if (failure >= 0) {
        const { status, body } = this.failures[failure]!;
        this.failures.splice(failure, 1);
        return { status, headers: {}, text: body };
      }

      const path = req.url.replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '');
      const body = req.body === undefined ? undefined : (JSON.parse(req.body) as Record<string, unknown>);
      return this.route(req.method, path, body);
    };
  }

  private route(method: string, path: string, body?: Record<string, unknown>): HttpResponse {
    const json = (value: unknown, status = 200): HttpResponse => ({
      status,
      headers: {},
      text: JSON.stringify(value),
    });
    const fail = (status: number, message: string): HttpResponse =>
      ({ status, headers: {}, text: JSON.stringify({ message }) });

    if (method === 'GET' && path.startsWith('/git/ref/heads/')) {
      const branch = decodeURIComponent(path.slice('/git/ref/heads/'.length));
      const sha = this.refs.get(branch);
      return sha ? json({ object: { sha } }) : fail(404, 'Branch not found');
    }

    if (method === 'GET' && path.startsWith('/git/commits/')) {
      const commit = this.commits.get(path.slice('/git/commits/'.length));
      return commit ? json({ tree: { sha: commit.tree } }) : fail(404, 'Not Found');
    }

    if (method === 'GET' && path.startsWith('/git/trees/')) {
      const snapshot = this.trees.get(path.slice('/git/trees/'.length).split('?')[0]!);
      if (!snapshot) return fail(404, 'Not Found');
      return json({
        tree: [...snapshot].map(([p, sha]) => ({
          path: p,
          type: 'blob',
          mode: '100644',
          sha,
          size: Buffer.from(this.blobs.get(sha)!, 'base64').length,
        })),
        truncated: false,
      });
    }

    if (method === 'GET' && path.startsWith('/git/blobs/')) {
      const content = this.blobs.get(path.slice('/git/blobs/'.length));
      return content === undefined ? fail(404, 'Not Found') : json({ content, encoding: 'base64' });
    }

    if (method === 'POST' && path === '/git/blobs') {
      return json({ sha: this.putBase64(String(body!.content)) }, 201);
    }

    if (method === 'POST' && path === '/git/trees') {
      const base = this.trees.get(String(body!.base_tree));
      if (!base) return fail(422, 'Invalid base_tree');
      const snapshot = new Map(base);
      for (const entry of body!.tree as { path: string; content?: string; sha?: string | null }[]) {
        // `sha: null` is the API's deletion form; anything else adds or replaces.
        if (entry.sha === null) snapshot.delete(entry.path);
        else if (entry.content !== undefined) snapshot.set(entry.path, this.putBlob(entry.content));
        else if (entry.sha) snapshot.set(entry.path, entry.sha);
      }
      return json({ sha: this.store(snapshot) }, 201);
    }

    if (method === 'POST' && path === '/git/commits') {
      const sha = this.nextId('commit');
      const parents = body!.parents as string[];
      this.commits.set(sha, {
        tree: String(body!.tree),
        parent: parents[0] ?? null,
        message: String(body!.message),
      });
      return json({ sha }, 201);
    }

    if (method === 'PATCH' && path.startsWith('/git/refs/heads/')) {
      const branch = decodeURIComponent(path.slice('/git/refs/heads/'.length));
      const target = String(body!.sha);
      const commit = this.commits.get(target);
      if (!commit) return fail(422, 'Invalid sha');
      // Without `force`, GitHub only moves a ref forward. The commit must descend from the
      // current tip — which is exactly the guard that turns a concurrent push into a 409.
      if (commit.parent !== this.refs.get(branch)) {
        return fail(409, 'Update is not a fast forward');
      }
      this.refs.set(branch, target);
      return json({ object: { sha: target } });
    }

    if (method === 'GET' && path.startsWith('/compare/')) {
      const [base, head] = decodeURIComponent(path.slice('/compare/'.length)).split('...');
      const from = this.trees.get(this.commits.get(base!)!.tree)!;
      const to = this.trees.get(this.commits.get(head!)!.tree)!;

      // Real GitHub also detects renames and emits a single `renamed` entry; this fake emits
      // the removal and the addition separately. The engine expands renames into exactly that
      // pair before doing anything, so both shapes take the same code path.
      const files: { filename: string; status: string; sha?: string }[] = [];
      for (const [p, sha] of to) {
        if (!from.has(p)) files.push({ filename: p, status: 'added', sha });
        else if (from.get(p) !== sha) files.push({ filename: p, status: 'modified', sha });
      }
      for (const [p, sha] of from) {
        if (!to.has(p)) files.push({ filename: p, status: 'removed', sha });
      }
      return json({ files });
    }

    return fail(404, `unrouted ${method} ${path}`);
  }

  // ---- storage --------------------------------------------------------------

  private nextId(kind: string): string {
    this.ids += 1;
    return `${kind}${String(this.ids).padStart(4, '0')}${'0'.repeat(30)}`.slice(0, 40);
  }

  private putBlob(content: string | Uint8Array): string {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const sha = gitBlobSha(bytes);
    this.blobs.set(sha, Buffer.from(bytes).toString('base64'));
    return sha;
  }

  private putBase64(base64: string): string {
    return this.putBlob(new Uint8Array(Buffer.from(base64.replace(/\s+/g, ''), 'base64')));
  }

  /** Content-addressed: an identical file set always yields an identical tree sha. */
  private store(snapshot: Snapshot): string {
    const key = [...snapshot].sort().map(([p, s]) => `${p}:${s}`).join('\n');
    const sha = gitBlobSha(`tree\0${key}`);
    this.trees.set(sha, snapshot);
    return sha;
  }
}
