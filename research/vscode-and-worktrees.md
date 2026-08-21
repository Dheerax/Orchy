# Research: VS Code extension API limits & git worktrees for parallel agents

**Date of research:** 2026-08-21
**Method:** All PART A claims were checked against live official VS Code documentation (code.visualstudio.com) and the git-scm.com man pages fetched on the date above. PART B combines the official `git worktree` documentation with practitioner sources (fetched live). Anything I could not verify against a fetched source is explicitly marked **UNVERIFIED**.

---

# PART A — VS Code extension API limits

## A1. Can an extension programmatically create, split, focus and arrange its OWN webview panels? — **YES**

### Create
`vscode.window.createWebviewPanel(viewType: string, title: string, showOptions: ViewColumn | {preserveFocus: boolean, viewColumn: ViewColumn}, options?: WebviewPanelOptions & WebviewOptions): WebviewPanel` creates and shows a webview panel as a distinct editor in the editor grid.
Source: https://code.visualstudio.com/api/references/vscode-api (`window.createWebviewPanel`) and guide: https://code.visualstudio.com/api/extension-guides/webview

### Focus / reveal
`WebviewPanel.reveal(viewColumn?: ViewColumn, preserveFocus?: boolean)` — official doc text: *"Show the webview panel in a given column. A webview panel may only show in a single column at a time. If it is already showing, this method moves it to a new column."* The panel also exposes `.active`, `.visible`, `.viewColumn`, and `onDidChangeViewState`.
Source: https://code.visualstudio.com/api/references/vscode-api (`WebviewPanel`), https://code.visualstudio.com/api/extension-guides/webview#visibility-and-moving

### Arrange (columns)
`ViewColumn` is documented as: *"Denotes a location of an editor in the window. Editors can be arranged in a grid and each column represents one editor location in that grid by counting the editors in order of their appearance."* Values: `Active: -1`, `Beside: -2`, `One: 1` … `Nine: 9`. Related docs state columns *"will be created as needed up to the maximum of ViewColumn.Nine"*.
Sources: https://code.visualstudio.com/api/references/vscode-api (`ViewColumn`, `window.showTextDocument`)

### Split / layout via workbench commands
An extension can call built-in workbench commands with `vscode.commands.executeCommand`. Documented on the official Built-in Commands page:

- `moveActiveEditor` — *"Move the active editor by tabs or groups"* (args: `to`, `by`, `value`)
- `copyActiveEditor` — copy the active editor by groups
- `vscode.getEditorLayout` — *"Get Editor Layout … An editor layout object, in the same format as vscode.setEditorLayout"* (the page thus references `vscode.setEditorLayout` as the corresponding setter)
- The page notes it lists only *"a subset"* of commands; simple parameterless commands are discoverable in the default `keybindings.json`.

`workbench.action.splitEditor` (Ctrl+\) and directional variants (`workbench.action.splitEditorUp/Down/Left/Right`) are real built-in command IDs — listed in the official default keybindings reference and defined in VS Code source.
Sources: https://code.visualstudio.com/api/references/commands ; https://code.visualstudio.com/docs/reference/default-keybindings ; https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorCommands.ts

### Practical caveats (from the same docs)
- A webview panel can only ever occupy **one column at a time**; `reveal()` moves rather than duplicates it.
- Grid placement via the public API is column-oriented; fine-grained row/column cell placement of a *specific* non-active panel is not expressible through `reveal()` alone — you'd combine `reveal(column)` with the layout commands above. There is no public API that takes "this specific panel → this exact grid cell".
- Ownership/lifecycle: *"Webview panels are owned by the extension that creates them. The extension must hold onto the webview returned from createWebviewPanel"*; user-closed panels fire `onDidDispose`, after which using the panel throws. `registerWebviewPanelSerializer` restores panels across restarts.
Source: https://code.visualstudio.com/api/extension-guides/webview#lifecycle , https://code.visualstudio.com/api/references/vscode-api (`WebviewPanelSerializer`)

## A2. Can an extension style ANOTHER extension's webview or the VS Code chrome itself? — **NO (not supported)**

### Official answer
- Each webview's content is owned exclusively by the extension that set `webview.html`; webviews are described as sandboxed iframes that communicate only via message passing. There is no API to enumerate or reach into another extension's webview document. (https://code.visualstudio.com/api/extension-guides/webview ; https://code.visualstudio.com/api/references/vscode-api)
- Supported styling of the chrome is limited to contribution points: **Color Themes** (mapping UI/token IDs to colors), **File Icon Themes**, **Product Icon Themes** (https://code.visualstudio.com/api/extension-capabilities/theming). The *Extending Workbench* page lists what extensions may ADD — view containers, views, webviews, status bar items — not restyle existing surfaces (https://code.visualstudio.com/api/extension-capabilities/extending-workbench).
- Extensions can theme their OWN webview content via the documented `--vscode-*` CSS custom properties injected into their own webviews (same webview guide).

### The known hack: "Custom CSS and JS Loader"
- Extension: `be5invis.vscode-custom-css`, ~1.18M installs (https://marketplace.visualstudio.com/items?itemName=be5invis.vscode-custom-css). It **patches files inside the VS Code installation** (since v6.0 it inlines your CSS/JS into the workbench HTML; historically `electron-browser/index.html`). Requires admin/chown permissions so VS Code "can modify itself", must be re-enabled after every VS Code update, and ships a disable/restore path.
- What it breaks:
  - VS Code flags the install as corrupted / appends an **"[Unsupported]"** suffix to the title bar because on-disk checksums no longer match. Microsoft's official position in the tracking issue: *"As we do not support extensions that patch our bits on disk, we would not want to push a change that reverts this UI annoyance. Please uninstall this extension."* (https://github.com/Microsoft/vscode/issues/30556). A companion "Fix VSCode Checksums" extension exists to suppress the warning (referenced from the Custom CSS marketplace page).
  - It breaks repeatedly across VS Code releases (layout changes move `workbench.html`; e.g. issues about VS Code 1.70, 1.92, 1.102: https://github.com/be5invis/vscode-custom-css/issues/168 , /222 , /264) and conflicts with similar patchers such as Apc Customize UI++ (issue #228).
- Would such CSS reach *inside* another extension's webview? **Inference, clearly labeled:** standard browser rules prevent a parent document's CSS from styling the internals of a cross-origin iframe; VS Code documents webviews as iframes/sandboxed contexts. So Custom-CSS-style injection plausibly restyles the chrome and the iframe element box, but not the other webview's DOM. This mechanism is my inference from documented behavior, not a quoted doc statement — treat as UNVERIFIED as an absolute claim.

Related but distinct: there is no supported API for one extension to inject CSS into another extension's webview, full stop. Nothing in vscode.d.ts exposes another extension's `Webview` object.

## A3. Practical limits on animation/rendering inside a webview, and many webviews at once

Officially documented constraints (all from https://code.visualstudio.com/api/extension-guides/webview and https://code.visualstudio.com/api/references/vscode-api unless noted):

- **Resource cost:** *"Webviews are resource heavy and run in a separate context from normal extensions"*; the guide opens with "Should I use a webview?" guidance to use them sparingly.
- **Background destruction:** when a panel moves to a background tab, its content (the iframe document) is destroyed and recreated from `webview.html` when shown again — CSS animations/canvas state reset unless you persist state (`getState`/`setState`) or use `retainContextWhenHidden`.
- **`retainContextWhenHidden`:** keeps the hidden iframe alive *"similarly to a background tab"*, but has *"high memory overhead and should only be used if your panel's context cannot be quickly saved and restored."* ⚠️ **Documented discrepancy:** the guide says scripts *"keep running"* while hidden; the API reference says *"its scripts and other dynamic content are suspended"* until re-shown. Both statements appear in current official docs; expect background throttling like a browser background tab.
- **Message delivery:** `postMessage` is only delivered to *live* webviews (visible, or hidden with `retainContextWhenHidden`) — relevant if the extension host drives animation frames into the webview.
- **Scripts & CSP:** JavaScript is disabled unless `enableScripts: true`; CSP is recommended and can further restrict what loads (e.g., blocking remote assets your animation needs). Inline styles/scripts are implicitly disabled under strict CSP.
- **Media codecs:** video limited to H.264/VP8; audio to Wav/Mp3/Ogg/Flac (AAC audio in .mp4 does NOT play) — matters for video-based animation.
- **Web Workers:** supported but loadable only from `data:`/`blob:` URIs; no `importScripts`/dynamic `import()` in workers (bundle to a single file).
- **Accessibility:** webviews get `vscode-reduce-motion` / `vscode-using-screen-reader` body classes; extensions are expected to honor reduced-motion preferences for animations.
- **Canvas/WebGL/SVG/CSS animations:** the guide states *"Webview scripts can do just about anything that a script on a normal webpage can"* — i.e., these are standard Chromium rendering features available to webviews. **No official FPS budget, GPU-acceleration guarantees, or maximum canvas size is documented anywhere I could find — UNVERIFIED/undocumented.**
- **Many webviews at once:** there is **no officially documented cap** on the number of webview panels per window, and no documented per-webview memory figure beyond the qualitative "resource heavy"/"high memory overhead" statements. The practical limit is memory/CPU: every visible webview is a live renderer context, and every `retainContextWhenHidden` webview adds persistent overhead. Any concrete number (e.g., "N webviews max") would be invented — none exists in the docs (**UNVERIFIED by design; do not rely on one**).

## A4. Supported attention indicator (badge/glow/highlight) on a panel you do NOT own? — **NO**

What the stable API actually offers:

- **`TabGroups` / `Tab`** (https://code.visualstudio.com/api/references/vscode-api): read-only observation of the editor area — properties (`all`, `activeTabGroup`, tab `label`/`isActive`/`isDirty`/`isPinned`), events, and exactly one mutating method, `close(...)`. You can *detect* another extension's webview tab (`TabInputWebview` exists as a tab input type) but there is **no API to badge, decorate, recolor, glow, or even focus a specific foreign tab**.
- **`TreeView.badge?: ViewBadge`** — badges exist only for tree views **your extension created** via `createTreeView` (*"The badge to display for this TreeView"*). Same for `StatusBarItem` and `window.setStatusBarMessage` — they render in status bar areas you own, not on arbitrary panels.
- **`window.registerFileDecorationProvider` / `FileDecoration(badge, tooltip, color)`** — a stable API, but URI-based: it decorates *resources* (Explorer, Open Editors, breadcrumbs, and editor tabs when the user enables `workbench.editor.decorations.colors` / `workbench.editor.decorations.badges`). A webview panel is not backed by a file URI, so this cannot target another extension's webview panel. History/finalization: https://github.com/Microsoft/vscode/issues/54938 ; tab-decoration feature: https://github.com/microsoft/vscode/issues/49382
- **Notifications** (`showInformationMessage` etc.) and revealing **your own** panel remain the supported attention mechanisms.

Conclusion: for a panel/tab your extension doesn't own, there is **no supported badge/glow/highlight API**. The only ways to fake it are the on-disk patching hacks from A2 (with all their breakage) — or asking the owning extension to expose something (e.g., a command you invoke, since `commands.executeCommand` *can* run another extension's contributed commands; that's coordination, not styling).

---

# PART B — Git worktrees for parallel agents

## B1. Creation — the standard pattern

One repository, many working directories. From the official man page (https://git-scm.com/docs/git-worktree): *"A git repository can support multiple working trees, allowing you to check out more than one branch at a time."* Linked worktrees share everything except per-worktree files (`HEAD`, `index`); each linked worktree gets a private `$GIT_DIR/worktrees/<name>` directory and a `.git` *file* pointing back to the repo.

Canonical commands:

```bash
git switch main && git pull --ff-only          # start from fresh main
git worktree add ../proj-agent-auth   -b agent/auth   origin/main
git worktree add ../proj-agent-tests  -b agent/tests  origin/main
git worktree list                     # verify; --porcelain for scripts
```

- `git worktree add <path>` alone auto-creates a branch named after the path's basename; `-b <branch> [<commit-ish>]` names it explicitly; `--lock [--reason]` locks at creation without a race.
- Practitioner consensus: keep agent worktrees **outside** the main checkout (sibling directories), one worktree = one agent = one task, branched off **fresh `origin/main`**, never off a stale local ref (branching from stale bases caused silent-regression incidents in multi-agent setups — https://www.jeffkliu.com/articles/running-ai-agents-in-parallel).
- Optional advanced layout: convert to a **bare repo** and make every checkout (including main) a worktree underneath it — used by the pnpm repo itself (https://pnpm.io/git-worktrees).
- Agent harnesses increasingly automate this: Claude Code reportedly supports a `--worktree` flag, auto-named branches like `worktree-<name>`, `.claude/worktrees/` locations, and `isolation: worktree` subagent frontmatter (**as reported by third-party articles; I did not fetch Anthropic's primary docs — UNVERIFIED against primary source**: https://zylos.ai/research/2026-02-22-git-worktree-parallel-ai-development/ , https://tim-schipper.nl/en/blog/git-worktrees-parallel-coding-agents , https://backgrind.com/blog/git-worktrees-parallel-agents/).

## B2. Per-agent branch naming

- Common conventions seen across sources: `agent/<task>` (e.g. `agent/fix-auth-bug`), `feature/<task>`, `<type>-<task>-<agent-id>`; Claude Code's automatic `worktree-<name>`. Directory name should mirror the branch and identify the owner/task ("a directory called `tmp2` is how future-you ends up debugging the wrong checkout at 2 a.m." — https://www.tonyreviewsthings.com/git-worktrees-for-agents/).
- Prefer task-based over tool-based names (agents get reassigned): https://agents-ui.com/blog/git-worktrees-for-ai-agent-development/
- **Git enforces one branch ↔ one worktree:** `add` *"refuses to create a new worktree when <commit-ish> is a branch name and is already checked out by another worktree"* unless `--force` (which you should not use for agents). This is the guardrail that makes "never share a branch between two agents" enforceable. (https://git-scm.com/docs/git-worktree)

## B3. node_modules / build artefacts

- A worktree checks out **tracked files only**: `node_modules`, `.env`, `dist/`, `venv/` etc. are absent. Every worktree needs its own dependency install before an agent can build/test (https://git-scm.com/docs/git-worktree implies tracked-only checkout; explicitly discussed in https://backgrind.com/blog/git-worktrees-parallel-agents/ and https://tim-schipper.nl/en/blog/git-worktrees-parallel-coding-agents).
- Cost: roughly 200–500 MB per JS worktree; anecdotes of multi-GB blowups when automation spawns many worktrees (9.8 GB in 20 minutes reported at https://zylos.ai/research/2026-02-22-git-worktree-parallel-ai-development/).
- Mitigations:
  - **pnpm global virtual store** (`enableGlobalVirtualStore: true`): each worktree's `node_modules` holds symlinks into one shared content-addressable store → near-zero marginal disk and near-instant installs; per-worktree trees still allow different dep versions per branch (https://pnpm.io/git-worktrees).
  - Symlinking a single shared `node_modules` between worktrees works only if all branches use identical dependency versions — fragile; noted as a trade-off, not a recommendation (https://agents-ui.com/blog/git-worktrees-for-ai-agent-development/).
  - Claude Code's `.worktreeinclude` copies selected gitignored files (e.g. `.env*`) into each worktree (**third-party-reported; UNVERIFIED against primary docs** — https://tim-schipper.nl/en/blog/git-worktrees-parallel-coding-agents).
  - macOS APFS copy-on-write clones for dependency dirs (reported at zylos.ai; **environment-specific, UNVERIFIED**).
- What worktrees do NOT isolate: ports, local databases, Docker daemon, Redis, build caches outside the repo. Two agents running dev servers will collide; assign per-worktree ports/db names or use containers (https://tim-schipper.nl/en/blog/git-worktrees-parallel-coding-agents , https://zylos.ai/research/2026-02-22-git-worktree-parallel-ai-development/).

## B4. Merge-back strategy

Because all worktrees share one object database, commits made anywhere are immediately visible everywhere, and agent branches merge like any other branch (https://git-scm.com/docs/git-worktree ; https://nx.dev/blog/git-worktrees-ai-agents):

1. **PR-based (most common):** agent pushes its branch → PR → CI + review → merge → delete branch → `git worktree remove <path>`. Keep the main checkout parked on `main` as the integration target (https://agents-ui.com/blog/git-worktrees-for-ai-agent-development/).
2. **Sequential local merges (safest offline):** merge one agent branch at a time into `main`, resolving before the next, shrinking conflict surface (https://zylos.ai/research/2026-02-22-git-worktree-parallel-ai-development/).
3. **Rebase-before-PR:** each worktree rebases onto latest `origin/main` before opening its PR; linear history, smaller conflicts (same source).
4. **Pre-flight conflict detection:** `git merge-tree $(git merge-base A B) A B` between agent pairs before long tasks finish (same source).
5. **Recovery of stale/diverged agent branches:** never force-push a branch another agent may hold; create a fresh worktree off `origin/main` and cherry-pick only genuinely-new commits (https://www.jeffkliu.com/articles/running-ai-agents-in-parallel).
6. **Automated lifecycle example:** `opencode-worktree` creates `agent/<task>` branches, records the parent branch in marker files, serializes concurrent merges with a lock file, aborts on conflict listing conflicting files, and removes empty branches without merging (https://github.com/danhenton/opencode-worktree).
7. Cleanup discipline: `git worktree remove` refuses unclean worktrees (untracked files or modifications) unless `--force` — that refusal is a feature; then `git worktree prune` for metadata left after manual deletions; `lock`/`unlock` protect worktrees on unmounted/network volumes (https://git-scm.com/docs/git-worktree).

## B5. Common failure modes

From the man page plus practitioner reports:

1. **"Branch already checked out" errors** — attempting to check out the same branch in two worktrees; git refuses by design (use distinct branches per agent). (git-scm.com)
2. **Stale/orphaned worktrees** — deleting a worktree directory manually leaves admin files in `$GIT_DIR/worktrees`; fix with `git worktree prune` (or `repair` if paths moved). Accumulation wastes disk and confuses tooling. (git-scm.com ; tonyreviewsthings.com)
3. **Missing ignored files** — `.env`, local config, `node_modules` don't carry over; agents fail mysteriously or reinstall from scratch. (backgrind.com ; tim-schipper.nl)
4. **Disk blow-up** — duplicated dependencies/build outputs across many worktrees. (zylos.ai ; pnpm.io motivation)
5. **Shared-state foot-guns inside `.git`:** stashes are shared across all worktrees (an agent popping a stash can hit another agent's entries); branches deleted/reset affect everyone; `reset --hard`/force operations on a branch another worktree stands on are unprotected. Worktrees isolate *files*, not destructive git history ops. (tim-schipper.nl)
6. **Base drift** — worktrees branched from stale or moving refs produce silent regressions vs. what's already merged; always branch from a recorded, fresh ref. (jeffkliu.com ; tonyreviewsthings.com)
7. **Submodules** — official BUGS section: *"Multiple checkout in general is still experimental, and the support for submodules is incomplete. It is NOT recommended to make multiple checkouts of a superproject."* Also `worktree move` refuses for worktrees containing submodules. (git-scm.com)
8. **Config surprises** — repository `config` is shared across worktrees by default; per-worktree config requires `extensions.worktreeConfig=true` (+ `git config --worktree`). Hooks/CI assumptions may not hold per-tree. (git-scm.com)
9. **Runtime collisions outside git's scope** — ports, DBs, containers, caches shared across worktrees (see B3). (tim-schipper.nl)
10. **Attention fragmentation** — with >3–5 agents the bottleneck stops being file conflicts and becomes noticing which terminal needs input; tooling adds per-tab alerts. (backgrind.com)

---

## Verification notes (honesty ledger)

- **Verified live (2026-08-21)** against: code.visualstudio.com API reference, webview guide, Built-in Commands reference, default keybindings reference, Theming and Extending Workbench pages; marketplace page for `be5invis.vscode-custom-css`; microsoft/vscode GitHub issues #30556, #49382, #54938; be5invis/vscode-custom-css issues #168/#222/#228/#264; git-scm.com `git-worktree` man page; pnpm.io, nx.dev, jeffkliu.com, tonyreviewsthings.com, tim-schipper.nl, backgrind.com, agents-ui.com, zylos.ai, github.com/danhenton/opencode-worktree.
- **Explicitly UNVERIFIED:** any numeric cap on simultaneous webviews or FPS/memory budgets (none exists in official docs); whether workbench-injected CSS can style cross-origin webview iframe internals (my inference from documented iframe sandboxing); Claude Code `--worktree` / `isolation: worktree` / `.worktreeinclude` specifics (third-party reports only; primary vendor docs not fetched); APFS copy-on-write trick.
