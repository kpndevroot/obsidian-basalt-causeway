import { PluginSettingTab, Setting, type App } from 'obsidian';

import type BasaltSyncPlugin from './main';
import { DEFAULT_EXCLUDE } from './sync/exclude';

export class BasaltSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: BasaltSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

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
      .setDesc('Publish the vault under this path in the repo. Leave empty to map the vault root to the repo root.')
      .addText((text) =>
        text
          .setPlaceholder('(repo root)')
          .setValue(this.plugin.settings.subfolder)
          .onChange(async (value) => {
            this.plugin.settings.subfolder = value.replace(/^\/+|\/+$/g, '');
            await this.plugin.persist();
          }),
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
            await this.plugin.persist();
          });
      });

    // Stated plainly and permanently, because the storage location is genuinely hazardous:
    // data.json lives inside the vault this plugin publishes. The exclude filter and the
    // hard assertion in plan.ts keep it out of every commit, but the user still deserves to
    // know where their token sits and to scope it accordingly.
    token.descEl.createEl('div', {
      cls: 'basalt-sync-token-warning',
      text:
        'Stored in plain text in .obsidian/plugins/basalt-sync/data.json — inside this vault. ' +
        'It is never published: .obsidian/** is excluded and the push path refuses any tree ' +
        'containing it. Scope the token to this single repo and give it an expiry anyway.',
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
      .setDesc('One glob per line. Removing .obsidian/** is not supported — the push path rejects it regardless.')
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
            this.plugin.settings.exclude = [...DEFAULT_EXCLUDE];
            await this.plugin.persist();
            this.display();
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
          .setWarning()
          .onClick(async () => {
            await this.plugin.resetBaseline();
            this.display();
          }),
      );
  }
}
