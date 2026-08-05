import { Modal, type App } from 'obsidian';

import { isNoOp, summarizeEntry, type SyncHistoryEntry } from '../sync/history';

/**
 * What the plugin has been doing, most recent first.
 *
 * Read-only on purpose. Every button here would be an action taken on the strength of a summary
 * rather than the vault itself, and "re-run that sync" is not a thing that can mean anything —
 * the two sides have moved since.
 */
export class HistoryModal extends Modal {
  constructor(
    app: App,
    private readonly history: readonly SyncHistoryEntry[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Sync history' });

    if (this.history.length === 0) {
      contentEl.createEl('p', {
        text: 'Nothing yet. Every sync from now on is recorded here — what it pushed, what it pulled, and why it failed if it did.',
      });
      return;
    }

    const list = contentEl.createEl('ul', { cls: 'basalt-causeway-history' });
    for (const entry of this.history) {
      const item = list.createEl('li', {
        // Failures and no-ops are the two the eye needs to separate at a glance: one is the
        // thing you opened this list to find, the other is the noise it hides in.
        cls:
          entry.outcome === 'error'
            ? 'basalt-causeway-history-error'
            : isNoOp(entry)
              ? 'basalt-causeway-history-idle'
              : 'basalt-causeway-history-change',
      });

      item.createDiv({
        cls: 'basalt-causeway-history-when',
        // Locale-formatted rather than ISO: this is read by a person, next to notes they wrote.
        text: new Date(entry.at).toLocaleString(),
      });
      item.createDiv({ cls: 'basalt-causeway-history-what', text: summarizeEntry(entry) });

      // The short sha is the one thread from this list back to the repo, so it is worth the row.
      if (entry.commitSha) {
        item.createDiv({
          cls: 'basalt-causeway-history-commit',
          text: `commit ${entry.commitSha.slice(0, 7)}`,
        });
      }

      this.renderChanges(item, entry);
    }
  }

  /**
   * The files themselves, collapsed.
   *
   * Open by default would make a log of fifty runs unscannable — the reason to open this modal is
   * usually to find *which* run misbehaved, and only then which files it touched. `details` gives
   * that second step for free, with no state to track.
   */
  private renderChanges(item: HTMLElement, entry: SyncHistoryEntry): void {
    const changes = entry.changes ?? [];
    if (changes.length === 0) return;

    const dropped = entry.changesTruncated ?? 0;
    const details = item.createEl('details', { cls: 'basalt-causeway-history-files' });
    details.createEl('summary', {
      text: dropped > 0 ? `${changes.length} files shown, ${dropped} more` : `${changes.length} file(s)`,
    });

    const list = details.createEl('ul');
    for (const change of changes) {
      // An arrow rather than the words in and out: the direction is the thing being scanned for,
      // and it has to survive being read at the edge of vision.
      const arrow = change.direction === 'pull' ? '↓' : '↑';
      const verb = change.op === 'add' ? 'added' : change.op === 'delete' ? 'deleted' : 'changed';
      list.createEl('li', { text: `${arrow} ${verb}  ${change.path}` });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
