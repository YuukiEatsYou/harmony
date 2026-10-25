# Harmony design system

> **Status: canonical reference.** This is the authoritative product-design
> document for the Harmony client. It describes what exists today in
> `apps/web` and `packages/shared`, names the real tokens, files and components
> it is grounded in, and states the rules a future change must follow. It is
> not a proposal for a redesign; where it asks for something new, it is marked
> **[proposal]** with a rationale and a reuse note.
>
> Implementation of any change described here is Eris's (web engineer). Visual
> sign-off belongs to the board and the user, who run the product. This document
> is the spec those changes are built against.

Scope: the Svelte 5 client in `apps/web` and the theme derivation in
`packages/shared/src/theme.ts`. It does not cover server, bridge or gateway
behavior (see `docs/TECHNICAL.md` and `docs/API.md`).

How to use it: when you touch a component, read the relevant scale section and
the interaction-state conventions before inventing a value. When you need a
color, reach for an existing `--h-*` token; never hardcode one.

---

## 1. Design principles

These are specific to Harmony: a **self-hosted, single-community** Discord
alternative, operated by the same person who uses it, whose colors and identity
are chosen per instance.

### 1.1 The instance is the brand, not Harmony

An admin picks two colors (`ThemeSettings.background`, `.accent` in
`packages/shared/src/theme.ts`) and everything else is derived. No screen,
badge or illustration may depend on a specific hue, because no hue is
guaranteed to exist. This is why every color is a `--h-*` token and why
`deriveTheme` computes the elevation ladder, the text grays, the borders and
the translucent washes from the base pair. A design that only looks right on
the default `#12151a` / `#5865f2` pair is a bug.

*Lens: Aesthetic-Usability, Defaults (the shipped pair must be good, since most
operators never change it).*

### 1.2 One server, so the community is the home

There is one community, not a rail of servers. The information
architecture is channel-first: **channels and categories are the primary
navigation** (`ChannelSidebar.svelte`, `.channel`, `.category`), and presence
and identity (`MemberList.svelte`, `ProfileCard.svelte`) are one click away
rather than a mode switch. Design decisions should assume the reader is a
member of *this* server, not a visitor deciding where to land.

*Lens: Information Scent, mental models of IA, Jakob's Law (borrow the
channel-list / message-stream model people already know from Discord).*

### 1.3 Density where the conversation is, room where the decision is

Chat is scanned, not read: messages are dense (`.message` padding
`0.15rem 0.6rem`, body `0.925rem` / line-height 1.55), and controls reveal on
hover or focus so the stream stays quiet. Onboarding, settings and the admin
panel are the opposite: single-column, generous padding, one decision per
section (`AuthPanel.svelte`, `SetupWizard.svelte`, `admin/AdminPanel.svelte`).
Density is a property of context, not a global style.

*Lens: Cognitive Load, Miller's Law, Progressive Disclosure, Fitts's Law.*

### 1.4 Calm by default, expressive at the edge

Color and motion are restrained. The accent marks **focus, selection and the
primary action only**; it is not decoration. Motion is transform-only,
short (120–420 ms) and purposeful. This is a chat app people leave open all
day, so idle animation and loud surfaces cost attention that should go to the
conversation.

*Lens: Von Restorff (the accent is the island), Selective Attention, motion
for perceived performance.*

### 1.5 Semantic status is never themed

`--h-ok`, `--h-warn` and `--h-error` are fixed and deliberately **not** derived
from the accent (`docs/AGENTS.md`, `theme.ts` header). An accent may be green,
so an accent-colored "success" would be unreadable. Status meaning must survive
any palette, and must never rely on color alone (see §6.5).

*Lens: color-independence, Norman's feedback, trust.*

### 1.6 Honest, reversible, self-hosted defaults

The operator owns the instance and the data. Defaults must not trap the user:
destructive actions confirm, nothing is a roach motel, and empty/no-data states
are explained plainly rather than used to upsell. No dark patterns:
confirmshaming, sneak-into-basket and bait-and-switch are refused.

*Lens: Ethics, Forgiveness, Loss Aversion, Plain Language.*

---

## 2. Color and the token system

### 2.1 Two colors in, one palette out

`deriveTheme(settings)` in `packages/shared/src/theme.ts` takes `background` and
`accent` (each `#rrggbb` or `null` for the built-in default) and returns a
`ThemeTokens` object. `apps/web/src/lib/theme.ts` writes each field onto
`:root` as a `--h-*` custom property.

Default pair: `DEFAULT_BACKGROUND = #12151a`, `DEFAULT_ACCENT = #5865f2`.

The derivation rules, for reference:

- **Scheme.** `relativeLuminance(background) > 0.45` → light, else dark. Drives
  `color-scheme` and which way surfaces move.
- **Elevation.** Surfaces step *toward the text color*: lighter on dark, darker
  on light (`elevateToward`). A near-black background (`luminance < 0.004`) has
  no room to darken, so its recessed steps climb instead (`recessToward`), and
  the step sizes grow so separation is visible at all.
- **Text.** `text` = background mixed 87–88% toward the text color;
  `textMuted` = 55%; `textFaint` = 38%. These three are the only text tones.
- **Accent family.** `accentHover` = accent mixed 12% toward the opposite of
  the background; `accentSubtle` = accent at 12% alpha; `accentGlow` = 38%
  alpha; `accentGradient` = a `linear-gradient` from the accent into a +
  0.05-hue, +0.05-lightness neighbor so it reads as depth, not a second color.
- **`onAccent`.** Black or white, whichever has the **higher contrast** against
  the accent. `theme.ts` compares the accent's luminance to the exact
  black/white contrast crossover (`sqrt(1.05 * 0.05) - 0.05`, about 0.179):
  white below it, black above. See §6.1.
- **Borders and washes.** `border`/`borderStrong` and `hover`/`active` are
  translucent black or white depending on scheme, so they layer over any
  surface.

### 2.2 What may be a one-off, and what may not

May be fixed (not themed):

- **Shape** — `--h-radius-*` (§3.3).
- **Elevation shadows** — `--h-shadow-*` (§3.4).
- **Motion** — easings and durations (§3.5).
- **Type** — the `--h-font` / `--h-mono` stacks and the scale (§3.2).
- **Status hues** — `--h-ok` / `--h-warn` / `--h-error` (§2.5).

May **not** be a one-off:

- **Any color that should follow the theme.** No `#abc123` in a component
  stylesheet. It must be a token derived in `theme.ts`, or an existing token.
- **Any new shared value repeated in more than one place.** If two components
  need the same spacing/radius/duration, it belongs in the scale, not copied.

The values in the `:root` block of `apps/web/src/app.css` (lines 25–116) are
**first-paint fallbacks, not a palette**: they exist so the app renders before
the server's theme arrives, and the theme layer (`apps/web/src/lib/theme.ts`)
overwrites every color property at runtime. Do not treat them as source.

**Syntax highlighting** is the one sanctioned local exception:
`app.css` lines 1934–1939 define `--syntax-*` from fixed hues mixed 70% toward
`var(--h-text)`, scoped to code blocks. That mix is what keeps them legible on
a light or dark theme. **[proposal]** Promote these to derived `:root` tokens
(`--h-syntax-red`, …) so they are defined once and follow the same rule; they
are reused by every `.code-block` and by `ComposerPreview`.

### 2.3 Token reference

| Token | Derived from | Meaning / where used |
| --- | --- | --- |
| `--h-bg` | background | Page and panel base. `.sidebar`, `.roster`, `body`. |
| `--h-bg-elevated` | bg + elevation | Panels and cards that climb the ladder. `main`, profile card base. |
| `--h-bg-raised` | bg + raised step | Chips and raised rows. `.badge` background, scrollbar thumb. |
| `--h-bg-overlay` | bg + overlay step | Topmost surface: hovered raised elements. |
| `--h-bg-deep` | bg − recess | Wells: inputs, `.panel`, `.user-bar`, form fields. |
| `--h-text` | bg → text | Primary text and icons. |
| `--h-text-muted` | bg → text (55%) | Secondary text, labels, channel labels. |
| `--h-text-faint` | bg → text (38%) | Timestamps, hints, placeholders. Non-essential only (§6.1). |
| `--h-accent` | accent | Focus ring, active marks, primary button, selection. |
| `--h-accent-hover` | accent + 12% | Hovered accent control. |
| `--h-accent-subtle` | accent @12% | Selected rows (`.channel.active`, `.admin-tab.active`), `.reaction.me`. |
| `--h-accent-glow` | accent @38% | Hover ring on buttons, accent shadow. |
| `--h-accent-gradient` | accent → close hue | Primary CTA fill. |
| `--h-on-accent` | accent contrast | Text/icons on an accent surface. **See §6.1.** |
| `--h-hover` | translucent | Row hover wash (`.channel:hover`, `.roster-member:hover`). |
| `--h-active` | translucent | Pressed/selected wash, `.message-actions button:hover`. |
| `--h-border` | translucent | Hairline separators and control borders. |
| `--h-border-strong` | translucent | Firmer separator, hovered border. |
| `--h-glass-bg` / `--h-glass-border` | elevated @78% | Floating glass layers (`.notice`, `.message-actions`). |
| `--h-glass-blur` | fixed `16px` | Blur radius paired with glass. |
| `--h-ok` / `--h-warn` / `--h-error` | fixed | Semantic status (§2.5). |
| `--h-error-subtle` | fixed @12% | Error backgrounds (`.status.err`, danger hover ring). |

### 2.4 Adding a color token — the rule

1. Derive it in `theme.ts` and add the field to `ThemeTokens`.
2. Add a first-paint fallback to the `:root` block in `app.css`.
3. Apply it in `apps/web/src/lib/theme.ts#apply`.
4. Use only the token in stylesheets.

Name tokens `--h-<role>`, not `--h-<component>` (an existing counter-example,
`.profile-viewer`'s local `--profile-accent`, is scoped to one component and is
acceptable *only* because the value is per-member runtime data, not a design
constant).

### 2.5 Status colors

| Token | Hue | Used for |
| --- | --- | --- |
| `--h-ok` | `#22c55e` | Success text (`.ok-text`), `.status.ok` left border, live-event inset bar (`.event-entry.live`), active event chip. |
| `--h-warn` | `#f59e0b` | Caution text and warnings. |
| `--h-error` | `#ef4444` | Error text (`.form-error`), `.notice.error` bar, `.status.err` bar, danger button fill, `.scheduled-entry.failed` inset bar. |
| `--h-error-subtle` | error @12% | Error backgrounds and the danger hover ring. |

Status is always carried by **at least two channels**: a border/bar plus text,
or a color plus a label — never hue alone (§6.5).

Status tokens are status **only**. Never use `--h-ok` / `--h-warn` / `--h-error`
for an identity or relationship marker: a green check reads as “verified”, not
“linked to Discord”. Identity and relationship use `--h-accent`, `--h-text` or
`--h-text-muted` (see §4.10).

---

## 3. Scales

All type and spacing is in `rem`. The root font size is `15px` (`app.css`
line 111), so `1rem = 15px`. Values below show the px equivalent for review.

### 3.1 Spacing

There is a `--h-space-*` ladder, defined in the static `:root` block of
`app.css` (it is shape, so `theme.ts` never writes it). It is the observed
vocabulary, clustered on a ~`0.1rem` (1.5px) quantum:

| Step token | rem | px @15 | Typical use |
| --- | --- | --- | --- |
| `--h-space-1` | `0.2rem` | 3 | icon-to-label, tight inline pairs |
| `--h-space-2` | `0.3rem` | 4.5 | chip internals, message-action gap |
| `--h-space-3` | `0.4rem` | 6 | compact row gap (`.roster-member`, `.channel`) |
| `--h-space-4` | `0.5rem` | 7.5 | default flex gap |
| `--h-space-5` | `0.6rem` | 9 | row padding, list gap |
| `--h-space-6` | `0.75rem` | 11.25 | control padding, card inner gap |
| `--h-space-7` | `1rem` | 15 | chat padding, panel padding |
| `--h-space-8` | `1.25rem` | 18.75 | section rhythm |
| `--h-space-9` | `1.5rem` | 22.5 | page/section separation |
| `--h-space-10` | `2rem` | 30 | large separation |
| `--h-space-11` | `2.5rem` | 37.5 | landing card padding |

Rules:

- Values **between** steps (`0.15`, `0.35`, `0.45`, `0.55`, `0.65`, `0.7`,
  `0.85`, `0.9`, `1.1`, `1.2`) are drift. When you next touch a component that
  uses one, snap it to the nearest sanctioned step (an exact tie rounds up).
  Do not add a new step.
- Reuse: the ladder is used by every stylesheet — `.sidebar`/`.roster`/`.chat`
  shells, `.message`, `.composer`, `.panel`, `.admin`, forms. That reuse is its
  justification.
- Adoption is incremental. The first consumers are `.panel`, `.channel`,
  `.roster-member`, `.message` and `.composer`; every other component follows as
  it is touched.

### 3.2 Typography

One family and one mono stack (`--h-font`, `--h-mono`). The base is `15px` /
line-height `1.5`. `h1`–`h4` carry `letter-spacing: -0.02em`, `line-height:
1.25`. There is an existing set of global primitives (`h1` 1.65rem/800;
`h2` 0.72rem/700 uppercase tracked; `h3` 1.1rem/700) and a de-facto size ladder
in components.

Canonical scale (`--h-text-*` tokens live in the static `:root` block in
`app.css`):

| Role | Size / token | Weight | Where it appears today |
| --- | --- | --- | --- |
| Micro / badge | `0.62rem` `--h-text-2xs` | 700–800 | `.badge`, `.gutter` uppercase tags |
| Caption / meta | `0.72rem` `--h-text-xs` | 600–700 | timestamps (`.gutter-time`), `h2`, message-action buttons |
| Hint / secondary | `0.8rem` `--h-text-sm` | 400–500 | `.muted` hints, `.poll-hint`, `.scheduled-note` |
| UI default | `0.875rem` `--h-text-base` | 500 | `.channel`, `.admin-tab`, `.checkbox`, roster names |
| Control / status | `0.9rem` `--h-text-md` | 600 | `button`, `input`, `.status`, `.notice`, `.form-error` |
| Message body | `0.925rem` `--h-text-lg` | 400 | `.content`, `.author` |
| Section heading | `1.1rem` `--h-text-xl` | 700 | `h3` |
| Page heading | `1.65rem` `--h-text-2xl` | 800 | `h1` (auth/landing) |

Message markdown headings use their own steps inside `.content`
(`.md-header.md-h1` 1.35rem, `.md-header.md-h2` 1.18rem, `.md-header` 1.1rem)
and code is `0.84rem`. Those are content-driven and stay where they are.

Usage rules:

- Body copy is `0.925rem` in the stream, `0.9rem` in controls and panels. Do not
  set message text below `0.875rem`.
- Uppercase tracked labels (`text-transform: uppercase`, `letter-spacing` 0.04–
  0.08em) are reserved for section headers, badges and status chips.
- Max line-length for prose blocks: keep to the panel widths (`main` is
  `min(560px, 90vw)`, `.profile-viewer` `min(520px, 96vw)`); do not let a
  paragraph run full-width.

### 3.3 Radius and shape

Squircles for surfaces and controls, circles for people and pills
(`app.css` comment, line 62):

| Token | Value | Use |
| --- | --- | --- |
| `--h-radius-xs` | 4px | chips inside a control (message actions), tiny inner corners |
| `--h-radius-sm` | 6px | default control — buttons, inputs, `.channel`, `.roster-member` |
| `--h-radius` | 10px | panels, `.panel`, fieldset, `.member` |
| `--h-radius-lg` | 14px | toasts, `.notice`, larger floating surfaces |
| `--h-radius-xl` | 18px | full panels: `main` landing card, `.profile-viewer`, admin shell |
| `--h-radius-full` | 999px | pills, avatars, badges, dots, mention pills |

Rule: a rounded child inside a rounded parent uses the *next* step down
(e.g. a `.message-actions button` uses `xs` inside a `sm` container).

### 3.4 Elevation and surfaces

Depth is **tint, not shadow**: surfaces climb a ladder from `--h-bg-deep`
(wells) up through `--h-bg`, `--h-bg-elevated`, `--h-bg-raised`, to
`--h-bg-overlay`. Shadows are reserved for genuinely floating layers.

| Layer | Background | Shadow |
| --- | --- | --- |
| Recessed / well | `--h-bg-deep` | none (inputs, `.panel`, `.user-bar`, `.member`) |
| Base | `--h-bg` | none (`.sidebar`, `.roster`, page) |
| Raised panel / card | `--h-bg-elevated` | `--h-shadow-xl` only on `main` |
| Chip / raised row | `--h-bg-raised` | none |
| Topmost surface | `--h-bg-overlay` | none |
| Floating glass | `--h-glass-bg` + `--h-glass-blur` | `--h-shadow` (`--h-shadow-lg` for `.notice`, `--h-shadow-xl` for `main`) |

Shadow tokens: `--h-shadow-sm` (0 1px 3px), `--h-shadow` (0 4px 16px),
`--h-shadow-lg` (0 12px 40px), `--h-shadow-xl` (0 24px 64px). Use the smallest
that separates the layer; a surface with no float gets no shadow. The accent
aura is permitted on exactly one surface (`main`, the landing card) and nowhere
else.

### 3.5 Motion

Tokens (`app.css` lines 81–104):

| Token | Value | Use |
| --- | --- | --- |
| `--h-ease` | `cubic-bezier(0.4, 0, 0.2, 1)` | default UI transitions |
| `--h-ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | entrances |
| `--h-ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | playful pops |
| `--h-ease-snappy` | `cubic-bezier(0.22, 0.68, 0, 1)` | quick exits |
| `--h-ease-bounce` | `cubic-bezier(0.68, -0.55, 0.265, 1.55)` | rare, emphatic |
| `--h-spring` / `--h-spring-gentle` | `linear(...)` | physical springs; fall back to default easing |
| `--h-duration-fast` | `120ms` | feedback loops, hover |
| `--h-duration` | `160ms` | default |
| `--h-duration-slow` | `260ms` | panel/drawer entrances |
| `--h-duration-slower` | `420ms` | message entrance |

Named keyframes: base sheet (`notice-in`, `voice-joining-pulse`,
`message-flash`, `drop-pulse`, `card-in`, `picker-in`, `overlay-in`, `modal-in`)
and the shared `h-*` set (`h-fade-in`, `h-fade-up`, `h-fade-down`,
`h-scale-in`, `h-pop-in`, `h-bar-in`, `h-slide-left`, `h-slide-right`,
`h-shimmer`, `h-glow-pulse`, `h-shake`, `h-typing-dots`). Reuse the `h-*` names
for new motion rather than adding a component-local keyframe (`QuickSwitcher`'s
`qs-fade`/`qs-rise` are the existing local exception).

Rules (`docs/AGENTS.md` "CSS and motion gotchas" — authoritative):

- **Transform only.** Movement is `transform`/`translate`, so the compositor
  stays in charge. Never animate layout properties.
- **Entrance ≠ hover on the same property.** An entrance animation outranks
  normal rules, so put entrance movement on the `translate` property and hover
  movement on `transform`, or they fight. `.message` does exactly this
  (`animation: h-fade-up ... backwards` at line 5743, hover `transform`).
- **`will-change: transform`** is required on a moving row for Firefox to
  composite it.
- **No idle animation inside a `backdrop-filter` subtree** (Firefox repaints
  the whole blurred surface).
- Use `backwards`, not `both`, fill on entrances that precede a hover transform.
- **Budget:** interaction feedback must land inside the Doherty threshold
  (~400ms). `--h-duration` (160ms) and `--h-duration-fast` (120ms) are the
  defaults for that reason; avoid `--h-duration-slower` on feedback.

---

## 4. Component inventory

51 Svelte components under `apps/web/src/components`, plus 19 admin sections
under `apps/web/src/components/admin`. Grouped by the role they play and the
pattern they express. File paths are relative to `apps/web/src/components`.

### 4.1 Shell, navigation and global chrome

| Component | Pattern it expresses |
| --- | --- |
| `App.svelte` | The three-column shell: `.sidebar` (250px) · chat · `.roster` (230px). Renders the global `.notice` toast (`role="status"`). |
| `ChannelSidebar.svelte` | Channel/category navigation: `.category` (collapsible), `.channel` (row), `.user-bar` (identity + status). |
| `ChannelMenu.svelte` | Per-channel action menu (`role="menu"`, `menuitem`). |
| `HeaderActions.svelte` | Chat-header action cluster (search, inbox, pins, saved, events, gallery). |
| `Icon.svelte` + `lib/icons.ts` | The shared monochrome line-icon primitive; decorative (`aria-hidden`), colored by `currentColor`. |
| `UnreadBadge.svelte` | Count pill on a nav button. |
| `QuickSwitcher.svelte` | Command-palette jump (`role="dialog"`, listbox of results). |
| `KeyboardShortcuts.svelte` / `ShortcutHelp.svelte` | The app-wide keyboard layer (decisions in `lib/global-shortcuts.ts`) and its reference; `ShortcutHelp` is presentational. |
| `ChannelHistory.svelte` | Back and forward between channels through browser history; draws nothing. |
| `ChangelogDialog.svelte` | "What's new" after an update (`role="dialog"`, focus trapped, Escape, backdrop or "Got it" closes). Shown once per member, opened again from About. |
| `LazyPanel.svelte` + `lib/lazy-panels.ts` | Mounts a panel fetched on first use (admin, setup, account, profile viewer, events, scheduled, gallery): nothing for 200 ms, then a "Loading …" pill; a failed download is a small dialog with Reload. |
| `admin/AdminPanel.svelte` | Overlay shell: `.admin-overlay`, left `.admin-tabs` nav, section body. |

### 4.2 The conversation stream

| Component | Pattern it expresses |
| --- | --- |
| `Chat.svelte` | Channel header + message view + composer; empty-channel state (`.chat.empty`). |
| `MessageView.svelte` | The scroll stream: grouping, date lines between days, "new messages" bar, loading older/initial, "No messages yet." |
| `MessageContent.svelte` | Markdown/mention/emoji rendering inside `.content`. |
| `CodeBlock.svelte` | Fenced code with copy; `--syntax-*` colors. |
| `EmbedVideo.svelte` / `LinkedGif.svelte` | Rich link/media embeds with fallback ordering. |
| `Lightbox.svelte` | Full-screen image viewer (backdrop button + Escape). |
| `EditHistory.svelte` | Per-message revision list. |
| `PinAction.svelte` / `RemoveEmbedsAction.svelte` / `SaveAction.svelte` | Single-purpose message-action buttons. |
| `PollView.svelte` | Poll rendering, voting, live counts (`aria-live` on meta). |
| `PollComposer.svelte` | Poll creation form. |

### 4.3 The composer and composition tools

| Component | Pattern it expresses |
| --- | --- |
| `Composer.svelte` | The message box: draft, attachments, upload progress, mention/emoji autocomplete, `+` menu, slowmode/timeout gating. |
| `ComposerPreview.svelte` | Draft preview (custom emoji rendered as they will send). |
| `SchedulePicker.svelte` / `ScheduleTimeField.svelte` | Scheduled-message composition. |
| `ScheduledPanel.svelte` | Scheduled-message list with per-entry status (`.failed` inset bar). |
| `TimestampPicker.svelte` | Discord timestamp insertion. |

### 4.4 People, profile and presence

| Component | Pattern it expresses |
| --- | --- |
| `MemberList.svelte` | Roster: role groups (`.roster-group`), member rows with presence dot. Empty state ("No members yet."). A drawer on a narrow screen; on a wide one `.put-away` hides it (members button, Ctrl+U). |
| `ProfileCard.svelte` | Hover/click mini card (banner, member color). |
| `ProfilePanel.svelte` / `ProfileViewer.svelte` | Full profile overlay (`.profile-viewer`, `--profile-accent`). |
| `MemberBadge.svelte` / `BotBadge.svelte` | Inline crown/sword/shield and bot glyphs. |
| Voice surfaces (styled in `app.css`, driven by `lib/voice.svelte.ts`, `ScreenShare.svelte`) | `.voice-member`, `.voice-bar`, `.screen-share`, `.screen-tile`. `ScreenShare.svelte` is the screen-share view. |

### 4.5 Pickers and rich content

| Component | Pattern it expresses |
| --- | --- |
| `EmojiPicker.svelte` | Tabbed picker (custom / unicode) with recent reactions; empty + error states. |
| `GifPicker.svelte` | Remote-gif search, "Searching…" and empty states. |
| `ServerGifAction.svelte` / admin `ServerGifsSection.svelte` | Curated server gif cards (`.sg-card`, pinned/hidden states). |
| `GalleryPanel.svelte` | Channel media gallery with pagination ("Load more"). |
| `EventTimeField.svelte` / `EventsPanel.svelte` | Events: list entries with `.live`/`.over`/`.canceled` status chips and interest toggles. |

### 4.6 Search, inbox and saved

| Component | Pattern it expresses |
| --- | --- |
| `SearchPanel.svelte` | Query + results, debounced; no-match state. |
| `InboxPanel.svelte` | Mentions list, pagination ("Load older mentions"). |
| `PinsPanel.svelte` | Pinned messages list. |
| `SavedPanel.svelte` | Saved messages with paging. |
| `AboutPanel.svelte` | Instance info / links. |

### 4.7 Admin

`admin/AdminPanel.svelte` plus 18 sections: `SettingsSection`, `ColorsSection`
(the two-color picker), `ChannelsSection`, `RolesSection`, `MembersSection`,
`BansSection`, `BotsSection`, `BridgeSection`, `EmojisSection`,
`ServerGifsSection`, `GifSourcesPanel`, `InvitesSection`, `MediaSection`,
`RetentionSection`, `BackupSection`, `AuditSection`, `ServerLogSection`,
`UpdateSection`.

Pattern: each section is a single-column form of fieldset/label groups, with a
save affordance and a status line. `ColorsSection` is the theme authoring
surface and must preview via `previewTheme` / `restoreTheme`
(`apps/web/src/lib/theme.ts`).

### 4.8 Onboarding, auth and meta

`AuthPanel.svelte` (login/register), `SetupWizard.svelte` (first-run steps),
`AboutPanel.svelte`.

### 4.9 Cross-cutting gaps and duplication

These are the known weaknesses. They are the highest-value things to fix, and
they are why §7 proposes shared primitives.

1. **No shared overlay/modal primitive.** `.admin-overlay`, `Lightbox`,
   `QuickSwitcher`, `ProfileViewer`/`GalleryPanel` and the mobile drawers each
   re-implement: backdrop button, Escape-to-close, focus return, z-index, and
   the `.overlay-backdrop` hover/active pinning. Four+ copies of the same
   contract is the largest duplication in the client.
2. **No shared empty/loading primitive.** `Loading…` is a bare
   `<p class="muted">` repeated ~15 times (`EditHistory`, `GalleryPanel`,
   `InboxPanel`, `PinsPanel`, `MessageView`, `EmojiPicker`, `EventsPanel`, …).
   There is a `h-shimmer` keyframe but no skeleton component. Loading looks
   different in every panel and there is no spinner.
3. **No shared button/field components.** Variants live as global `button`
   plus `.primary`/`.ghost`/`.danger`/`.link`, and admin sections repeat
   `label` + `input` markup. Consistent today by discipline, easy to drift.
4. **Badge/chip/status eat three shapes.** `.badge`, `.event-status`,
   `.mention-pill`, `.chip`, `.role-dot` are near-duplicates.
5. **Spacing adoption in progress.** The `--h-space-*` ladder exists, but most
   components still use raw rem (§3.1) until they are touched.
6. **Danger-button contrast** has a measured failure (§6.1); `--h-on-accent`
   was fixed in v2.7.0.
7. **No skeleton, no progress convention** for the initial message load
   (`MessageView` prints text), which is the most-visited loading state.

### 4.10 The Discord linked state

`User.discordLinked` (`packages/shared/src/types.ts`) is the only thing a public
DTO says about a Discord link; the raw id is deliberately absent, so the state
has to read clearly without it. The public surfaces carry it like this:

- `ProfileCard.svelte` and `ProfileViewer.svelte` show a `Discord` field row
  reading **Linked**, in the same `profile-field` slot the removed id row
  occupied, rendered only for a linked, non-ghost member. Text makes the state
  legible without hover and without color (Recognition over Recall, Plain
  Language, §6.5), and keeps the card and the viewer telling the same story. The
  row is the existing `.profile-field` pattern — no new component.
- `MemberList.svelte`, and the name line of `ProfileCard.svelte` and
  `ProfileViewer.svelte`, show a glyph after the name: `link` for a stand-in
  (`accountType === 'ghost'`), `check` for a member who linked an account. This
  is the at-a-glance cue and stays icon-only. The linked badge uses
  `--h-accent`, not `--h-ok` (§2.5): it is identity, not status. The badge spans
  carry `role="img"` plus an `aria-label` matching the `title`, so the icon has
  an accessible name (§6.2).
- `ProfilePanel.svelte` (self) and `admin/MembersSection.svelte` (admin) show
  the id itself, on the authorized surfaces that need it.

A ghost keeps the `link` badge alone, because the roster already groups stand-ins
under a "Discord" heading and a stand-in has no other profile fields.

---

## 5. Interaction-state conventions

### 5.1 Pointer and selection

| State | Convention | Reference |
| --- | --- | --- |
| Hover (row) | `--h-hover` translucent wash, text steps up one tone. | `.channel:hover`, `.roster-member:hover` |
| Hover (button) | 1px lift + accent glow ring; `background` → `--h-accent-hover` for accent buttons, `--h-bg-overlay` for `.ghost`. | `:where(button):hover:not(:disabled)`, `button.ghost:hover` |
| Active / pressed | `scale(0.96)` + 60ms, or `translateY(0)`; no glow change beyond press. | `:where(button):active` |
| Selected / current | `--h-accent-subtle` background **plus** a non-color cue: a 3px accent bar (`.channel.active::before`), weight 600, or an accent border. | `.channel.active`, `.admin-tab.active`, `.reaction.me` |
| Unread / attention | Bold text + a white 3px marker (`.channel.unread::before`) or a `--h-text` bar; `.mention-pill` for counts. | `.channel.unread` |
| Mention (self) | Distinct background tint on the row, not just text color. | `.message.mentions-me` |
| Highlighted (jump-to) | `message-flash` animation. | `.message.highlighted` |
| Reveal-on-demand | Actions hidden by default, shown on `:hover` (fine pointers only, via `@media (hover: hover) and (pointer: fine)`) **or** `:has(:focus-visible)` / `.open`. Touch gets `@media (hover: none)` to show permanently. | `.message-actions`, `.gif-heart` |
| Disabled-as-state | Prefer `aria-disabled="true"` for controls that must stay focusable (voice-bar buttons); visual `opacity` without removing from tab order. | `.voice-bar-button[aria-disabled='true']` |

### 5.2 Focus

- Global ring: `:focus-visible { outline: 2px solid var(--h-accent); outline-offset: 2px; }` (`app.css` line 243). Use `:focus-visible`, not `:focus`, so mouse users don't see a ring.
- Inside a clipped scroll area, invert the offset: `.admin-tab:focus-visible { outline-offset: -2px; }`.
- Adjacent controls may reveal on `:focus-within` (`.channel-item:focus-within .channel-more`) — focus must be as discoverable as hover.
- Never remove the outline without a replacement that meets §6.1 contrast.

### 5.3 Disabled

- `button:disabled { opacity: 0.45; cursor: not-allowed; }` (global). Keep the label readable; do not lower below 0.45.
- Explain *why* a control is disabled next to it (e.g. slowmode/timeout in `Composer`), because opacity alone does not communicate the reason.

### 5.4 Loading, empty and error

| State | Current convention | Notes / gap |
| --- | --- | --- |
| Loading | `<p class="muted">Loading…</p>` in the panel body | No skeleton, no spinner. **Gap 2 (§4.9).** |
| Loading older | "Loading older messages…" above the stream | Same. |
| Panel still downloading | `LazyPanel`: nothing for the first 200 ms, then a centered pill with a spinner and "Loading …" (`role="status"`). | Opaque, not glass: a turning spinner inside a backdrop filter makes Firefox repaint the blur every frame. |
| Panel failed to download | `LazyPanel`: a modal card with a `.status.err` explanation, Reload (focused) and Close. | The recovery is a reload: the usual cause is an update that replaced the files, and Chromium keeps a failed download failed until the page reloads. |
| Uploading | Progress on the attachment in `Composer` (`uploadBatches`). | Keep; the one place with real progress UI. |
| Empty | One `.muted` sentence, plain language, no blame. `.roster-empty`, `.qs-empty`, "No messages yet. Say hello!" | Good pattern; formalize as a primitive. |
| Error (text) | `.form-error` (error color) under a field; `role="alert"` where announced. | Inline, single-column (§ forms). |
| Error (block) | `.status.err` / `.notice.error`: `--h-error` left bar + `--h-error-subtle` bg, never hue alone. | Include a recovery action. |
| Success | `.status.ok` (ok bar + tint), `.ok-text`. | |
| Background job failed | `.failed` inset bar (`--h-error`) on the entry. | Scheduled messages. |
| Blanket notice | `.notice` toast, `role="status"`, top-center, glass, auto-dismiss with a Dismiss button. | The one global toast. |

Forms follow a single-column layout (`form { display: grid; gap: 1rem; }`),
inline validation, and a recovery path; destructive actions confirm and are
never the default focus target.

### 5.5 Overlays and dismissal

The shared contract (currently duplicated — see Gap 1):

- A full-screen `<button class="overlay-backdrop">` behind the panel, with
  hover/active pinned off the global button styles, closes on outside click.
- The panel is `position: relative; z-index: 1` so its controls stay clickable
  above the catcher.
- `role="dialog"` + `aria-modal="true"`; Escape closes; focus returns to the
  opener (e.g. `EventsPanel`, `Lightbox`).
- An overlay is either state in `ui` (panels, drawers, the setup wizard) or, for
  a dialog that keeps its open state to itself, registered with `modalLayers`
  (`lib/modal-layers.svelte.ts`) while open, as `EditHistory` and
  `ChangelogDialog` are. That is how back knows to close it before it changes
  channel; an overlay outside both stays open over a channel change.
- A layer opened from inside a message row or a sidebar row must leave the row
  with `use:portal` (`lib/portal.ts`), as `EditHistory` does. Those rows carry a
  transform and `will-change: transform` for their hover nudge, and either one
  makes the row the box `position: fixed` is measured against, so the layer
  would cover that one row instead of the window.
- z-index ladder: `.screen-share` `50`; `.notice` and `.profile-card` `60`;
  drawers/backdrop `75`–`80`; composer action popovers `90`–`91`; admin overlay
  and the loading pill of a panel still downloading `100`; dialogs that can open
  over a panel (what's new, shortcut help, edit history) `120`; lightbox `200`
  (above admin, by design).

### 5.6 Motion states

Entrances use the `h-*` keyframes with `--h-ease-out`; pops use
`--h-ease-spring`; refusal/attention uses `h-shake`; skeleton shimmer uses
`h-shimmer`. Follow the §3.5 rules. Every animated property must be suppressed
under `prefers-reduced-motion` (§6.4).

---

## 6. Accessibility baseline

Target: **WCAG 2.2 AA** for user-facing surfaces.

### 6.1 Contrast

Measured against the default palette (`#12151a` bg):

| Token | on `--h-bg` | on `--h-bg-elevated` | on `--h-bg-raised` | Verdict |
| --- | --- | --- | --- | --- |
| `--h-text` | 13.96 | 12.33 | 10.66 | AAA |
| `--h-text-muted` | 6.16 | 5.44 | 4.71 | AA (normal + large) |
| `--h-text-faint` | 3.58 | 3.16 | 2.73 | **AA large only; fails normal.** Never essential. |
| `--h-ok` | 8.03 | 7.09 | — | AAA |
| `--h-warn` | 8.52 | 7.52 | — | AAA |
| `--h-error` | 4.86 | 4.29 | — | AA on base; **4.29 on elevated is below 4.5** — pair with a non-color cue, or darken for text use. |
| `--h-on-accent` white on `#5865f2` | 4.61 | — | — | AA by a hair — see the defect below. |
| White text on `--h-error` danger button | 3.76 | — | — | Below 4.5; acceptable only if treated as large/bold text. |

**Targets:** 4.5:1 for normal text, 3:1 for large text (≥18.66px bold or
≥24px) and for non-text UI (borders of focus rings, icons that carry meaning).
`--h-text-faint` is for timestamps/hints/placeholders only, never for a label
the user must read.

**`onAccent` — resolved (was: the wrong color for mid-tone accents).** The old
`theme.ts` used `ON_ACCENT_THRESHOLD = 0.6`: it picked white above that
luminance, but the true crossover where black and white give equal contrast is
luminance ≈ **0.179**. Between ~0.18 and 0.6 it therefore chose **white**, the
*lower*-contrast option. `theme.ts` now compares the accent's luminance to the
exact crossover (`sqrt(1.05 * 0.05) - 0.05`) and takes the higher-contrast
color. The default is unchanged; every mid tone flips to black:

| Accent | Luminance | `onAccent` | Contrast before | Contrast now |
| --- | --- | --- | --- | --- |
| `#5865f2` (default) | 0.178 | white | 4.61 | 4.61 |
| `#f59e0b` amber | 0.439 | black | **2.15** | 9.78 |
| `#22c55e` green | 0.411 | black | **2.28** | 9.22 |
| `#1abc9c` teal | 0.386 | black | **2.41** | 8.72 |
| `#3498db` blue | 0.283 | black | **3.15** | 6.66 |
| `#e74c3c` coral | 0.225 | black | **3.82** | 5.50 |

`npm run smoke` asserts the default plus amber, green, teal and blue take the
higher-contrast color, at ≥4.5:1.

### 6.2 Keyboard and focus order

- **Tab order follows visual order**: sidebar → header actions → message
  stream → composer. Do not reorder with positive `tabindex`.
- Dialogs are `role="dialog"`/`aria-modal`, trap focus while open, close on
  Escape, and return focus to the trigger.
- Menus (`ChannelMenu`, `HeaderActions` popovers) use `role="menu"` /
  `menuitem`, `aria-haspopup`, `aria-expanded`, and arrow-key movement.
- Listboxes/comboboxes (`QuickSwitcher`, autocomplete) use `role="listbox"` /
  `option` / `combobox` with `aria-expanded` and `aria-controls`.
- Live regions: toasts and async status use `role="status"` (implicit
  `aria-live="polite"`); errors that need interruption use `role="alert"`.
- Every icon-only control needs an accessible name (`aria-label`/`title`);
  `Icon.svelte` is itself `aria-hidden`.

### 6.3 Target size

- Minimum **24×24 CSS px** hit area (WCAG 2.2 AA 2.5.8); aim for **44×44** on
  touch.
- `.message-actions button` (≈24px tall, `--h-text-xs` text) and `.channel-more`
  (a 1.5rem face) now carry a transparent `::after` overlay that grows the hit
  area to ≥24×24 without changing the visible control, and to ≥44×44 under
  `@media (hover: none)`. `.drawer-toggle` is still borderline vertically and
  remains to do.
- Primary buttons are `0.6rem 1rem` with `0.9rem` text (≈33px tall) — fine.

### 6.4 Reduced motion

`@media (prefers-reduced-motion: reduce)` (`app.css` line 118) collapses
animations and transitions to `0.01ms`, disables `scroll-behavior: smooth`, and
keeps **opacity-only** fades for `.message`, `.notice` and `.audit-entry`
(movement is what to avoid; a fade still aids comprehension). It also disables
hover `transform` on `button`, `.channel`, `.message`, `.reaction`.

Requirement: any new animation must either be covered by the global rule or
add an opacity-only reduced fallback. Never animate movement under reduced
motion. Ensure the final (non-animated) state is the fully-visible one.

### 6.5 Color independence

- Active/unread use a **bar/weight/dot** as well as color (§5.1).
- Status uses border/bar + text, not hue alone (§2.5).
- Selected rows carry an accent background *and* a weight or bar change.
- Do not encode meaning in red/green alone (e.g. online/offline dots are
  accompanied by text in the profile and roster).

### 6.6 Content, language and zoom

- Plain language, American spelling, no jargon.
- The layout must survive 200% zoom and 320px reflow: the fixed `250px`/`230px`
  columns collapse to off-canvas drawers at `max-width: 768px`; verify nothing
  is clipped or overlapped at 400% zoom / 320px width.
- Text over images (banners, emoji, embeds) needs a scrim or a solid backing.

---

## 7. Proposals this document asks for

Each is justified by reuse and grounded in a gap in §4.9. None introduces a
one-off. Items 1, 4 and 6 are implemented in v2.7.0; the rest are open.

1. **[done — v2.7.0] Spacing and type tokens (§3.1, §3.2).** `--h-space-*`
   and `--h-text-*` now exist in `:root` (with the drift-snap rule), and
   `.panel`, `.channel`, `.roster-member`, `.message` and `.composer` consume
   them; the rest of the components follow as they are touched.
2. **[proposal] A shared overlay primitive.** One component owning backdrop +
   Escape + focus trap + focus return, reused by admin, lightbox, quick
   switcher, profile viewer and gallery. Removes the largest duplication.
3. **[proposal] A shared state primitive for empty / loading / error.** A
   skeleton using `h-shimmer`, plus one empty-state and one error-state shape,
   replacing ~15 copies of `<p class="muted">Loading…</p>`. Reused by every
   panel and the message stream.
4. **[done — v2.7.0] Fix `onAccent` contrast (§6.1).** `onAccent` now takes the
   higher-contrast of black or white against the accent, at the exact crossover.
5. **[proposal] Promote `--syntax-*` to derived tokens (§2.2).** One
   definition, follows the theme.
6. **[done — v2.7.0] Raise sub-24px hit areas to ≥24px (§6.3).**
   `.message-actions button` and `.channel-more` get a ≥24×24 (≥44 on touch)
   hit area from a transparent `::after` overlay.

---

## 8. Conformance and process

- **Colors** come only from `--h-*` tokens. A new color is a `theme.ts` change
  + `:root` fallback + `apply` (§2.4), never a component literal.
- **Spacing/type/radius/motion** come from the scales (§3). A value outside a
  sanctioned step is drift and should be snapped when touched.
- **States** follow §5; a new control states its hover/focus/active/disabled/
  selected treatment.
- **Accessibility** follows §6; a new interactive surface states its name,
  focus behavior, target size and reduced-motion fallback.
- **Status meaning** never relies on color alone.
- Changing a token, scale or shared pattern means updating this document in the
  same change (`docs/AGENTS.md`: docs are part of the work).
- A design change that ships no code (like this document) may be committed to a
  `docs/*` branch per repo convention.

### Appendix — file map

| Concern | File |
| --- | --- |
| Theme derivation | `packages/shared/src/theme.ts` |
| Theme application | `apps/web/src/lib/theme.ts` |
| Token fallbacks, primitives, all shared CSS | `apps/web/src/app.css` |
| Icon set | `apps/web/src/lib/icons.ts`, `components/Icon.svelte` |
| UI open/close state | `apps/web/src/lib/ui.svelte.ts` |
| Components | `apps/web/src/components/**` |
