/**
 * The dry run's output, verbatim from `describePlan`.
 *
 * This ships in the same milestone as push, not as later polish: it is how you verify the
 * exclude filter — that nothing under `.obsidian/` appears — *before* the first real commit
 * puts your GitHub token in a public repo.
 */

import { Modal, type App } from 'obsidian';

export class DryRunModal extends Modal {
  constructor(
    app: App,
    private readonly body: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Basalt Sync — dry run' });
    contentEl.createEl('p', { text: 'Nothing was written. This is exactly what a sync would do:' });
    contentEl.createEl('pre', { text: this.body, cls: 'basalt-sync-dry-run' });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
