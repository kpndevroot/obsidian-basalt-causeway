/**
 * Choose from the GitHub accounts already signed in on this machine.
 *
 * The list shows logins and hosts. It never shows a token, not even masked — there is no
 * reason for a credential to reach the screen, and a UI that displays one invites a screenshot.
 */

import { FuzzySuggestModal, type App, type FuzzyMatch } from 'obsidian';

import type { LocalAccount } from '../desktop/ghAccounts';

export class AccountPicker extends FuzzySuggestModal<LocalAccount> {
  constructor(
    app: App,
    private readonly accounts: LocalAccount[],
    private readonly onChoose: (account: LocalAccount) => void,
  ) {
    super(app);
    this.setPlaceholder('Choose a GitHub account from this machine…');
    this.setInstructions([
      { command: 'Note', purpose: 'A GitHub CLI token carries broad scopes across all your repositories' },
    ]);
  }

  getItems(): LocalAccount[] {
    return this.accounts;
  }

  getItemText(account: LocalAccount): string {
    return `${account.login} ${account.host}`;
  }

  renderSuggestion(match: FuzzyMatch<LocalAccount>, el: HTMLElement): void {
    el.createEl('div', { text: match.item.login });
    el.createEl('small', {
      cls: 'basalt-causeway-suggestion-detail',
      text: `${match.item.host} · signed in with the GitHub CLI`,
    });
  }

  onChooseItem(account: LocalAccount): void {
    this.onChoose(account);
  }
}
