import { Notice, Platform, PluginSettingTab, Setting, type App } from 'obsidian';

import { discoverLocalAccounts, resolveAccountToken, type LocalAccount } from './desktop/ghAccounts';
import { describeError } from './github/errors';
import { fetchViewer, fetchWritableRepos, type Viewer } from './github/identity';
import { readHead, readTree } from './github/trees';
import type BasaltCausewayPlugin from './main';
import { describeDetection, detectSubfolder } from './sync/detectSubfolder';
import { compileExclude, defaultExclude, isForbiddenPath } from './sync/exclude';
import { obsidianTransport } from './transport';
import { AccountPicker } from './ui/accountPicker';
import { HistoryModal } from './ui/historyModal';
import { RepoPicker } from './ui/repoPicker';

/**
 * Built imperatively in `display()` rather than declared via `getSettingDefinitions()`.
 *
 * That API is `@since 1.13.0`, and this plugin's `minAppVersion` is 1.6.6 — adopting it would
 * cut off every Obsidian below 1.13.0 for what is, on this tab, mostly a presentational win.
 * The known cost of staying imperative is real but narrow: these settings do not appear in
 * Obsidian's built-in settings *search* for users on 1.13.0 or later.
 *
 * When the floor does move to 1.13.0, the plain toggles and text fields convert almost
 * mechanically. The parts that will not are the ones worth planning for: the token field
 * revalidates against the GitHub API on change, the owner/repo fields are filled by two fuzzy
 * picker modals rather than typed, and five paths call `this.display()` to re-render the tab
 * after mutating state. Expect a hybrid, not a straight swap.
 */
export class BasaltCausewaySettingTab extends PluginSettingTab {
  /** Cached for the session so reopening settings does not re-hit the API. */
  private viewer: Viewer | null = null;

  /**
   * Read once per tab open, not per render: `display()` re-runs on every field change, and
   * touching the filesystem on each keystroke would be wasteful for a list that cannot move
   * while the tab is open.
   */
  private localAccounts: LocalAccount[] | null = null;

  constructor(
    app: App,
    private readonly plugin: BasaltCausewayPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderConnect(containerEl);

    new Setting(containerEl).setName('Repository').setHeading();

    new Setting(containerEl)
      .setName('Owner')
      .setDesc('The GitHub user or organisation that owns the repo.')
      .addText((text) =>
        text
          .setPlaceholder('kpndevroot')
          .setValue(this.plugin.settings.owner)
          .onChange(async (value) => {
            this.plugin.settings.owner = value.trim();
            await this.plugin.persist();
          }),
      );

    new Setting(containerEl)
      .setName('Repository')
      .setDesc('The repository name, without the owner.')
      .addText((text) =>
        text
          .setPlaceholder('my-vault')
          .setValue(this.plugin.settings.repo)
          .onChange(async (value) => {
            this.plugin.settings.repo = value.trim();
            await this.plugin.persist();
          }),
      );

    new Setting(containerEl)
      .setName('Branch')
      .setDesc('Must be the same branch the vault points at in Basalt. A mismatch syncs happily and never arrives.')
      .addText((text) =>
        text
          .setPlaceholder('main')
          .setValue(this.plugin.settings.branch)
          .onChange(async (value) => {
            this.plugin.settings.branch = value.trim();
            await this.plugin.persist();
          }),
      );

    new Setting(containerEl)
      .setName('Subfolder')
      .setDesc(
        'Where this vault lives inside the repo. Leave empty to map the vault root to the repo root. ' +
          'Use Detect to read it from the repo — a wrong value is silent: pushes land beside your notes ' +
          'instead of in them, and incoming edits arrive as a new folder rather than reaching the note.',
      )
      .addText((text) =>
        text
          .setPlaceholder('(repo root)')
          .setValue(this.plugin.settings.subfolder)
          .onChange(async (value) => {
            this.plugin.settings.subfolder = value.replace(/^\/+|\/+$/g, '');
            await this.plugin.persist();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText('Detect')
          .setTooltip('Find where this vault already lives in the repo')
          .onClick(() => void this.detectSubfolder()),
      );

    new Setting(containerEl).setName('Authentication').setHeading();

    const token = new Setting(containerEl)
      .setName('GitHub token')
      .setDesc('A fine-grained personal access token with Contents: read and write on this one repository.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('github_pat_…')
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            this.viewer = null; // A new token is a different account until proven otherwise.
            await this.plugin.persist();
            void this.refreshViewer();
          });
      });

    token.descEl.createDiv({
      cls: 'basalt-causeway-hint',
      text:
        'Already signed in with the GitHub CLI? `gh auth token` prints a token you can paste here. ' +
        'It carries whatever scopes gh was granted, which is broader than this plugin needs.',
    });

    // Stated plainly and permanently, because the storage location is genuinely hazardous:
    // data.json lives inside the vault this plugin publishes. The exclude filter and the
    // hard assertion in plan.ts keep it out of every commit, but the user still deserves to
    // know where their token sits and to scope it accordingly.
    token.descEl.createDiv({
      cls: 'basalt-causeway-token-warning',
      text:
        `Stored in plain text in ${this.app.vault.configDir}/plugins/basalt-causeway/data.json — inside this ` +
        `vault. It is never published: ${this.app.vault.configDir}/** is excluded and the push path refuses ` +
        'any tree containing it. Scope the token to this single repo and give it an expiry anyway.',
    });

    new Setting(containerEl).setName('Triggers').setHeading();

    new Setting(containerEl)
      .setName('Sync automatically')
      .setDesc('Publish after you stop editing. Manual sync always works regardless.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.persist();
        }),
      );

    new Setting(containerEl)
      .setName('Settle window')
      .setDesc('Seconds of no edits before an automatic sync. Too short and every keystroke becomes a commit Basalt must re-download.')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.settleMs / 1000))
          .onChange(async (value) => {
            const secs = Number(value);
            if (!Number.isFinite(secs) || secs < 1) return;
            this.plugin.settings.settleMs = Math.round(secs * 1000);
            await this.plugin.persist();
          }),
      );

    new Setting(containerEl)
      .setName('Check for remote changes')
      .setDesc('Minutes between polls for changes pushed from Basalt. 0 disables it — GitHub cannot notify us.')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.pullIntervalMs / 60000))
          .onChange(async (value) => {
            const mins = Number(value);
            if (!Number.isFinite(mins) || mins < 0) return;
            this.plugin.settings.pullIntervalMs = Math.round(mins * 60000);
            await this.plugin.persist();
          }),
      );

    new Setting(containerEl).setName('Files').setHeading();

    new Setting(containerEl)
      .setName('Exclude')
      .setDesc(
        'One glob per line. Adding a pattern also *unpublishes* files it now matches — they are ' +
          `deleted from the repo on the next sync (not from its history). Removing ${this.app.vault.configDir}/** ` +
          'has no effect: both directions reject those paths regardless of this list.',
      )
      .addTextArea((area) => {
        area.inputEl.rows = 7;
        area.setValue(this.plugin.settings.exclude.join('\n')).onChange(async (value) => {
          this.plugin.settings.exclude = value.split('\n').map((line) => line.trim());
          await this.plugin.persist();
        });
      })
      .addExtraButton((button) =>
        button
          .setIcon('rotate-ccw')
          .setTooltip('Restore defaults')
          .onClick(async () => {
            this.plugin.settings.exclude = defaultExclude(this.app.vault.configDir);
            await this.plugin.persist();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('Publish Dataview results')
      .setDesc(
        'A dataview block holds a query, not an answer — Basalt has no query engine, so those notes arrive blank. ' +
          'With this on, the published copy carries the rendered table instead. Your note keeps the live query; ' +
          'only what reaches the repo changes. Such notes become publish-only: remote edits to them are not applied.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.bakeDataview).onChange(async (value) => {
          this.plugin.settings.bakeDataview = value;
          await this.plugin.persist();
        }),
      );

    new Setting(containerEl)
      .setName('Show habit trackers as calendars')
      .setDesc(
        'A tracker created in Basalt is a checklist with one dated line per day. In reading view, ' +
          'draw a whole month of them as a calendar you can tick — the same view Basalt shows on the ' +
          'phone. The file is unchanged either way, and a list that is not a full month is left alone.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.habitCalendar).onChange(async (value) => {
          this.plugin.settings.habitCalendar = value;
          await this.plugin.persist();
          // The reading-view half re-reads the setting on its next render for free. The editor half
          // is a CodeMirror field that only rebuilds on a document or selection change, so without
          // this the grid would linger in Live Preview until the next keystroke.
          this.app.workspace.updateOptions();
        }),
      );

    new Setting(containerEl)
      .setName('Maximum file size')
      .setDesc('Megabytes. Larger files are skipped with a notice; GitHub would reject them anyway.')
      .addText((text) =>
        text
          .setValue(String(Math.round(this.plugin.settings.maxFileBytes / 1024 / 1024)))
          .onChange(async (value) => {
            const mb = Number(value);
            if (!Number.isFinite(mb) || mb <= 0) return;
            this.plugin.settings.maxFileBytes = Math.round(mb * 1024 * 1024);
            await this.plugin.persist();
          }),
      );

    new Setting(containerEl).setName('Maintenance').setHeading();

    void this.refreshViewer();

    new Setting(containerEl)
      .setName('Sync history')
      .setDesc(
        'What the last 50 syncs did — pushed, pulled, conflicts, and the reason for any failure. ' +
          'A sync reports itself in a Notice that disappears; this is where it stays.',
      )
      .addButton((button) =>
        button
          .setButtonText('View')
          .onClick(() => new HistoryModal(this.app, this.plugin.history).open()),
      );

    new Setting(containerEl)
      .setName('Reset sync baseline')
      .setDesc(
        'Forget what the two sides last agreed on. The next sync republishes everything and proposes no deletions. ' +
          'It does not clear conflicts — a file that differs on both sides still differs, and will be reported again. ' +
          'Use "Keep my version" for that.',
      )
      .addButton((button) =>
        button
          .setButtonText('Reset')
          // Deprecated in favour of `setDestructive()`, which is `@since 1.13.0` — above this
          // plugin's `minAppVersion` of 1.6.6, so adopting it would make the button throw for
          // everyone below that rather than merely look different. `setWarning` is deprecated,
          // not removed, and still renders. Revisit when the floor reaches 1.13.0.
          .setWarning()
          .onClick(async () => {
            await this.plugin.resetBaseline();
            this.display();
          }),
      );
  }

  // ---- connect ---------------------------------------------------------------

  /**
   * The top of the tab: who the token belongs to, and one button that fills in all three
   * repository fields from GitHub rather than from the user's memory.
   */
  private renderConnect(containerEl: HTMLElement): void {
    const { settings } = this.plugin;

    const status = new Setting(containerEl).setName('GitHub account');

    if (!settings.token) {
      status.setDesc('Not connected. Choose an account below, or paste a token.');
      this.renderLocalAccounts(containerEl);
      return;
    }

    status.setDesc(
      this.viewer ? `Signed in as ${this.viewer.login}` : 'Checking which account this token belongs to…',
    );

    status.addButton((button) =>
      button
        .setButtonText('Choose repository…')
        .setCta()
        .onClick(async () => {
          button.setDisabled(true).setButtonText('Loading…');
          try {
            await this.openRepoPicker();
          } finally {
            button.setDisabled(false).setButtonText('Choose repository…');
          }
        }),
    );
  }

  /** Fetch what the current token can write to, and let the user pick one. */
  private async openRepoPicker(): Promise<void> {
    const { settings } = this.plugin;
    try {
      const { repos, truncated } = await fetchWritableRepos({
        transport: obsidianTransport,
        token: settings.token,
      });

      if (repos.length === 0) {
        new Notice('Basalt Causeway: this token cannot write to any repository.');
        return;
      }

      new RepoPicker(this.app, repos, truncated, (repo) => {
        // All three together, from one response — see the comment in `repoPicker.ts`.
        settings.owner = repo.owner;
        settings.repo = repo.name;
        settings.branch = repo.defaultBranch;
        void this.plugin.persist().then(() => this.display());
      }).open();
    } catch (err) {
      new Notice(`Basalt Causeway: ${describeError(err)}`);
    }
  }

  /**
   * Offer the accounts `gh` has already authenticated here.
   *
   * Absent entirely when there are none — on mobile, or on a machine that has never run `gh` —
   * rather than shown as a disabled control explaining what the user is missing.
   */
  private renderLocalAccounts(containerEl: HTMLElement): void {
    // `Platform.isDesktopApp` first, even though `discoverLocalAccounts()` already returns [] on
    // a platform without Node. The redundancy is deliberate: it states the boundary in a form
    // that is greppable, so a reader — or a plugin reviewer checking that an
    // `isDesktopOnly: false` plugin never reaches for Node on mobile — sees it here rather than
    // having to trace a runtime guard three files away.
    if (!Platform.isDesktopApp) return;

    this.localAccounts ??= discoverLocalAccounts();
    if (this.localAccounts.length === 0) return;

    const setting = new Setting(containerEl)
      .setName('Use an account from this machine')
      .setDesc(
        `${this.localAccounts.length} account(s) signed in with the GitHub CLI. ` +
          'Convenient, but a CLI token carries broad scopes across every repository you can reach — ' +
          'prefer a fine-grained token scoped to the vault repo for anything long-lived.',
      );

    setting.addButton((button) =>
      button.setButtonText('Choose account…').onClick(() => {
        new AccountPicker(this.app, this.localAccounts ?? [], (account) => {
          // The token is fetched from the keychain here, for this one account, only because
          // the user just chose it. Nothing was read up front.
          const token = resolveAccountToken(account);
          if (!token) {
            new Notice(
              `Basalt Causeway: could not read a token for ${account.login}. ` +
                'Run `gh auth login`, or paste a token below.',
            );
            return;
          }

          this.plugin.settings.token = token;
          this.viewer = null;
          void this.plugin.persist().then(async () => {
            // Straight on to the repository picker: adopting an account and then hunting for
            // the next button is the friction this feature exists to remove.
            this.display();
            await this.openRepoPicker();
          });
        }).open();
      }),
    );
  }

  /**
   * Resolve the token to an account name in the background.
   *
   * Deliberately silent on failure: a bad token shows up as "not signed in" here and as a real,
   * actionable error the moment you sync. Opening settings is not the place to raise it.
   */
  /**
   * Read the repo and work out the subfolder, rather than making the user know it.
   *
   * Reads only — it never pushes, and it writes the setting only on a confident match. An
   * ambiguous or empty result reports what it saw and changes nothing: silently moving a vault
   * that was already configured correctly is worse than leaving the field alone.
   */
  private async detectSubfolder(): Promise<void> {
    const { owner, repo, branch, token } = this.plugin.settings;
    if (!owner || !repo || !branch || !token) {
      new Notice('Basalt Causeway: set the repository, branch and token first.');
      return;
    }

    const ctx = { transport: obsidianTransport, owner, repo, token };
    try {
      const head = await readHead(ctx, branch);
      const tree = await readTree(ctx, head.treeSha);

      // The same filter the push path applies, so detection scores the files that actually
      // travel. Counting excluded ones would let `.obsidian` noise decide the answer.
      const excluded = compileExclude(this.plugin.settings.exclude);
      const configDir = this.app.vault.configDir;
      const localPaths = this.app.vault
        .getFiles()
        .map((file) => file.path)
        .filter((path) => !isForbiddenPath(path, configDir) && !excluded(path));

      const detection = detectSubfolder(
        localPaths,
        tree.files.map((file) => file.path),
      );

      // A truncated tree can only *lose* matches, so a confident answer stays trustworthy —
      // but a weak one may be weak only because the evidence was cut off. Say so.
      if (tree.truncated && !detection.confident) {
        new Notice(
          'Basalt Causeway: the repo is too large to list in full, so the subfolder could not be ' +
            'determined reliably. Set it by hand.',
        );
        return;
      }

      if (!detection.confident) {
        new Notice(`Basalt Causeway: ${describeDetection(detection)}`);
        return;
      }

      if (detection.subfolder === this.plugin.settings.subfolder) {
        new Notice(`Basalt Causeway: subfolder is already correct. ${describeDetection(detection)}`);
        return;
      }

      const previous = this.plugin.settings.subfolder || '(repo root)';
      this.plugin.settings.subfolder = detection.subfolder;
      await this.plugin.persist();
      this.display();
      new Notice(
        `Basalt Causeway: subfolder changed from ${previous} to ` +
          `${detection.subfolder || '(repo root)'}. ${describeDetection(detection)} ` +
          'Reset the sync baseline so the next sync compares against the right paths.',
      );
    } catch (err) {
      new Notice(`Basalt Causeway: could not read the repo — ${describeError(err)}`);
    }
  }

  private async refreshViewer(): Promise<void> {
    const { token } = this.plugin.settings;
    if (!token || this.viewer) return;

    try {
      this.viewer = await fetchViewer({ transport: obsidianTransport, token });
      this.display();
    } catch {
      // Leave `viewer` null; the description stays neutral.
    }
  }
}
