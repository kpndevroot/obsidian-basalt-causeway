/**
 * The status bar item: idle / `⟳ syncing` / `↑3` pending / `⚠ 1 conflict`.
 *
 * Left-click opens whatever the current state makes most useful — conflicts when there are any,
 * the sync history when there are not. Right-click opens the full menu. The status bar is the
 * only part of this plugin visible without going looking for it, so it is the right doorway;
 * routing every click to the conflict modal meant that in the normal case — no conflicts — the
 * one obvious affordance opened an empty box.
 *
 * The tooltip always names `owner/repo@branch`. That is not decoration — the plugin's branch
 * and the Basalt vault's branch are independent settings, and a mismatch produces a sync that
 * succeeds forever while nothing ever reaches the phone. Showing the branch is the cheapest
 * way to make that failure visible instead of mysterious.
 */

import type { SyncStatus } from '../sync/engine';
import type { BasaltCausewaySettings } from '../types';

export type StatusBarHandlers = {
  onClick: () => void;
  onContextMenu: (event: MouseEvent) => void;
};

export class StatusBar {
  constructor(
    private readonly el: HTMLElement,
    private readonly handlers: StatusBarHandlers,
  ) {
    this.el.addClass('basalt-causeway-status');
    this.el.onclick = () => this.handlers.onClick();
    this.el.oncontextmenu = (event) => {
      // Otherwise the OS/Electron menu wins and the plugin menu never shows.
      event.preventDefault();
      this.handlers.onContextMenu(event);
    };
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
      tooltip = `${status.conflicts.length} conflict(s) — click for details, right-click for more\n${target}`;
    } else if (status.phase === 'error') {
      label = '⚠ Basalt';
      tooltip = `${status.message}\n${target}`;
    } else if (status.pending > 0) {
      label = `↑${status.pending}`;
      tooltip = `${status.pending} change(s) not yet published\n${target}`;
    } else {
      label = '✓ Basalt';
      tooltip = `${status.message || 'Up to date'} — click for sync history, right-click for more\n${target}`;
    }

    this.el.setText(label);
    this.el.setAttr('aria-label', tooltip);
    this.el.setAttr('title', tooltip);
  }
}
