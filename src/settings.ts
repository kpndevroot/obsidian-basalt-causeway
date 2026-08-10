import {
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  type App,
  type SettingDefinitionItem,
} from 'obsidian';

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
 * Every user-facing string on this tab, in one place.
 *
 * The tab is described **twice** — declaratively in `getSettingDefinitions()` for Obsidian 1.13.0
 * and later, imperatively in `display()` for everything below it — and that is the API's own
 * prescription, not a workaround: `display()` is documented as "a fallback for plugins that need to
 * support Obsidian versions older than 1.13.0", and it is not called at all once the definitions are
 * non-empty. Two descriptions of one tab is therefore the supported shape, and the copy drifting
 * between them is the obvious way it rots. So the copy lives here and the two paths quote it, and
 * every control that is more than a plain field lives in a `fill*` helper both paths call.
 *
 * What is *not* shared is the frame: which rows exist and in what order. That much genuinely differs
 * — a group in one, a heading row in the other — and pretending otherwise would cost more than it
 * saves.
 */
const copy = {
  owner: 'The GitHub user or organisation that owns the repo.',
  repo: 'The repository name, without the owner.',
  branch:
    'Must be the same branch the vault points at in Basalt. A mismatch syncs happily and never arrives.',
  subfolder:
    'Where this vault lives inside the repo. Leave empty to map the vault root to the repo root. ' +
    'Use Detect to read it from the repo — a wrong value is silent: pushes land beside your notes ' +
    'instead of in them, and incoming edits arrive as a new folder rather than reaching the note.',
  token:
    'A fine-grained personal access token with Contents: read and write on this one repository.',
  tokenHint:
    'Already signed in with the GitHub CLI? `gh auth token` prints a token you can paste here. ' +
    'It carries whatever scopes gh was granted, which is broader than this plugin needs.',
  autoSync: 'Publish after you stop editing. Manual sync always works regardless.',
  settle:
    'Seconds of no edits before an automatic sync. Too short and every keystroke becomes a commit Basalt must re-download.',
  pull:
    'Minutes between polls for changes pushed from Basalt. 0 disables it — GitHub cannot notify us.',
  bakeDataview:
    'A dataview block holds a query, not an answer — Basalt has no query engine, so those notes arrive blank. ' +
    'With this on, the published copy carries the rendered table instead. Your note keeps the live query; ' +
    'only what reaches the repo changes. Such notes become publish-only: remote edits to them are not applied.',
  habitCalendar:
    'A tracker created in Basalt is a checklist with one dated line per day. In reading view and Live ' +
    'Preview, draw a whole month of them as a calendar you can tick — the same view Basalt shows on the ' +
    'phone. The file is unchanged either way, and a list that is not a full month is left alone.',
  maxFileSize:
    'Megabytes. Larger files are skipped with a notice; GitHub would reject them anyway.',
  history:
    'What the last 50 syncs did — pushed, pulled, conflicts, and the reason for any failure. ' +
    'A sync reports itself in a Notice that disappears; this is where it stays.',
  resetBaseline:
    'Forget what the two sides last agreed on. The next sync republishes everything and proposes no deletions. ' +
    'It does not clear conflicts — a file that differs on both sides still differs, and will be reported again. ' +
    'Use "Keep my version" for that.',
  localAccounts:
    'Accounts already signed in with the GitHub CLI. ' +
    'Convenient, but a CLI token carries broad scopes across every repository you can reach — ' +
    'prefer a fine-grained token scoped to the vault repo for anything long-lived.',
  localAccountsCount: (count: number) => `${count} account(s) signed in with the GitHub CLI. `,
  exclude: (configDir: string) =>
    'One glob per line. Adding a pattern also *unpublishes* files it now matches — they are ' +
    `deleted from the repo on the next sync (not from its history). Removing ${configDir}/** ` +
    'has no effect: both directions reject those paths regardless of this list.',
  tokenWarning: (configDir: string) =>
    `Stored in plain text in ${configDir}/plugins/basalt-causeway/data.json — inside this ` +
    `vault. It is never published: ${configDir}/** is excluded and the push path refuses ` +
    'any tree containing it. Scope the token to this single repo and give it an expiry anyway.',
} as const;

/**
 * The keys `getControlValue` / `setControlValue` speak.
 *
 * Mostly the settings' own names, plus three that are deliberately *not*: the tab shows seconds,
 * minutes and megabytes where the settings hold milliseconds and bytes. The declarative API binds a
 * control to one key and one value, so the conversion has to live at the boundary — which is where
 * it always lived, previously spelled out inline in each `onChange`.
 */
type ControlKey =
  | 'owner'
  | 'repo'
  | 'branch'
  | 'autoSync'
  | 'bakeDataview'
  | 'habitCalendar'
  | 'settleSeconds'
  | 'pullMinutes'
  | 'maxFileMb';

export class BasaltCausewaySettingTab extends PluginSettingTab {
  /** Cached for the session so reopening settings does not re-hit the API. */
  private viewer: Viewer | null = null;

  /**
   * Set when a viewer lookup failed, cleared when the token changes.
   *
   * Without it the guard is only `!token || this.viewer`, so a token GitHub rejects leaves `viewer`
   * null forever and every re-render of the tab fires another request — and this tab re-renders on
   * each keystroke in a text field. Failing once is silent by design; failing once per keystroke is
   * a request storm against an endpoint that is already refusing us.
   */
  private viewerFailed = false;

  /**
   * Read once per tab open, not per render: both render paths re-run on state changes, and
   * touching the filesystem each time would be wasteful for a list that cannot move while the tab
   * is open.
   */
  private localAccounts: LocalAccount[] | null = null;

  constructor(
    app: App,
    private readonly plugin: BasaltCausewayPlugin,
  ) {
    super(app, plugin);
  }

  // ---- declarative (Obsidian 1.13.0+) ----------------------------------------

  /**
   * The tab, declared.
   *
   * The reason to have this at all is search: a tab built only in `display()` does not appear in
   * Obsidian's settings search on 1.13.0 or later, so a user looking for "habit" or "token" finds
   * nothing and has to know which plugin owns the setting. Declaring the rows is what puts them in
   * the index — `name`, `desc` and `aliases` are what it matches on.
   *
   * Rows that are more than a field are `render`, not `control`: the token carries two hint blocks
   * and a password input, the subfolder owns a Detect button, exclude owns a restore-defaults
   * button, and the connect rows depend on live GitHub state. `render` still carries a name and a
   * description, so those rows are searchable exactly like the plain ones.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const configDir = this.app.vault.configDir;

    return [
      {
        name: 'GitHub account',
        desc: this.connectDesc(),
        aliases: ['sign in', 'connect', 'repository picker'],
        render: (setting) => this.fillConnect(setting),
      },
      {
        name: 'Use an account from this machine',
        desc: copy.localAccounts,
        aliases: ['gh', 'github cli'],
        // Deliberately *not* `() => this.readLocalAccounts().length > 0`, tempting as that is.
        // `getSettingDefinitions()` is called once when the tab is registered — during `onload` —
        // to build the search index, and `visible` is evaluated with it. Discovery reads
        // `hosts.yml` off disk synchronously, so asking here would move a filesystem read into
        // plugin startup for every desktop user, most of whom will never open this tab. The cheap
        // half of the condition lives here and the row hides itself in `render`, which runs when
        // the tab is actually opened — the timing the imperative path always had.
        visible: () => Platform.isDesktopApp && !this.plugin.settings.token,
        render: (setting) => this.fillLocalAccounts(setting),
      },

      {
        type: 'group',
        heading: 'Repository',
        items: [
          {
            name: 'Owner',
            desc: copy.owner,
            control: { type: 'text', key: 'owner', placeholder: 'kpndevroot' },
          },
          {
            name: 'Repository',
            desc: copy.repo,
            control: { type: 'text', key: 'repo', placeholder: 'my-vault' },
          },
          {
            name: 'Branch',
            desc: copy.branch,
            control: { type: 'text', key: 'branch', placeholder: 'main' },
          },
          {
            name: 'Subfolder',
            desc: copy.subfolder,
            aliases: ['path', 'detect'],
            render: (setting) => this.fillSubfolder(setting),
          },
        ],
      },

      {
        type: 'group',
        heading: 'Authentication',
        items: [
          {
            name: 'GitHub token',
            desc: copy.token,
            aliases: ['pat', 'personal access token', 'password'],
            render: (setting) => this.fillToken(setting),
          },
        ],
      },

      {
        type: 'group',
        heading: 'Triggers',
        items: [
          {
            name: 'Sync automatically',
            desc: copy.autoSync,
            control: { type: 'toggle', key: 'autoSync' },
          },
          {
            name: 'Settle window',
            desc: copy.settle,
            control: { type: 'number', key: 'settleSeconds', min: 1, defaultValue: 5 },
          },
          {
            name: 'Check for remote changes',
            desc: copy.pull,
            aliases: ['poll', 'pull'],
            control: { type: 'number', key: 'pullMinutes', min: 0, defaultValue: 0 },
          },
        ],
      },

      {
        type: 'group',
        heading: 'Files',
        items: [
          {
            name: 'Exclude',
            desc: copy.exclude(configDir),
            aliases: ['ignore', 'glob'],
            render: (setting) => this.fillExclude(setting),
          },
          {
            name: 'Publish Dataview results',
            desc: copy.bakeDataview,
            aliases: ['bake', 'query'],
            control: { type: 'toggle', key: 'bakeDataview' },
          },
          {
            name: 'Show habit trackers as calendars',
            desc: copy.habitCalendar,
            aliases: ['habit', 'calendar', 'tracker'],
            control: { type: 'toggle', key: 'habitCalendar' },
          },
          {
            name: 'Maximum file size',
            desc: copy.maxFileSize,
            control: { type: 'number', key: 'maxFileMb', min: 1, defaultValue: 25 },
          },
        ],
      },

      {
        type: 'group',
        heading: 'Maintenance',
        items: [
          {
            name: 'Sync history',
            desc: copy.history,
            aliases: ['log'],
            render: (setting) => this.fillHistory(setting),
          },
          {
            name: 'Reset sync baseline',
            desc: copy.resetBaseline,
            render: (setting) => this.fillResetBaseline(setting),
          },
        ],
      },
    ];
  }

  /**
   * Read one control's value.
   *
   * Overridden rather than inherited because three of the keys are not settings at all: the tab
   * talks in seconds, minutes and megabytes.
   */
  getControlValue(key: string): unknown {
    const settings = this.plugin.settings;
    switch (key as ControlKey) {
      case 'settleSeconds':
        return settings.settleMs / 1000;
      case 'pullMinutes':
        return settings.pullIntervalMs / 60000;
      case 'maxFileMb':
        return Math.round(settings.maxFileBytes / 1024 / 1024);
      default:
        return settings[key as keyof typeof settings];
    }
  }

  /**
   * Write one control's value.
   *
   * **Must** be overridden, and not only for the unit conversions. `data.json` holds the settings,
   * the sync baseline and the history in one object, and the inherited implementation persists the
   * settings alone — which would drop the other two on the next keystroke in a text field, losing
   * what the two sides last agreed on and making the following sync republish the whole vault.
   * `persist()` is the only writer that knows about all three.
   */
  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    // Bound before the switch, not cast inside it: switching on `key as ControlKey` narrows the
    // expression and not the variable, so the case bodies would still see a bare `string`.
    const control = key as ControlKey;

    switch (control) {
      case 'owner':
      case 'repo':
      case 'branch':
        settings[control] = String(value).trim();
        break;
      case 'autoSync':
      case 'bakeDataview':
      case 'habitCalendar':
        settings[control] = Boolean(value);
        break;
      case 'settleSeconds':
        settings.settleMs = Math.round(Number(value) * 1000);
        break;
      case 'pullMinutes':
        settings.pullIntervalMs = Math.round(Number(value) * 60000);
        break;
      case 'maxFileMb':
        settings.maxFileBytes = Math.round(Number(value) * 1024 * 1024);
        break;
      default:
        return;
    }

    await this.plugin.persist();
    // Cheap and unconditional: only the habit toggle needs it, and branching on the key here would
    // be a second place to remember that. See the same call in `display()`.
    if (key === 'habitCalendar') this.app.workspace.updateOptions();
  }

  // ---- imperative fallback (below 1.13.0) ------------------------------------

  /**
   * The same tab, built by hand.
   *
   * Dead on 1.13.0 and later — Obsidian renders from `getSettingDefinitions()` instead and never
   * calls this. It exists for the versions between this plugin's `minAppVersion` of 1.6.6 and that
   * floor, and it should be deleted the day the floor moves.
   */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.fillConnect(new Setting(containerEl).setName('GitHub account').setDesc(this.connectDesc()));
    if (Platform.isDesktopApp && !this.plugin.settings.token) {
      // `fillLocalAccounts` removes the row itself when `gh` has none, so the two paths agree on
      // when it appears without either one duplicating the rule.
      this.fillLocalAccounts(
        new Setting(containerEl).setName('Use an account from this machine').setDesc(copy.localAccounts),
      );
    }

    new Setting(containerEl).setName('Repository').setHeading();

    new Setting(containerEl)
      .setName('Owner')
      .setDesc(copy.owner)
      .addText((text) =>
        text
          .setPlaceholder('kpndevroot')
          .setValue(this.plugin.settings.owner)
          .onChange((value) => void this.setControlValue('owner', value)),
      );

    new Setting(containerEl)
      .setName('Repository')
      .setDesc(copy.repo)
      .addText((text) =>
        text
          .setPlaceholder('my-vault')
          .setValue(this.plugin.settings.repo)
          .onChange((value) => void this.setControlValue('repo', value)),
      );

    new Setting(containerEl)
      .setName('Branch')
      .setDesc(copy.branch)
      .addText((text) =>
        text
          .setPlaceholder('main')
          .setValue(this.plugin.settings.branch)
          .onChange((value) => void this.setControlValue('branch', value)),
      );

    this.fillSubfolder(new Setting(containerEl).setName('Subfolder').setDesc(copy.subfolder));

    new Setting(containerEl).setName('Authentication').setHeading();

    this.fillToken(new Setting(containerEl).setName('GitHub token').setDesc(copy.token));

    new Setting(containerEl).setName('Triggers').setHeading();

    new Setting(containerEl)
      .setName('Sync automatically')
      .setDesc(copy.autoSync)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange((value) => void this.setControlValue('autoSync', value)),
      );

    new Setting(containerEl)
      .setName('Settle window')
      .setDesc(copy.settle)
      .addText((text) =>
        text.setValue(String(this.plugin.settings.settleMs / 1000)).onChange((value) => {
          const secs = Number(value);
          if (!Number.isFinite(secs) || secs < 1) return;
          void this.setControlValue('settleSeconds', secs);
        }),
      );

    new Setting(containerEl)
      .setName('Check for remote changes')
      .setDesc(copy.pull)
      .addText((text) =>
        text.setValue(String(this.plugin.settings.pullIntervalMs / 60000)).onChange((value) => {
          const mins = Number(value);
          if (!Number.isFinite(mins) || mins < 0) return;
          void this.setControlValue('pullMinutes', mins);
        }),
      );

    new Setting(containerEl).setName('Files').setHeading();

    this.fillExclude(
      new Setting(containerEl)
        .setName('Exclude')
        .setDesc(copy.exclude(this.app.vault.configDir)),
    );

    new Setting(containerEl)
      .setName('Publish Dataview results')
      .setDesc(copy.bakeDataview)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.bakeDataview)
          .onChange((value) => void this.setControlValue('bakeDataview', value)),
      );

    new Setting(containerEl)
      .setName('Show habit trackers as calendars')
      .setDesc(copy.habitCalendar)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.habitCalendar)
          .onChange((value) => void this.setControlValue('habitCalendar', value)),
      );

    new Setting(containerEl)
      .setName('Maximum file size')
      .setDesc(copy.maxFileSize)
      .addText((text) =>
        text
          .setValue(String(Math.round(this.plugin.settings.maxFileBytes / 1024 / 1024)))
          .onChange((value) => {
            const mb = Number(value);
            if (!Number.isFinite(mb) || mb <= 0) return;
            void this.setControlValue('maxFileMb', mb);
          }),
      );

    new Setting(containerEl).setName('Maintenance').setHeading();

    void this.refreshViewer();

    this.fillHistory(new Setting(containerEl).setName('Sync history').setDesc(copy.history));
    this.fillResetBaseline(
      new Setting(containerEl).setName('Reset sync baseline').setDesc(copy.resetBaseline),
    );
  }

  // ---- rows both paths share --------------------------------------------------

  /**
   * Re-render whichever path is live.
   *
   * `display()` rebuilds the tab imperatively; `update()` re-reads the definitions and does the
   * same declaratively. Calling both is safe — on 1.13.0+ `display()` is never invoked, and below
   * it `update()` does not exist to be called, which is why it is reached defensively.
   */
  private rerender(): void {
    if (typeof this.update === 'function') this.update();
    else this.display();
  }

  private connectDesc(): string {
    if (!this.plugin.settings.token) {
      return 'Not connected. Choose an account below, or paste a token.';
    }
    return this.viewer
      ? `Signed in as ${this.viewer.login}`
      : 'Checking which account this token belongs to…';
  }

  /** The one button that fills in all three repository fields from GitHub, not from memory. */
  private fillConnect(setting: Setting): void {
    void this.refreshViewer();
    if (!this.plugin.settings.token) return;

    setting.addButton((button) =>
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

  private fillSubfolder(setting: Setting): void {
    setting
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
  }

  private fillToken(setting: Setting): void {
    setting.addText((text) => {
      text.inputEl.type = 'password';
      text
        .setPlaceholder('github_pat_…')
        .setValue(this.plugin.settings.token)
        .onChange(async (value) => {
          this.plugin.settings.token = value.trim();
          // A new token is a different account until proven otherwise — including a different
          // answer to whether the lookup works, so the failure flag clears with it.
          this.viewer = null;
          this.viewerFailed = false;
          await this.plugin.persist();
          void this.refreshViewer();
        });
    });

    setting.descEl.createDiv({ cls: 'basalt-causeway-hint', text: copy.tokenHint });

    // Stated plainly and permanently, because the storage location is genuinely hazardous:
    // data.json lives inside the vault this plugin publishes. The exclude filter and the
    // hard assertion in plan.ts keep it out of every commit, but the user still deserves to
    // know where their token sits and to scope it accordingly.
    setting.descEl.createDiv({
      cls: 'basalt-causeway-token-warning',
      text: copy.tokenWarning(this.app.vault.configDir),
    });
  }

  private fillExclude(setting: Setting): void {
    setting
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
            this.rerender();
          }),
      );
  }

  private fillHistory(setting: Setting): void {
    setting.addButton((button) =>
      button
        .setButtonText('View')
        .onClick(() => new HistoryModal(this.app, this.plugin.history).open()),
    );
  }

  private fillResetBaseline(setting: Setting): void {
    setting.addButton((button) =>
      button
        .setButtonText('Reset')
        // Deprecated in favour of `setDestructive()`, which is `@since 1.13.0` — above this
        // plugin's `minAppVersion` of 1.6.6, so adopting it would make the button throw for
        // everyone below that rather than merely look different. `setWarning` is deprecated,
        // not removed, and still renders. This helper is shared by both render paths, so it has
        // to hold to the lower floor. Revisit when `minAppVersion` reaches 1.13.0.
        .setWarning()
        .onClick(async () => {
          await this.plugin.resetBaseline();
          this.rerender();
        }),
    );
  }

  /**
   * The accounts `gh` has already authenticated here, or none.
   *
   * `Platform.isDesktopApp` first, even though `discoverLocalAccounts()` already returns [] on a
   * platform without Node. The redundancy is deliberate: it states the boundary in a form that is
   * greppable, so a reader — or a plugin reviewer checking that an `isDesktopOnly: false` plugin
   * never reaches for Node on mobile — sees it here rather than having to trace a runtime guard
   * three files away.
   */
  private readLocalAccounts(): LocalAccount[] {
    if (!Platform.isDesktopApp) return [];
    this.localAccounts ??= discoverLocalAccounts();
    return this.localAccounts;
  }

  private fillLocalAccounts(setting: Setting): void {
    const accounts = this.readLocalAccounts();
    // Absent entirely when there are none — on a machine that has never run `gh` — rather than
    // shown as a disabled control explaining what the user is missing.
    if (accounts.length === 0) {
      setting.settingEl.remove();
      return;
    }
    setting.setDesc(copy.localAccountsCount(accounts.length) + copy.localAccounts);

    setting.addButton((button) =>
      button.setButtonText('Choose account…').onClick(() => {
        new AccountPicker(this.app, this.readLocalAccounts(), (account) => {
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
          this.viewerFailed = false;
          void this.plugin.persist().then(async () => {
            // Straight on to the repository picker: adopting an account and then hunting for
            // the next button is the friction this feature exists to remove.
            this.rerender();
            await this.openRepoPicker();
          });
        }).open();
      }),
    );
  }

  // ---- work -------------------------------------------------------------------

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
        void this.plugin.persist().then(() => this.rerender());
      }).open();
    } catch (err) {
      new Notice(`Basalt Causeway: ${describeError(err)}`);
    }
  }

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
      this.rerender();
      new Notice(
        `Basalt Causeway: subfolder changed from ${previous} to ` +
          `${detection.subfolder || '(repo root)'}. ${describeDetection(detection)} ` +
          'Reset the sync baseline so the next sync compares against the right paths.',
      );
    } catch (err) {
      new Notice(`Basalt Causeway: could not read the repo — ${describeError(err)}`);
    }
  }

  /**
   * Resolve the token to an account name in the background.
   *
   * Deliberately silent on failure: a bad token shows up as "not signed in" here and as a real,
   * actionable error the moment you sync. Opening settings is not the place to raise it.
   */
  private async refreshViewer(): Promise<void> {
    const { token } = this.plugin.settings;
    if (!token || this.viewer || this.viewerFailed) return;

    try {
      this.viewer = await fetchViewer({ transport: obsidianTransport, token });
      this.rerender();
    } catch {
      // Leave `viewer` null; the description stays neutral. Remembered so this is not retried on
      // every render — a new token clears the flag and asks again.
      this.viewerFailed = true;
    }
  }

  /**
   * Drop the session caches when the tab closes.
   *
   * `viewer` and the failure flag are answers about a token, and the cheapest way to be sure a
   * changed token is re-checked is to stop remembering the old answer once the tab is gone.
   * Re-opening settings costs one `/user` call, which is what it cost before any of this existed.
   */
  hide(): void {
    super.hide();
    this.viewer = null;
    this.viewerFailed = false;
    this.localAccounts = null;
  }
}
