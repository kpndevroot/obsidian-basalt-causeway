/**
 * An in-memory Vault covering exactly the surface `SyncEngine` touches.
 *
 * Files are stored as bytes, never as strings, so a test that pushes a PNG and pulls it back
 * fails loudly if anything in the pipeline round-trips it through UTF-8 — which is the one
 * corruption a text/binary misclassification would otherwise cause silently.
 */

import type { TFile, Vault } from 'obsidian';

type Entry = { bytes: Uint8Array; mtime: number };

export class FakeVault {
  private files = new Map<string, Entry>();
  private folders = new Set<string>();
  private clock = 1000;

  /** Paths sent to the trash, in order. `delete` must never appear in the engine. */
  readonly trashed: string[] = [];
  /** Paths hard-deleted. Any entry here is a bug: a remote deletion must stay recoverable. */
  readonly hardDeleted: string[] = [];

  constructor(seed: Record<string, string | Uint8Array> = {}) {
    for (const [path, content] of Object.entries(seed)) this.set(path, content);
  }

  // ---- test helpers ---------------------------------------------------------

  /** Write without going through the Vault API — the "user edited this" lever. */
  set(path: string, content: string | Uint8Array): void {
    this.clock += 1;
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.files.set(path, { bytes, mtime: this.clock });
    const slash = path.lastIndexOf('/');
    if (slash > 0) this.folders.add(path.slice(0, slash));
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  /** Named `contentOf`, not `read` — `read(file)` is part of the Vault surface below. */
  contentOf(path: string): string | undefined {
    const entry = this.files.get(path);
    return entry ? new TextDecoder().decode(entry.bytes) : undefined;
  }

  readBytes(path: string): Uint8Array | undefined {
    return this.files.get(path)?.bytes;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Typed as the real `Vault` so any drift in the API surface fails typecheck. */
  asVault(): Vault {
    return this as unknown as Vault;
  }

  // ---- the Vault surface ----------------------------------------------------

  private toFile(path: string, entry: Entry): TFile {
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    return {
      path,
      name: path.slice(slash + 1),
      basename: path.slice(slash + 1, dot > slash ? dot : undefined),
      extension: dot > slash ? path.slice(dot + 1) : '',
      stat: { mtime: entry.mtime, ctime: entry.mtime, size: entry.bytes.length },
    } as TFile;
  }

  getFiles(): TFile[] {
    return [...this.files.entries()].map(([path, entry]) => this.toFile(path, entry));
  }

  getFileByPath(path: string): TFile | null {
    const entry = this.files.get(path);
    return entry ? this.toFile(path, entry) : null;
  }

  getFolderByPath(path: string): { path: string } | null {
    return this.folders.has(path) ? { path } : null;
  }

  async createFolder(path: string): Promise<{ path: string }> {
    this.folders.add(path);
    return { path };
  }

  async cachedRead(file: TFile): Promise<string> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`no such file: ${file.path}`);
    return new TextDecoder().decode(entry.bytes);
  }

  async read(file: TFile): Promise<string> {
    return this.cachedRead(file);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`no such file: ${file.path}`);
    return entry.bytes.buffer.slice(
      entry.bytes.byteOffset,
      entry.bytes.byteOffset + entry.bytes.byteLength,
    ) as ArrayBuffer;
  }

  async create(path: string, data: string): Promise<TFile> {
    if (this.files.has(path)) throw new Error(`already exists: ${path}`);
    this.set(path, data);
    return this.getFileByPath(path)!;
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    if (this.files.has(path)) throw new Error(`already exists: ${path}`);
    this.set(path, new Uint8Array(data));
    return this.getFileByPath(path)!;
  }

  async modify(file: TFile, data: string): Promise<void> {
    this.set(file.path, data);
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    this.set(file.path, new Uint8Array(data));
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const current = await this.cachedRead(file);
    const next = fn(current);
    this.set(file.path, next);
    return next;
  }

  async trash(file: TFile, _system: boolean): Promise<void> {
    this.trashed.push(file.path);
    this.files.delete(file.path);
  }

  async delete(file: TFile): Promise<void> {
    this.hardDeleted.push(file.path);
    this.files.delete(file.path);
  }
}
