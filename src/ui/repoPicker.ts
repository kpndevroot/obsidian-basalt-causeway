/**
 * Pick the publishing target from what the token can actually reach, instead of typing three
 * fields and hoping.
 *
 * Choosing here sets `owner`, `repo` **and** `branch` together from one GitHub response. That
 * last one matters most: the branch is the field whose mistakes are invisible — a wrong value
 * syncs successfully forever while nothing ever arrives on the phone.
 */

import { FuzzySuggestModal, Notice, type App, type FuzzyMatch } from 'obsidian';

import type { RepoSummary } from '../github/identity';

export class RepoPicker extends FuzzySuggestModal<RepoSummary> {
  constructor(
    app: App,
    private readonly repos: RepoSummary[],
    private readonly truncated: boolean,
    private readonly onChoose: (repo: RepoSummary) => void,
  ) {
    super(app);
    this.setPlaceholder('Search your repositories…');
    if (truncated) {
      // Never let a capped list read as "this is everything you have".
      this.setInstructions([
        { command: 'Note', purpose: 'Showing your most recently pushed repositories only' },
      ]);
    }
  }

  getItems(): RepoSummary[] {
    return this.repos;
  }

  getItemText(repo: RepoSummary): string {
    return repo.fullName;
  }

  renderSuggestion(match: FuzzyMatch<RepoSummary>, el: HTMLElement): void {
    const repo = match.item;
    el.createDiv({ text: repo.fullName });
    el.createEl('small', {
      cls: 'basalt-causeway-suggestion-detail',
      text: `${repo.private ? 'private' : 'public'} · default branch ${repo.defaultBranch}`,
    });
  }

  onChooseItem(repo: RepoSummary): void {
    this.onChoose(repo);
    new Notice(`Basalt Causeway: publishing to ${repo.fullName}@${repo.defaultBranch}.`);
  }
}
