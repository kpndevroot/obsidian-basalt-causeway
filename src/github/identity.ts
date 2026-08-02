/**
 * Who this token belongs to, and what it can publish to.
 *
 * This is the friction fix. Typing `owner`, `repo` and `branch` by hand is three chances to
 * make a mistake that fails *silently* — a wrong branch in particular syncs happily forever
 * while nothing ever reaches the phone. Asking GitHub instead means the three fields are
 * filled from the same source of truth the sync itself uses.
 */

import { callRoot, type Credentials } from './client';

export type Viewer = {
  login: string;
  name: string | null;
};

/** The account behind the token — used to label it in the UI without ever showing the token. */
export async function fetchViewer(credentials: Credentials): Promise<Viewer> {
  const json = await callRoot<{ login: string; name?: string | null }>(credentials, '/user');
  return { login: json.login, name: json.name ?? null };
}

export type RepoSummary = {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  /** ISO timestamp of the last push, so the picker can lead with what you actually use. */
  pushedAt: string;
};

/** GitHub's maximum. Fewer pages for the same repos. */
const PER_PAGE = 100;

/**
 * Every repository this token can **write** to.
 *
 * Filtered on `permissions.push` rather than shown in full: a repo you can only read is not a
 * publishing target, and offering it produces a 403 several clicks later instead of an absence
 * now. `affiliation` covers repos owned by orgs and ones you were added to, not just your own.
 */
export async function fetchWritableRepos(
  credentials: Credentials,
  maxPages = 3,
): Promise<{ repos: RepoSummary[]; truncated: boolean }> {
  const repos: RepoSummary[] = [];
  let truncated = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await callRoot<
      {
        name: string;
        full_name: string;
        default_branch: string;
        private: boolean;
        pushed_at?: string | null;
        owner: { login: string };
        permissions?: { push?: boolean };
      }[]
    >(
      credentials,
      `/user/repos?per_page=${PER_PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
    );

    for (const repo of batch) {
      if (repo.permissions?.push !== true) continue;
      repos.push({
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        private: repo.private,
        pushedAt: repo.pushed_at ?? '',
      });
    }

    if (batch.length < PER_PAGE) return { repos, truncated: false };
    // A short page means the end; a full one on the last iteration means we stopped early,
    // and the caller must say so rather than present a partial list as the whole account.
    if (page === maxPages) truncated = true;
  }

  return { repos, truncated };
}

/** The branch a repo actually defaults to — so `branch` stops being a thing to guess. */
export async function fetchDefaultBranch(
  credentials: Credentials,
  owner: string,
  repo: string,
): Promise<string> {
  const json = await callRoot<{ default_branch: string }>(
    credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
  return json.default_branch;
}
