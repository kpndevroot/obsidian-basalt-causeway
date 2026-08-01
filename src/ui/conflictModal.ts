/**
 * What the user sees after a diverged sync. Deliberately read-only: it lists the affected
 * notes and opens them, and offers no "keep mine / keep theirs" button.
 *
 * Resolution is a human editing decision — the conflicting version is already sitting next to
 * the note as a `.conflict-<sha>` sibling, which is a better diff surface than any modal, and
 * a one-click "keep theirs" would be the exact silent overwrite this whole design exists to
 * prevent.
 */

import { Modal, type App } from 'obsidian';

export class ConflictModal extends Modal {
  constructor(
    app: App,
    private readonly conflicts: string[],
    private readonly lastMessage: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Basalt Sync' });

    if (this.conflicts.length === 0) {
      contentEl.createEl('p', { text: this.lastMessage || 'No conflicts. Everything is published.' });
      return;
    }

    contentEl.createEl('p', {
      text:
        `${this.conflicts.length} note(s) changed on both sides. Your local copies are untouched; ` +
        'the remote version of each sits beside it as a .conflict-<sha> file. Merge by hand, ' +
        'delete the sidecar, then sync again.',
    });

    const list = contentEl.createEl('ul', { cls: 'basalt-sync-conflicts' });
    for (const path of this.conflicts) {
      const item = list.createEl('li');
      const link = item.createEl('a', { text: path, href: '#' });
      link.onclick = (event) => {
        event.preventDefault();
        const file = this.app.vault.getFileByPath(path);
        if (file) {
          void this.app.workspace.getLeaf(false).openFile(file);
          this.close();
        }
      };
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
