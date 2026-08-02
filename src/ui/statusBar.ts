/**
 * The status bar item: idle / `⟳ syncing` / `↑3` pending / `⚠ 1 conflict`, click to open the
 * conflict modal.
 *
 * The tooltip always names `owner/repo@branch`. That is not decoration — the plugin's branch
 * and the Basalt vault's branch are independent settings, and a mismatch produces a sync that
 * succeeds forever while nothing ever reaches the phone. Showing the branch is the cheapest
 * way to make that failure visible instead of mysterious.
 */

import type { SyncStatus } from '../sync/engine';
import type { BasaltCausewaySettings } from '../types';

export class StatusBar {
  constructor(
    private readonly el: HTMLElement,
    private readonly onClick: () => void,
  ) {
    this.el.addClass('basalt-causeway-status');
    this.el.onclick = () => this.onClick();
  }

  render(status: SyncStatus, settings: BasaltCausewaySettings): void {
    const target =
      settings.owner && settings.repo
        ? `${settings.owner}/${settings.repo}@${settings.branch}`
        : 'not configured';

    let label: string;
    let tooltip: string;

    if (status.phase === 'syncing') {
      label = '⟳ Basalt';
      tooltip = `${status.message}\n${target}`;
    } else if (status.conflicts.length > 0) {
      label = `⚠ ${status.conflicts.length}`;
      tooltip = `${status.conflicts.length} conflict(s) — click for details\n${target}`;
    } else if (status.phase === 'error') {
      label = '⚠ Basalt';
      tooltip = `${status.message}\n${target}`;
    } else if (status.pending > 0) {
      label = `↑${status.pending}`;
      tooltip = `${status.pending} change(s) not yet published\n${target}`;
    } else {
      label = '✓ Basalt';
      tooltip = `${status.message || 'Up to date'}\n${target}`;
    }

    this.el.setText(label);
    this.el.setAttr('aria-label', tooltip);
    this.el.setAttr('title', tooltip);
  }
}
