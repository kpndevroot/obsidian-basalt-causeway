# Basalt Sync

**Publish your Obsidian vault to a GitHub repo so [Basalt](https://github.com/kpndevroot/basalt) can read it on your phone.**

```
Obsidian (desktop)  ──push──▶  GitHub repo  ──pull──▶  Basalt (phone)
       ▲                                                     │
       └───────────────────── pull ◀─────── push ─────────────┘
```

Basalt already owns the right-hand side: it fetches HEAD, and when the SHA differs from the
live snapshot it downloads the zipball, unpacks, indexes and atomically swaps. The missing
piece was a desktop publisher, because Obsidian has no git. This is it.

The loop is two-way. Notes you write in Obsidian reach the phone; notes you edit in Basalt
come back to the desktop.

## How it works

It talks to **GitHub's Git Data (Trees) API**, not to git.

A full sync is four requests — `GET /git/ref` → `POST /git/trees` → `POST /git/commits` →
`PATCH /git/refs` — because the Trees API accepts entries carrying inline `content` instead of
a pre-uploaded blob. That means **one commit per sync, whatever the file count**, which matters
directly: Basalt's pull is "HEAD changed → download the whole zipball", so a session that
touched thirty notes must produce one new HEAD, not thirty.

It uses `requestUrl()` from the `obsidian` module, which bypasses CORS and touches no Node
API — so there is no git binary, no `fs` shim, no bundled `isomorphic-git`, and the plugin runs
on Obsidian mobile too (`isDesktopOnly: false`).

The cost we accept is **no merge machinery**. Divergence is detected and surfaced, never
guessed at — see [Conflicts](#conflicts).

## Install

Not in the community store yet. Either:

- **BRAT** — add `kpndevroot/obsidian-basalt` as a beta plugin.
- **By hand** — download `main.js`, `manifest.json` and `styles.css` from a
  [release](https://github.com/kpndevroot/obsidian-basalt/releases) into
  `<vault>/.obsidian/plugins/basalt-sync/`, then enable it in Community plugins.

## Setup

1. Create a **fine-grained** personal access token scoped to the single repo, with
   **Contents: read and write**, and give it an expiry. (Already signed in with the GitHub
   CLI? `gh auth token` prints one you can paste — it carries broader scopes than this plugin
   needs, so prefer a fine-grained token for anything long-lived.)
2. Paste it into *Settings → Basalt Sync*. The account name appears once it resolves.
3. Hit **Choose repository…** and pick from the repositories that token can actually write to.
   Owner, repository **and branch** are all filled from GitHub — the branch especially, since
   it is the field whose mistakes are silent.
4. Run **Basalt Sync: dry run** from the command palette. Read the output. Confirm the paths
   are what you expect and that **nothing under `.obsidian/` appears**.
5. Run **Basalt Sync: sync now**.

> [!WARNING]
> Your token is stored in plain text in `.obsidian/plugins/basalt-sync/data.json` — which
> lives inside the very vault this plugin publishes. Three things keep it out of your repo:
> `.obsidian/**` is excluded by default, the exclude filter runs before anything reaches the
> tree builder, and the push path throws unconditionally on any tree entry under `.obsidian/`
> regardless of your settings. Scope the token to one repo and give it an expiry anyway.

**The branch must match the branch your Basalt vault points at.** They are independent
settings, and a mismatch produces a sync that succeeds forever while nothing ever arrives.
The status bar tooltip always names `owner/repo@branch` so you can check at a glance.

## What gets published

Every file in the vault — `getFiles()`, not `getMarkdownFiles()`, because attachments are half
of what makes a note render correctly on the phone — minus the exclude list:

```
.obsidian/**   .trash/**   .git/**   .DS_Store   *.tmp   *.conflict-*
```

Excluding Obsidian's own config is correct, not a limitation: Basalt renders markdown through
its own `markdown-it` pipeline and has no use for your desktop theme, hotkeys or workspace
layout.

Files over 25 MB (configurable) are skipped with a notice — GitHub's blob limits would reject
them anyway, and a 25 MB inline request body is a bad way to find that out.

## Dataview

A ```` ```dataview ```` block holds a **query, not an answer**. Dataview computes the answer at
render time from Obsidian's metadata cache, so the bytes on disk contain nothing to display —
which is why such a note reaches the phone looking empty. Basalt renders markdown with
markdown-it and has no query engine.

So the plugin **bakes** those blocks on the way out (on by default). Your note keeps the live
query; the published copy carries the rendered table, wrapped in an HTML comment so a reader can
tell generated content from prose:

```markdown
<!-- basalt-sync: generated from a dataview query — edit the note in Obsidian -->
| File | Tags |
| ---- | ---- |
| ...  | ...  |
<!-- /basalt-sync -->
```

Three consequences worth knowing:

- **Those notes become publish-only.** What the repo holds for them is a rendered table, so
  writing it back would replace your query with a frozen snapshot of its own output. Incoming
  changes to them are skipped, with a notice; if the remote really did move, it surfaces as a
  conflict rather than being lost.
- **They are re-rendered every sync**, never cached. A query's result depends on the whole
  vault — adding a note elsewhere changes what `TABLE ... FROM #tag` returns while the note
  itself never changes.
- **`dataviewjs` is published as-is.** It is arbitrary JavaScript rendering into a DOM node,
  with no static markdown form, and executing vault code during a sync is not something this
  plugin will do. A query that fails to run is likewise published verbatim — publishing an error
  message into your note would be worse.

Turn it off in settings to publish queries verbatim, at which point those notes sync in both
directions like any other.

## Triggers

| | |
|---|---|
| **Manual** | `Basalt Sync: sync now`, the ribbon icon. Always available. |
| **Auto-push** | Off by default. On, it publishes after a settle window (5 s idle), never per keystroke — a commit per keystroke is a commit storm that makes Basalt re-download the vault each time. |
| **Auto-pull** | Off by default. GitHub cannot notify us, so pulling is a poll or nothing. |

The status bar shows `✓` / `⟳` while syncing / `↑3` pending / `⚠ 1` conflict. Click it for
detail.

## Conflicts

There is no merge, so divergence is detected and reported rather than resolved. A **baseline**
in `data.json` records the last commit both sides agreed on plus the blob sha of every file at
that moment, and each path is classified with the same three-way compare Basalt uses in
`src/sync/editQueue.ts`:

- **`mine`** — the remote already holds our bytes. Nothing to write. Checked *first*, which is
  what makes a sync that died mid-push idempotent on re-run.
- **`base`** — the remote still holds what both sides agreed on. Safe to write over.
- **`diverged`** — neither. Both sides moved.

The same function serves both directions — the side being *overwritten* is the side checked
against the baseline. Pushing asks "may we overwrite GitHub?"; pulling asks "may we overwrite
the vault?".

On `diverged` the **local file is never touched**. The remote version lands beside it as
`<name>.conflict-<shortSha>.md`, a notice fires, and the path is listed in the conflict modal.
Sidecars are excluded from the push, so they never reach the phone as real notes.

**Resolving.** A conflict is remembered in `data.json` and does not resolve itself — that is
the whole point. Two things clear one:

- **Delete the sidecar.** Its presence is the unresolved marker, so removing it means "I looked
  at both versions and dealt with it". Only then does the baseline advance, after which an
  ordinary sync publishes whatever the note now says.
- **"Keep my version"** in the conflict modal, which advances the baseline without you having
  to merge anything. This is the only route out of the one conflict shape that parks no
  sidecar: a note deleted remotely but edited here.

Resetting the baseline is *not* a third route. It forgets the evidence of who moved, not the
disagreement itself, so the two versions still differ and it is still a conflict.

Deletions are driven by the baseline, never by "present on GitHub, absent locally" — so a first
sync against an existing repo can never propose wiping files it did not put there.

## Commit messages

```
vault: 3 changed, 1 added, 1 deleted (via Obsidian) 2026-07-30 14:02
```

The `(via Obsidian)` marker is the deliberate twin of Basalt's own `(via Basalt)` suffix in
`src/github/commitMessages.ts`. Provenance stays readable in `git log` from either device.

## Known interactions

- **Basalt's push queue will report conflicts, and that is correct.** If the phone holds a
  pending edit to a note the desktop just changed, `editQueue`'s pre-push recheck sees
  `diverged` and stops. Expect that conflict to appear on the *phone*, by design.
- **Highlights stay on the phone.** Basalt keeps them in mobile SQLite only. Bringing them into
  the vault needs a `.basalt/` sidecar published by the app — separate work.
- **Basalt pulls the whole repo on any HEAD change.** Batching into one commit reduces pull
  *frequency*, not pull *size*. A vault heavy with attachments is expensive on mobile no matter
  how small your commit was.

## Development

```bash
npm install
npm run dev      # esbuild watch
npm run verify   # typecheck + build + tests
```

Symlink the repo into `<vault>/.obsidian/plugins/basalt-sync/` and use the Hot-Reload plugin.
**Test against a throwaway vault and a throwaway repo** — this thing writes commits.

### Architecture

Nothing under `src/github/` or the planners imports `obsidian`. The HTTP transport is injected,
so the entire network layer, the push planner, the exclude filter and the conflict compare are
tested with plain objects and no mock of the app. `obsidian` appears only in `main.ts`,
`settings.ts`, `ui/` and `sync/engine.ts`.

```
src/
├── main.ts            wiring only
├── settings.ts        PluginSettingTab
├── github/            pure — no `obsidian` import
│   ├── client.ts      injected transport + error mapping
│   ├── trees.ts       push: ref → tree → commit → ref
│   ├── compare.ts     pull: /compare/base...head
│   └── blobSha.ts     sha1("blob <len>\0" + bytes)
├── sync/
│   ├── plan.ts        pure: (local, remote, baseline) → PushPlan
│   ├── conflict.ts    pure: the mine/base/diverged compare
│   ├── exclude.ts     pure: the glob filter that keeps the token out of the repo
│   ├── commitMessages.ts
│   └── engine.ts      impure orchestration, owns the Vault
└── ui/
```

## Prior art

[obsidian-git](https://github.com/Vinzent03/obsidian-git) does auto-commit-and-push today with
zero code, and if it satisfies your round trip you should use it. This plugin exists for what
it does not give you: one commit per sync instead of one per interval tick, no git binary, an
exclude set and error vocabulary matched to Basalt, `(via Obsidian)` provenance pairing with
`(via Basalt)`, and a conflict model that is the same three-way compare as `editQueue`.

## License

MIT
