/**
 * Wiring only. Everything with a decision in it lives in `sync/` and `github/`; this file
 * exists to connect Obsidian's lifecycle to those and to nothing else.
 *
 * It is also the *only* module allowed to construct the HTTP transport, because that is the
 * one place `requestUrl` is needed — keeping `github/` free of the `obsidian` import is what
 * makes it unit-testable without a mock of the whole app.
 */

import { Menu, Notice, Plugin } from 'obsidian';

import { createBaker } from './dataview/api';
import { describeError } from './github/errors';
import { habitCalendarProcessor } from './habit/calendar';
import { habitCalendarExtension } from './habit/liveCalendar';
import { BasaltCausewaySettingTab } from './settings';
import { SyncEngine, type SyncStatus } from './sync/engine';
import { appendHistory, trimChanges, type SyncChange, type SyncHistoryEntry } from './sync/history';
import { normalizeSubfolder } from './sync/exclude';
import { describePlan } from './sync/plan';
import { obsidianTransport } from './transport';
import { defaultSettings, EMPTY_BASELINE, type Baseline, type BasaltCausewaySettings, type PersistedData } from './types';
import { BASALT_ICON_ID, registerBasaltIcon } from './ui/basaltIcon';
import { ConflictModal } from './ui/conflictModal';
import { DryRunModal } from './ui/dryRunModal';
import { HistoryModal } from './ui/historyModal';
import { StatusBar } from './ui/statusBar';

/** How often the pull poller wakes to *consider* syncing; the setting decides whether it does. */
const PULL_TICK_MS = 30_000;

export default class BasaltCausewayPlugin extends Plugin {
  // Definitely assigned by `loadPersisted()`, which is the first statement in `onload` and runs
  // before anything can read this. Not a field initialiser, because the defaults now derive from
  // `Vault#configDir` and reaching for `this.app` mid-construction is a sharper edge than it looks.
  settings!: BasaltCausewaySettings;
  baseline: Baseline = { ...EMPTY_BASELINE };
  /** Newest first, capped. See `sync/history.ts` for why it is bounded. */
  history: SyncHistoryEntry[] = [];

  private engine!: SyncEngine;
  private statusBar!: StatusBar;
  private status: SyncStatus = { phase: 'idle', pending: 0, conflicts: [], message: '' };
  // `number`, not `ReturnType<typeof setTimeout>`: @types/node is in scope for the build scripts
  // and makes that alias resolve to Node's `Timeout`, while `window.setTimeout` — the DOM one we
  // actually call — hands back a numeric handle. Naming the browser type is what keeps the two
  // from disagreeing.
  private settleTimer: number | null = null;
  private lastPullCheck = 0;

  async onload(): Promise<void> {
    // Before anything references the id — a ribbon icon pointing at an unregistered id renders
    // as an empty box.
    registerBasaltIcon();

    await this.loadPersisted();

    this.engine = new SyncEngine({
      vault: this.app.vault,
      fileManager: this.app.fileManager,
      transport: obsidianTransport,
      settings: () => this.settings,
      baseline: () => this.baseline,
      saveBaseline: async (baseline) => {
        this.baseline = baseline;
        await this.persist();
      },
      onStatus: (status) => this.setStatus(status),
      // Resolved once at load. Dataview registers its API during its own `onload`, and plugin
      // load order is not guaranteed — so this is re-resolved lazily on first use rather than
      // captured as a possibly-null value here.
      bake: (content, path) => this.bakeWithDataview(content, path),
    });

    this.statusBar = new StatusBar(this.addStatusBarItem(), {
      // Conflicts are the thing you must act on, so they win when present. With none — the
      // ordinary case — the useful answer to "what is this thing doing?" is the history.
      onClick: () => {
        if (this.status.conflicts.length > 0) this.openConflicts();
        else new HistoryModal(this.app, this.history).open();
      },
      onContextMenu: (event) => this.openStatusMenu(event),
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

    this.addCommand({
      id: 'sync-history',
      name: 'Show sync history',
      callback: () => new HistoryModal(this.app, this.history).open(),
    });

    this.addRibbonIcon(BASALT_ICON_ID, 'Basalt Causeway: sync now', () => void this.runSync(false));

    this.addSettingTab(new BasaltCausewaySettingTab(this.app, this));

    // Two hosts for one feature: reading view renders through a post-processor, Live Preview
    // through a CodeMirror decoration. Both read the setting through a thunk rather than by value,
    // so turning it off takes effect without a restart — `workspace.updateOptions()` in the
    // settings tab is what nudges the editor half to re-evaluate.
    this.registerMarkdownPostProcessor(
      habitCalendarProcessor(this.app, () => this.settings.habitCalendar),
    );
    this.registerEditorExtension(habitCalendarExtension(() => this.settings.habitCalendar));

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
      // One fixed tick that *reads* the setting, rather than an interval whose period was
      // captured at layout-ready. The old form meant changing "check for remote changes" from 0
      // to 5 never started polling and 5 to 0 never stopped it — until an Obsidian restart, with
      // nothing in the UI to suggest it.
      this.registerInterval(
        window.setInterval(() => {
          const period = this.settings.pullIntervalMs;
          if (period <= 0 || this.engine.isRunning) return;
          if (Date.now() - this.lastPullCheck < period) return;
          this.lastPullCheck = Date.now();
          void this.runSync(false, { quiet: true });
        }, PULL_TICK_MS),
      );
    });
  }

  onunload(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  /**
   * Publish-time Dataview rendering, resolved lazily.
   *
   * Plugin load order is not guaranteed, so asking for Dataview's API during our own `onload`
   * can find nothing even in a vault that has it. Resolving on first use — a sync, long after
   * startup — always finds it if it is there.
   *
   * Failures are collected and reported once per sync rather than one Notice per query: a
   * vault with a broken query in twenty daily notes would otherwise bury the screen.
   */
  private async bakeWithDataview(content: string, path: string): Promise<string | null> {
    const failures: string[] = [];
    const baker = createBaker(this.app, (file, error) => failures.push(`${file}: ${error}`));
    // `null`, not `content`. Returning the input would be indistinguishable from a successful
    // bake that changed nothing — and the engine would then treat the raw query as the published
    // form and commit it over the rendered table. Vaults where Dataview loads after us would do
    // that on the first settle-timer sync after startup, then flip back, committing each way.
    if (!baker) return null;

    const baked = await baker(content, path);
    if (failures.length > 0) {
      new Notice(`Basalt Causeway: ${failures.length} Dataview query failed; published as-is.\n${failures[0]}`);
    }
    return baked;
  }

  // ---- persistence ----------------------------------------------------------

  /** Not named `load` — `Plugin` already owns that, and shadowing it breaks the lifecycle. */
  private async loadPersisted(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PersistedData> | null;
    // `Object.assign` over the defaults, not the stored object alone: a settings field added
    // in a later version is absent from an old data.json and would otherwise arrive undefined.
    this.settings = Object.assign({}, defaultSettings(this.app.vault.configDir), stored?.settings);
    this.baseline = Object.assign({}, EMPTY_BASELINE, stored?.baseline);
    // Absent in every data.json written before history existed, so default rather than trust it.
    this.history = Array.isArray(stored?.history) ? stored.history : [];
  }

  async persist(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      baseline: this.baseline,
      history: this.history,
    } satisfies PersistedData);
    this.renderStatus();
  }

  async resetBaseline(): Promise<void> {
    // Fresh objects, not a spread of EMPTY_BASELINE: that constant's `files` and `conflicts`
    // are shared references, and handing them out would alias the reset state everywhere.
    this.baseline = { commitSha: null, files: {}, conflicts: {} };
    this.status = { ...this.status, conflicts: [], message: 'Baseline reset.' };
    await this.persist();
    new Notice('Basalt Causeway: baseline reset. The next sync republishes everything.');
  }

  // ---- triggers -------------------------------------------------------------

  /**
   * Debounced by the settle window rather than firing per event. A vault event arrives on
   * every keystroke-flush, and a commit per keystroke would make Basalt re-download the whole
   * zipball each time — the mobile cost of a desktop habit.
   */
  private onVaultChanged(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      if (this.engine.isRunning) {
        // Re-arm rather than drop it. The settle timer was already cleared above, so returning
        // here would strand edits made *during* a sync until some later, unrelated vault event —
        // and `pull()` writes files itself, so this branch is hit routinely.
        this.onVaultChanged();
        return;
      }
      void this.refreshPending();
      if (this.settings.autoSync) void this.runSync(false, { quiet: true });
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

      // A dry run is a preview that changes nothing, so it is not history. Recording one would
      // pad the log with entries that never touched either side.
      if (dryRun) {
        new DryRunModal(this.app, describePlan(report.plan)).open();
        return;
      }

      // `plan.ops` is repo-relative; the pull side is already vault-relative. Un-prefixing here
      // means the list reads in the paths the user recognises, in one spelling.
      const sub = normalizeSubfolder(this.settings.subfolder);
      const unprefix = (path: string) =>
        sub && path.startsWith(`${sub}/`) ? path.slice(sub.length + 1) : path;

      const changes: SyncChange[] = [
        ...report.pulled.paths.map((p) => ({
          direction: 'pull' as const,
          op: p.op === 'write' ? ('modify' as const) : ('delete' as const),
          path: p.path,
        })),
        ...report.plan.ops.map((op) => ({
          direction: 'push' as const,
          op: op.op,
          path: unprefix(op.path),
        })),
      ];

      await this.record({
        at: Date.now(),
        outcome: 'ok',
        pushed: report.plan.counts,
        pulled: { written: report.pulled.written, deleted: report.pulled.deleted },
        commitSha: report.commitSha,
        conflicts: report.conflicts.length,
        ...trimChanges(changes),
      });

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
      new Notice(`Basalt Causeway: ${parts.length > 0 ? parts.join(' · ') : 'already up to date'}.`);
    } catch (err) {
      // Recorded even for a dry run: a dry run that *threw* says something real about the repo,
      // unlike one that merely previewed nothing.
      await this.record({
        at: Date.now(),
        outcome: 'error',
        pushed: { added: 0, changed: 0, deleted: 0 },
        pulled: { written: 0, deleted: 0 },
        commitSha: null,
        conflicts: this.status.conflicts.length,
        error: describeError(err),
      });

      // Auto-sync failures are still surfaced. A silent background failure is how a user
      // discovers weeks later that nothing has reached their phone.
      new Notice(`Basalt Causeway: ${describeError(err)}`);
    }
  }

  /**
   * Append one run and persist. Never allowed to break a sync: a log that fails loudly would
   * turn a successful sync into a reported failure, which is exactly backwards.
   */
  private async record(entry: SyncHistoryEntry): Promise<void> {
    try {
      this.history = appendHistory(this.history, entry);
      await this.persist();
    } catch {
      // Keep the in-memory entry; the next successful persist writes it.
    }
  }

  private openConflicts(): void {
    new ConflictModal(this.app, this.status.conflicts, this.status.message, async (path) => {
      await this.engine.keepLocalVersion(path);
      this.status = { ...this.status, conflicts: this.status.conflicts.filter((p) => p !== path) };
      this.renderStatus();
      new Notice(`Basalt Causeway: keeping your version of ${path}. Sync to publish it.`);
    }).open();
  }

  /**
   * Everything the plugin can do, from the one control that is always on screen — so none of it
   * requires knowing a command name or finding the settings tab.
   */
  private openStatusMenu(event: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle('Sync now')
        .setIcon('refresh-cw')
        .onClick(() => void this.runSync(false)),
    );
    menu.addItem((item) =>
      item
        .setTitle('Dry run')
        .setIcon('list')
        .onClick(() => void this.runSync(true)),
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle('Sync history')
        .setIcon('history')
        .onClick(() => new HistoryModal(this.app, this.history).open()),
    );

    // Listed only when it would show something. A permanently-present "0 conflicts" entry is
    // noise in a menu this small.
    if (this.status.conflicts.length > 0) {
      menu.addItem((item) =>
        item
          .setTitle(`Resolve ${this.status.conflicts.length} conflict(s)`)
          .setIcon('alert-triangle')
          .onClick(() => this.openConflicts()),
      );
    }

    menu.showAtMouseEvent(event);
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
