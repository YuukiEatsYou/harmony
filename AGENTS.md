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
npm run smoke:bridge   # the Discord bridge against a fake transport
npm run smoke:text     # web client pure logic (markdown/link parser, emoji picker, catch-up)
```

There is no linter and no test framework. A smoke script can also be run
directly, for example `node apps/server/scripts/bridge-smoke.mjs`.

## Verify before you claim something works

Never say a change is done on the strength of reading it. Run the checks that
apply:

- Any change: `npm run typecheck`.
- Web client: `npm run build:web` (this is also what catches CSS the minifier
  would drop) and `npm run smoke:text` when parsing or pure logic is involved.
- Server or bridge: `npm run smoke` and, when the bridge is involved,
  `npm run smoke:bridge`.

A green build is not a substitute for exercising the feature. If the change is
visual, you cannot see the UI: say what you changed, what you verified
mechanically, and hand the visual check to the user explicitly.

## Commits and versions: do these yourself

Unless the user tells you otherwise, you own committing and version bumping.
Do not wait to be asked, and do not leave finished work uncommitted.

- Bump the version with every user-facing change. The single source is
  `HARMONY_VERSION` in `packages/shared/src/constants.ts` (the client, server and
  bridge all read it). Patch for fixes, minor for features, and leave the major
  number to the owner. Bump it in the same commit as the change it describes.
- Write commit messages that stand on their own: a short imperative subject,
  then paragraphs explaining what changed and why, including the reasoning a
  future reader would otherwise have to reconstruct. Prefer several paragraphs
  over one dense line.
- Committing is yours; pushing is not. The owner pushes unless they explicitly
  ask you to. Never force-push.
- Keep backticks out of commit messages and the shell command that carries them;
  they are a quoting hazard in a one-liner. Use plain words.
- Commit one coherent idea at a time. Do not bundle unrelated work just because
  it is convenient.

## Branches and merging: never work on main

Main is what people pull to install or update, so it has to be a state someone
has actually run. The recent PR series caused trouble by landing on it directly,
so from now on main is treated as a release branch only.

- Never commit to main directly. Start every piece of work on a new branch off
  main, named after the version it is expected to ship as: `v<version>`, for
  example `v1.25.0`. Do the commits and the version bump on that branch.
- Only merge that branch into main once the owner has tested and verified the
  work on it. You may do the merge yourself once the owner says it is good;
  pushing stays theirs (see above). If the planned version moves while you are
  still on the branch, the branch name does not have to follow it.
- A change that ships no code and no user-visible behavior, such as an edit to
  this file, is the one exception and may go straight to main.

## Keep the docs current

The documentation is part of the work, not an afterthought. As the project
evolves, keep it true, in the same commit as the change it describes:

- `AGENTS.md` (this file) — update it whenever a command, convention, gotcha or
  working agreement changes. If you learn something the hard way, write it down
  here so the next agent does not repeat it.
- `README.md` — the pitch and quick start aimed at a non-technical owner. Keep
  it accurate when a feature changes what the product does or how it is set up.
- `docs/` — `TECHNICAL.md` (internals and the bridge), `API.md` (the HTTP and
  WebSocket contract) and `DEPLOYMENT.md` (running it on a server). Update the
  relevant one when behaviour or a contract changes.

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
  `bot_tokens`. See `bots/service.ts`.
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

## Working with the user

- The user runs Harmony in production and is the product owner. They cannot show
  you the UI, so describe visual changes precisely and ask them to confirm.
- Be honest about uncertainty. If you could not reproduce something, say so and
  explain what you did verify, rather than implying it is fixed.
- Prefer American spelling in text you write (color, favorite, center).
- Keep `REVIEW_NOTES.md` (gitignored) for scratch findings and hand-off notes
  when a task spans more than one session or agent, so nothing is lost between
  them. It is not part of the project.
