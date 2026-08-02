/**
 * Wiring only. Everything with a decision in it lives in `sync/` and `github/`; this file
 * exists to connect Obsidian's lifecycle to those and to nothing else.
 *
 * It is also the *only* module allowed to construct the HTTP transport, because that is the
 * one place `requestUrl` is needed — keeping `github/` free of the `obsidian` import is what
 * makes it unit-testable without a mock of the whole app.
 */

import { Notice, Plugin } from 'obsidian';

import { describeError } from './github/errors';
import { BasaltSyncSettingTab } from './settings';
import { SyncEngine, type SyncStatus } from './sync/engine';
import { describePlan } from './sync/plan';
import { obsidianTransport } from './transport';
import { DEFAULT_SETTINGS, EMPTY_BASELINE, type Baseline, type BasaltSyncSettings, type PersistedData } from './types';
import { ConflictModal } from './ui/conflictModal';
import { DryRunModal } from './ui/dryRunModal';
import { StatusBar } from './ui/statusBar';

export default class BasaltSyncPlugin extends Plugin {
  settings: BasaltSyncSettings = { ...DEFAULT_SETTINGS };
  baseline: Baseline = { ...EMPTY_BASELINE };

  private engine!: SyncEngine;
  private statusBar!: StatusBar;
  private status: SyncStatus = { phase: 'idle', pending: 0, conflicts: [], message: '' };
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  async onload(): Promise<void> {
    await this.loadPersisted();

    this.engine = new SyncEngine({
      vault: this.app.vault,
      transport: obsidianTransport,
      settings: () => this.settings,
      baseline: () => this.baseline,
      saveBaseline: async (baseline) => {
        this.baseline = baseline;
        await this.persist();
      },
      onStatus: (status) => this.setStatus(status),
    });

    this.statusBar = new StatusBar(this.addStatusBarItem(), () => {
      new ConflictModal(this.app, this.status.conflicts, this.status.message, async (path) => {
        await this.engine.keepLocalVersion(path);
        this.status = { ...this.status, conflicts: this.status.conflicts.filter((p) => p !== path) };
        this.renderStatus();
        new Notice(`Basalt Sync: keeping your version of ${path}. Sync to publish it.`);
      }).open();
    });
    this.renderStatus();

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => void this.runSync(false),
    });

    this.addCommand({
      id: 'dry-run',
      name: 'Dry run',
      callback: () => void this.runSync(true),
    });

    this.addRibbonIcon('refresh-cw', 'Basalt Sync: sync now', () => void this.runSync(false));

    this.addSettingTab(new BasaltSyncSettingTab(this.app, this));

    // `registerEvent` / `registerInterval` rather than hand-rolled cleanup: Obsidian releases
    // both on unload automatically, and the docs are explicit that a listener surviving a
    // disabled plugin degrades the app. The one thing it cannot release for us is the settle
    // timer, so `onunload` clears that by hand.
    // Registered one by one rather than in a loop: `vault.on` is overloaded per event name,
    // and a union argument matches none of the overloads.
    this.registerEvent(this.app.vault.on('create', () => this.onVaultChanged()));
    this.registerEvent(this.app.vault.on('modify', () => this.onVaultChanged()));
    this.registerEvent(this.app.vault.on('delete', () => this.onVaultChanged()));
    this.registerEvent(this.app.vault.on('rename', () => this.onVaultChanged()));

    // The layout-ready gate matters: vault events fire for every file during initial indexing,
    // and without it opening a vault would schedule a sync before the plugin knows what is in it.
    this.app.workspace.onLayoutReady(() => {
      void this.refreshPending();
      if (this.settings.pullIntervalMs > 0) {
        this.registerInterval(
          window.setInterval(() => {
            if (!this.engine.isRunning) void this.runSync(false, { quiet: true });
          }, this.settings.pullIntervalMs),
        );
      }
    });
  }

  onunload(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  // ---- persistence ----------------------------------------------------------

  /** Not named `load` — `Plugin` already owns that, and shadowing it breaks the lifecycle. */
  private async loadPersisted(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PersistedData> | null;
    // `Object.assign` over the defaults, not the stored object alone: a settings field added
    // in a later version is absent from an old data.json and would otherwise arrive undefined.
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored?.settings);
    this.baseline = Object.assign({}, EMPTY_BASELINE, stored?.baseline);
  }

  async persist(): Promise<void> {
    await this.saveData({ settings: this.settings, baseline: this.baseline } satisfies PersistedData);
    this.renderStatus();
  }

  async resetBaseline(): Promise<void> {
    // Fresh objects, not a spread of EMPTY_BASELINE: that constant's `files` and `conflicts`
    // are shared references, and handing them out would alias the reset state everywhere.
    this.baseline = { commitSha: null, files: {}, conflicts: {} };
    this.status = { ...this.status, conflicts: [], message: 'Baseline reset.' };
    await this.persist();
    new Notice('Basalt Sync: baseline reset. The next sync republishes everything.');
  }

  // ---- triggers -------------------------------------------------------------

  /**
   * Debounced by the settle window rather than firing per event. A vault event arrives on
   * every keystroke-flush, and a commit per keystroke would make Basalt re-download the whole
   * zipball each time — the mobile cost of a desktop habit.
   */
  private onVaultChanged(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.refreshPending();
      if (this.settings.autoSync && !this.engine.isRunning) void this.runSync(false, { quiet: true });
    }, Math.max(1000, this.settings.settleMs));
  }

  private async refreshPending(): Promise<void> {
    try {
      this.status = { ...this.status, pending: await this.engine.pendingCount() };
      this.renderStatus();
    } catch {
      // Counting is advisory. A failure here must never surface as a sync error.
    }
  }

  private async runSync(dryRun: boolean, options: { quiet?: boolean } = {}): Promise<void> {
    try {
      const report = await this.engine.sync({ dryRun });

      if (dryRun) {
        new DryRunModal(this.app, describePlan(report.plan)).open();
        return;
      }

      await this.refreshPending();

      if (options.quiet) return;

      const parts: string[] = [];
      if (report.commitSha) {
        parts.push(
          `pushed ${report.plan.counts.added + report.plan.counts.changed + report.plan.counts.deleted} file(s) as ${report.commitSha.slice(0, 7)}`,
        );
      }
      if (report.pulled.written + report.pulled.deleted > 0) {
        parts.push(`pulled ${report.pulled.written} written, ${report.pulled.deleted} deleted`);
      }
      if (report.conflicts.length > 0) parts.push(`${report.conflicts.length} conflict(s)`);
      new Notice(`Basalt Sync: ${parts.length > 0 ? parts.join(' · ') : 'already up to date'}.`);
    } catch (err) {
      // Auto-sync failures are still surfaced. A silent background failure is how a user
      // discovers weeks later that nothing has reached their phone.
      new Notice(`Basalt Sync: ${describeError(err)}`);
    }
  }

  // ---- status ---------------------------------------------------------------

  private setStatus(status: SyncStatus): void {
    this.status = { ...status, pending: status.phase === 'idle' ? 0 : this.status.pending };
    this.renderStatus();
  }

  private renderStatus(): void {
    this.statusBar?.render(this.status, this.settings);
  }
}
