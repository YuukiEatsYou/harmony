# AGENTS.md

Guidance for AI coding agents working in this repository. Read this before you
touch anything; it is the fastest way to avoid the traps that have already bitten
us.

Harmony is a self-hosted, single-community Discord alternative with a two-way
Discord bridge. For the pitch see `README.md`; for depth see
`docs/TECHNICAL.md` (internals and the bridge), `docs/API.md` (HTTP and
WebSocket contract) and `docs/DEPLOYMENT.md` (putting it on a server).

`CLAUDE.md` is only a short pointer to this file; keep it that way rather than
growing a second copy that drifts.

## Commands

Requires Node >= 24. The server runs `.ts` directly through Node's type
stripping and uses the built-in `node:sqlite`, so there is no server build step.

```sh
npm install
npm run dev            # server (http://127.0.0.1:8787) + web (http://127.0.0.1:5173)
npm run dev:server     # server only (node --watch)
npm run dev:web        # Vite only
npm run dev:lan        # dev, but the web client listens on all interfaces
npm run build:web      # build the client into apps/web/dist (server serves it in production)
npm start              # production: node apps/server/src/index.ts
npm run typecheck      # tsc for server/shared, svelte-check for web
npm run smoke          # boots a throwaway server and exercises the API end to end
npm run smoke:auth     # login throttling: the per-account and per-address budgets
npm run smoke:bridge   # the Discord bridge against a fake transport
npm run smoke:sfu      # the voice SFU relays RTP between in-process WebRTC peers
npm run smoke:text     # web client pure logic (markdown/link parser, emoji picker, catch-up)
```

There is no linter and no test framework. A smoke script can also be run
directly, for example `node apps/server/scripts/bridge-smoke.mjs`. `npm run smoke`
listens on port 8791; set `HARMONY_SMOKE_PORT` to another port when two runs
might overlap (two checkouts, or several agents at once).

CI (`.github/workflows/ci.yml`) runs typecheck, the client build and every
smoke script on each push and pull request. A red run is a broken branch, not
a flake to rerun: find out why.

## Verify before you claim something works

Never say a change is done on the strength of reading it. Run the checks that
apply:

- Any change: `npm run typecheck`.
- Web client: `npm run build:web` (this is also what catches CSS the minifier
  would drop) and `npm run smoke:text` when parsing or pure logic is involved.
- Server or bridge: `npm run smoke` and, when the bridge is involved,
  `npm run smoke:bridge`. Login or auth changes: also `npm run smoke:auth`.

A green build is not a substitute for exercising the feature. If the change is
visual, you cannot see the UI: say what you changed, what you verified
mechanically, and hand the visual check to the user explicitly.

## Commits, branches and pull requests

The project is a GitHub **fork → branch → pull request** repository. The company
fork (`origin`) is ours to write to; the canonical repository (`upstream`) is
read-only for the company account. Every change lands through a branch and a
pull request against `upstream/main`. The full command reference, the account
handle and the one-time setup live in `docs/GIT_WORKFLOW.md`.

### Remotes

- `origin` — the company fork, `https://github.com/hrmnychat-hue/harmony`
  (GitHub account `hrmnychat-hue`). This is the only remote we push to.
- `upstream` — the canonical repository,
  `https://github.com/YuukiEatsYou/harmony`. We have pull access only and never
  push to it.

### Committing and versioning

Unless the user tells you otherwise, you own committing and version bumping. Do
not wait to be asked, and do not leave finished work uncommitted.

- Bump the version with every user-facing change. The single source is
  `HARMONY_VERSION` in `packages/shared/src/constants.ts` (the client, server and
  bridge all read it). Patch for fixes, minor for features, and leave the major
  number to the owner. Bump it in the same commit as the change it describes.
- Keep the changelog in step with it. A user-facing change also updates
  `CHANGELOG` in `packages/shared/src/changelog.ts`, the notes every member is
  shown once in the "What's new" dialog after an update. A branch adds one entry
  at the top for the version it ships as, or extends its own top entry if it
  already added one. Write it in members' words: short plain sentences about
  what they can now do or what was fixed, with no internals. Only the newest
  entry is ever shown, so it has to cover everything user-facing since the
  previous entry. `npm run smoke:text` fails when the list is out of order or
  its newest entry is for a version newer than `HARMONY_VERSION`.
- Write commit messages that stand on their own: a short imperative subject,
  then paragraphs explaining what changed and why, including the reasoning a
  future reader would otherwise have to reconstruct. Prefer several paragraphs
  over one dense line.
- Keep backticks out of commit messages and the shell command that carries them;
  they are a quoting hazard in a one-liner. Use plain words.
- Commit one coherent idea at a time. Do not bundle unrelated work just because
  it is convenient.
- Never force-push, and never commit to `main` on either remote.

### Branches

Main is what people pull to install or update, so it has to be a state someone
has actually run, and it is only ever advanced by a merge upstream.

- Start every piece of work on a branch off `upstream/main`. Fetch it first so
  the branch is current:

  ```sh
  git fetch upstream
  git switch -c <branch> upstream/main
  ```

- Name the branch after the version it is expected to ship as: `v<version>`, for
  example `v1.25.0`. Do the commits and the version bump on the branch. If the
  planned version moves while you are still on the branch, the branch name does
  not have to follow it.
- A change that ships no code and no user-visible behavior, such as an edit to
  this file or to `docs/`, has no version to name the branch after: use
  `docs/<slug>` or `chore/<slug>` instead.

### Security review gate

Every pull request that changes code must carry a security verdict from
**Ghislaine**, the Cyber Security Consultant, before it is opened against
`upstream/main`. She is an independent gate - she reports to the CEO, not to the
engineer who wrote the change - and only a branch whose changed paths are all
Markdown (`*.md`) or `LICENSE` skips her review.

When a branch is ready, push it to the fork, then open a security-review child
issue assigned to Ghislaine carrying the base and head SHA, `git diff --stat`
and `--name-only`, a per-surface high-risk checklist, the dependency,
route/permission and data/PII deltas, the verification and not-verified
statements, and the intended pull request body. Block your own task on that
review issue and wait for her verdict before opening the pull request. The
verdict is bound to the head SHA, so do not rebase or force-push while it is
under review, and open a fresh review issue after a BLOCK fix.
`docs/GIT_WORKFLOW.md` has the exact steps; `docs/SECURITY_REVIEW.md` has her
protocol and verdict format.

### Pushing and opening the pull request

Push the branch to the fork, then open a pull request against `upstream/main`:

```sh
git push -u origin <branch>
```

The company GitHub account cannot use the web UI to target the canonical repo,
so open the pull request through the API (`GITHUB_TOKEN` is already in the
agent environment):

```sh
curl -sS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/YuukiEatsYou/harmony/pulls \
  -d '{"title":"<title>","head":"hrmnychat-hue:<branch>","base":"main","body":"<body>"}'
```

Write the pull request body for a reviewer who will not read the diff first: a
short summary, implementation notes, the exact verification you ran, and risks.
The bundled `github-pr-workflow` skill has the full shape.

### Review and merge

- The owner (`YuukiEatsYou`) reviews and merges pull requests into upstream
  `main`. The company account has pull-only access upstream, so agents cannot
  merge or push upstream.
- Do not merge your own pull request. Push review fixes as new commits on the
  same branch and re-request review; reply to every review comment.
- Once a pull request is merged, delete the branch (locally and on the fork) and
  rebuild local `main` from `upstream/main` rather than pushing it.

### Upstream publication rule (YUC-RULE-003)

No change may dead-end on a local branch. Every task that changes this
repository must publish its change upstream before it can be called done: the
branch is pushed to the fork (`origin`) and a pull request is opened against
`upstream/main`. Opening the pull request is ours; merging is the owner's, so
"waiting on the owner to merge" is a valid `in_review`, but "the branch only
exists on my machine" is never a finished state.

- A change is not done until its branch is on the fork and its pull request is
  open. Record the branch name and the pull request URL on the task.
- If the change cannot be published yet - no push access, an unmerged
  dependency, a security gate still pending - block the task with a named owner
  and the exact next action instead of reporting completion.
- A run that ends early does not drop the work: the next run publishes the
  branch, or retires it explicitly with a recorded reason.
- Never silently delete another agent's unpublished branch. Publish it, or
  retire a superseded branch on purpose with the reason recorded and flag it to
  the CTO.

## Keep the docs current

The documentation is part of the work, not an afterthought. As the project
evolves, keep it true, in the same commit as the change it describes:

- `AGENTS.md` (this file) — update it whenever a command, convention, gotcha or
  working agreement changes. If you learn something the hard way, write it down
  here so the next agent does not repeat it.
- `README.md` — the pitch and quick start aimed at a non-technical owner. Keep
  it accurate when a feature changes what the product does or how it is set up.
- `docs/` — `TECHNICAL.md` (internals and the bridge), `API.md` (the HTTP and
  WebSocket contract), `DEPLOYMENT.md` (running it on a server) and
  `GIT_WORKFLOW.md` (the fork, branch and pull-request flow). Update the relevant
  one when behaviour or a contract changes.

If a change makes an existing statement false, fixing the docs is part of
finishing the change, not a follow-up.

## Layout

npm workspaces monorepo; every package is ESM TypeScript.

- `packages/shared` (`@harmony/shared`) — the contract between server and client:
  types, the permission bitfield (`permissions.ts`), the gateway protocol
  (`gateway.ts`), zod schemas (`schemas.ts`), mention/embed/slowmode helpers, the
  shared constants, the theme derivation (`theme.ts`) and the version. Change
  shared types first, then both sides.
- `apps/server` — Fastify HTTP API, a WebSocket gateway and SQLite.
- `apps/web` — Svelte 5 + Vite single-page client.
- `docs/` — user and operator documentation. `REVIEW_NOTES.md` (gitignored) is
  scratch.

## Server conventions

- Local imports use explicit `.ts` extensions; this is required by Node's type
  stripping. Avoid TypeScript syntax that needs transformation: no `enum`, no
  parameter properties, no namespaces. Use `import type` for type-only imports
  (`verbatimModuleSyntax` is on). `strict` and `noUncheckedIndexedAccess` are on.
- Layered by feature: `routes/*` are HTTP handlers, the domain folders
  (`messages/`, `channels/`, `moderation/`, `access/`, `bridge/`, `gifs/`,
  `update/`, ...) hold the logic, and `db/*` holds one raw-SQL file per table group.
  `access/service.ts` is where permission checks resolve.
- Schema changes: append a new entry to `db/migrations.ts`. Never edit a shipped
  migration.
- Account kind is `users.account_type` (`user`, `bot` or `ghost`), never the legacy
  `is_bot` column. `is_bot` is backfilled and kept in step on insert but read
  nowhere, so an older binary still starts after a rollback; do not start reading
  it. A Discord stand-in is a `ghost`; a real bot is a `bot` with its own
  `bot_permissions` bitfield and no roles, authenticated by a token in
  `bot_tokens`, and it may register slash commands in `bot_commands`. See
  `bots/service.ts` and `commands/service.ts`.
- Realtime: `gateway/index.ts` handles connections; `realtime/hub.ts` broadcasts
  to clients.
- Uploads are content-addressed by SHA-256 under the data directory (default
  `data/`, override with `HARMONY_DATA_DIR`). DB rows reference blobs by hash and
  retention prunes unreferenced ones. There is a facility for learning and
  storing external emoji and sticker images so they keep working after a restart.
- The Discord bridge lives in `bridge/`: `service.ts` is the sync logic against
  the abstract `transport.ts`, and `discordjs.ts` is the real transport, which is
  why the bridge smoke test can run against a fake. Discord users appear as
  stand-in accounts and backfilled history is never broadcast live. Linking a
  Discord id merges the stand-in in one transaction; signing in with Discord
  creates a passwordless account (`NO_PASSWORD` sentinel, surfaced as
  `User.hasPassword`) and can adopt a stand-in the same way.
- Search is a deliberate `LIKE` substring scan over the channels the viewer can
  see, with no FTS index.
- The first registered account becomes the owner. Env vars (`.env.example`) only
  supply initial defaults; runtime settings live in the DB and are edited in the
  admin panel.

## Web conventions

- Svelte 5 runes. Cross-component state lives in `src/lib/*.svelte.ts` rune
  stores (`chat`, `members`, `session`, `ui`, `profile-card`, ...).
  `lib/api.ts` and `lib/gateway.ts` talk to the server; Vite proxies to the
  loopback API in development.
- Theming: the client derives every color from two admin-chosen colors through
  `packages/shared/src/theme.ts` and writes them as `--h-*` custom properties on
  `:root`. Stylesheets reference those tokens only; the hardcoded values in the
  `:root` block of `app.css` are first-paint fallbacks, not a palette. Status
  colors (success/error/warning) are intentionally not derived from the accent.
- Big, rarely opened panels are fetched on first use: they are listed in
  `lib/lazy-panels.ts` and mounted through `LazyPanel.svelte`. Never import one
  of them statically as well, or the bundler folds it back into the entry chunk
  without a word; check the chunk list `npm run build:web` prints.
- In production one process serves the built client, the API and the gateway on
  one origin, so there is no CORS to manage.

## CSS and motion gotchas

These have each cost real time; keep them in mind.

- Vendor-prefixed properties must come before the standard one, or Lightning CSS
  (Vite's minifier) drops the standard one. `build.cssMinify: 'esbuild'` does not
  work here.
- Never let an entrance animation and a hover effect write the same transform
  property on the same element: a CSS animation outranks every normal rule, so
  while it runs it silently overrides the hover. Put entrance movement on the
  independent `translate` property and hover movement on `transform` (or on a
  wrapper), and the two compose instead of fighting.
- Move a row as one unit by transforming a single wrapper, not the interactive
  child, so nothing inside can drift on its own.
- Firefox does not composite transform transitions or animations by itself. A
  moving row repaints (and re-snaps its text) every frame and looks like it is
  jittering or drifting; `will-change: transform` on the moving element fixes it.
  An infinite or continuous animation sat at a few frames per second in Firefox
  for the same reason.
- Firefox cannot composite an animation inside a `backdrop-filter` subtree. A
  continuously animated child of a glass surface (a blurred card or popover)
  forces a repaint of the whole blurred surface every frame, so avoid idle
  animations there. This is why the profile card avatar has no float.
- Avoid leaving a transform behind on a tiny SVG after an animation finishes
  (for example a `both` fill mode on a scale pop): the element re-renders at its
  untransformed size and reads as a small size change. Fade instead of scale for
  badges.
- A full-screen click-catcher behind a modal (to close it on an outside click) is
  a button, so the shared button styles tint the whole scrim with the accent
  color the moment the pointer is anywhere over it. Reuse `.overlay-backdrop` in
  `app.css`, whose hover and active are pinned off it and kept more specific than
  `button:hover:not(:disabled)`, and give the panel itself `position: relative;
  z-index: 1` so it stays above the catcher and its controls keep working.
- That pin is only as good as its specificity. `button:hover:not(:disabled)`
  scores (0,2,1), because `:not(:disabled)` adds a class-level unit, so a bare
  `.drawer-backdrop:hover` (0,2,0) loses to it and the scrim fills accent again.
  The mobile channel-bar/member-bar catcher, `.drawer-backdrop` (see the mobile
  layout block in `app.css`), is exactly this trap: its hover/active pin must
  carry `:not(:disabled)` to reach (0,3,0). Whenever you pin a button-backed
  backdrop, match the `:not(:disabled)` form and re-check the cascade, or the
  accent bleed comes back.

## Clean workspace: leave nothing running

Company rule YUC-RULE-001. Every employee leaves their workspace exactly as they
found it. When a task ends - success, failure, or timeout - nothing you started
is still running, and nothing you created outside the task's execution workspace
is left behind. RAM is finite and shared.

- Stop everything you started before you mark a task done: dev/preview/test
  servers, watchers, app servers, emulators, `adb`, Gradle/Kotlin daemons,
  databases, queues, tunnels, and backgrounded scripts.
- Prefer Paperclip-managed issue-workspace runtime services over `npm run dev &`;
  they are tracked and stoppable by others.
- Reap what you background - kill the process group, do not rely on the shell
  exiting.
- Leave no extra copies: throwaway clones, worktrees, temp data dirs, AVDs.
- Verify before you finish (`ss -ltnp`, `ps -eo pid,etime,rss,args`,
  `adb devices`, `./gradlew --stop`) and put the result in your completion note.
- If a run dies, the next run reaps orphans attributable to finished tasks.
- Never kill someone else's live work - flag it to the CTO.

## Working with the user

- The user runs Harmony in production and is the product owner. They cannot show
  you the UI, so describe visual changes precisely and ask them to confirm.
- Be honest about uncertainty. If you could not reproduce something, say so and
  explain what you did verify, rather than implying it is fixed.
- Prefer American spelling in text you write (color, favorite, center).
- Keep `REVIEW_NOTES.md` (gitignored) for scratch findings and hand-off notes
  when a task spans more than one session or agent, so nothing is lost between
  them. It is not part of the project.
