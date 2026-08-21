# Prior Art: Desktop Apps for Running N Coding Agents in Parallel

**Research date:** 2026-08-21
**Method:** Live web search and page fetches performed on the research date. Web access was **working** during this session; every factual claim below carries a source URL retrieved that day. Claims I could not pin to a source are marked **UNVERIFIED**. No version numbers, dates, or features are invented.

**Scope:** Tools whose core pitch is "run multiple AI coding agents concurrently against one repository," focusing on standalone desktop apps (plus two near-misses included for completeness: a local web UI and a cloud service, both clearly labeled).

---

## 1. Conductor (conductor.build) — Melty Labs

### What it does
A native macOS desktop app that lets you spin up many coding-agent sessions at once, each against its own copy of your repository, then review and merge the results. Its launch tagline was literally "Run a bunch of Claude Codes in parallel" ([YC launch page](https://www.ycombinator.com/launches/OHk-conductor-run-a-bunch-of-claude-codes-in-parallel)). The maker is Melty Labs, a YC S24 team that previously built the open-source Melty code editor ([madewithlove review, Mar 2026](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/)).

### Isolation model
- The unit of work is a **workspace**: per the docs, "Each workspace is backed by a git worktree, gets its own branch and working directory" ([Conductor workflows page](https://www.conductor.build/workflows/run-parallel-claude-codes)). So: **git worktrees + one branch per task**, not containers, for local work.
- Local workspaces copy **only git-tracked files** ("Each workspace is an isolated copy and branch of your Git repo. Conductor only copies files tracked in git." — quoted in [The New Stack hands-on, Oct 2025](https://thenewstack.io/a-hands-on-review-of-conductor-an-ai-parallel-runner-app/)).
- Setup scripts, run scripts, a `CONDUCTOR_PORT` env var so parallel workspaces get separate port ranges, and a `CONDUCTOR_IS_LOCAL` guard are provided to make each worktree runnable ([parallel Claude Code guide](https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions)).
- **Cloud workspaces** (paid tiers) run in **Vercel sandboxes** in us-east-1, each an Amazon Linux 2023 machine with Node.js 24, Python 3, git, gh, tmux, etc. preinstalled ([pricing FAQ](https://www.conductor.build/pricing)) — so container-style isolation exists, but only in the cloud product.

### UI
A three-pane layout: workspace list sidebar, chat/prompt area, terminal pane, and a diff view; plus checks tracking, PR creation, merge, and archive flows. You can start a workspace from a GitHub issue, Linear issue, PR, branch, or blank task ([docs intro](https://www.conductor.build/docs), [parallel-agents guide](https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions)). Third-party reviews also describe checkpoints (rollback snapshots), "Spotlight testing" (sync changes back to the main checkout to test), and a multi-model mode comparing Claude vs. Codex on the same prompt ([madewithlove](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/)). There is no repo graph/dependency visualization that I found — **UNVERIFIED whether one exists at all**.

### Agent backends
Claude Code, OpenAI Codex, Cursor, and OpenCode ([docs intro](https://www.conductor.build/docs)). At launch it was Claude-only ([Vibe Sparking review, Aug 2025](https://www.vibesparking.com/en/blog/ai/claude-code/conductor/2025-08-14-conductor-slash-queues-hands-on/), quoting the then-FAQ). Conductor bundles its own pinned Claude Code and Codex binaries for compatibility ([docs FAQ](https://www.conductor.build/docs/faq)); you bring your own subscriptions/API keys.

### Form factor
Standalone macOS app. Not IDE-embedded; it deliberately "is not an editor" and sends you to Cursor/VS Code for hand-editing ([alteredcraft essay, Feb 2026](https://writing.alteredcraft.com/p/conductor-and-the-agent-orchestration)). A Windows waitlist existed as of Oct 2025 ([The New Stack](https://thenewstack.io/a-hands-on-review-of-conductor-an-ai-parallel-runner-app/)), and the app was still described as macOS-only in Feb 2026 ([alteredcraft](https://writing.alteredcraft.com/p/conductor-and-the-agent-orchestration)). A mobile app is advertised as "coming very soon" on paid plans ([pricing](https://www.conductor.build/pricing)).

### Pricing / licence
Proprietary (no public source repo found — **UNVERIFIED that any exists**). Current pricing page: **Free** tier (local workspaces, bring-your-own keys); **Pro $50/mo** (cloud workspaces, API, multiplayer, mobile app); **Teams $60/user/mo** (multiplayer collaboration, admin portal); Enterprise ([pricing](https://www.conductor.build/pricing)). Note a discrepancy I cannot resolve: the docs FAQ still says "Right now we don't [make money]. We're a small team running on seed funding…" ([docs FAQ](https://www.conductor.build/docs/faq)) — likely stale relative to the pricing page, but I can't confirm which is newer.

### BIGGEST WEAKNESS
**Local agents run unsandboxed with your full user permissions, and the whole workflow is macOS-gated.** The docs state plainly: "commands still run on your Mac with your user permissions unless you configure stricter controls" ([security docs reference via the parallel-agents guide](https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions)); an independent long-term user agrees there is "no sandboxing" ([alteredcraft](https://writing.alteredcraft.com/p/conductor-and-the-agent-orchestration)). Secondary weaknesses repeatedly reported by reviewers: worktrees exclude untracked files so `.env`/`node_modules` bootstrap is real friction ([madewithlove](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/)); token spend multiplies linearly with agent count ([madewithlove](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/)); agents have no memory across workspaces/sessions ([madewithlove](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/)); and automatic renaming of workspaces/branches after the first prompt confused at least one reviewer ([The New Stack](https://thenewstack.io/a-hands-on-review-of-conductor-an-ai-parallel-runner-app/)).

---

## 2. Crystal (stravu/crystal) — Stravu ⚠️ DEPRECATED

### What it does
An open-source Electron desktop app for running multiple Claude Code (and later Codex) sessions in parallel, each in its own git worktree, with session persistence, diffs, and git operations in one window. Built internally at Stravu and shipped publicly in June 2025, marketed as the first "IVE" (Integrated Vibe Environment) ([announcement blog, Jun 12 2025](https://nimbalyst.com/blog/crystal-supercharge-your-development-with-multi-session-claude-code-management/)). Repo: [github.com/stravu/crystal](https://github.com/stravu/crystal) (~3.1k stars, 196 forks at time of fetch).

**Critical status fact:** Crystal is **deprecated as of February 2026** and replaced by **Nimbalyst**, by the same team. The repo README states "Crystal Is Now Nimbalyst… Deprecated: February 2026" ([repo README](https://github.com/stravu/crystal)); the final release was v0.3.5 with no commits or releases since Feb 26, 2026 ([Ry Walker research page, Feb 2026](https://rywalker.com/research/crystal)).

### Isolation model
Pure **git worktrees**: each session gets its own worktree via `git worktree add`, with branch reuse or creation, automatic cleanup on session deletion, and handling for empty repos ([project CLAUDE.md architecture doc](https://github.com/stravu/crystal/blob/main/CLAUDE.md)). No containers. Sessions spawn through node-pty wrapping the Claude Code SDK (`@anthropic-ai/claude-code`), with SQLite (Better-SQLite3) persisting sessions across restarts ([CLAUDE.md](https://github.com/stravu/crystal/blob/main/CLAUDE.md)).

### UI
Sidebar of sessions with color-coded status dots — initializing / running / waiting-for-input / completed / new-activity / error ([CLAUDE.md](https://github.com/stravu/crystal/blob/main/CLAUDE.md)); syntax-highlighted diff viewer with commit history stats and uncommitted-change detection; rebase-from-main and squash-and-rebase buttons with command-preview tooltips; per-session run-script execution with a dedicated logs tab; AI-generated session names; numbered session templates for fan-out ([blog post](https://nimbalyst.com/blog/crystal-supercharge-your-development-with-multi-session-claude-code-management/), [releases page](https://github.com/stravu/crystal/releases)). Later releases added panel-based workspaces (multiple agent/terminal panels per session) and a merge-and-archive action ([CHANGELOG](https://github.com/stravu/crystal/blob/main/CHANGELOG.md)). No graph view — **UNVERIFIED whether any dependency/graph visualization existed**.

### Agent backends
Claude Code first; **OpenAI Codex support added later** ([releases](https://github.com/stravu/crystal/releases)); final versions could create both agent types from one prompt and run multiple agents per worktree ([CHANGELOG](https://github.com/stravu/crystal/blob/main/CHANGELOG.md)). Works with Amazon Bedrock via Claude Code settings ([Ry Walker research](https://rywalker.com/research/crystal)).

### Form factor
Standalone Electron desktop app, macOS-first. Prebuilt binaries were macOS; Windows/Linux required building from source with pnpm and were less tested ([SourcePulse summary](https://www.sourcepulse.org/projects/11026576), [Ry Walker research](https://rywalker.com/research/crystal)). Not IDE-embedded.

### Pricing / licence
**Free, MIT-licensed** ([repo LICENSE / README](https://github.com/stravu/crystal)). You pay only your own model access.

### Successor (for completeness)
**Nimbalyst** ([nimbalyst.com](https://nimbalyst.com/), [github.com/Nimbalyst/nimbalyst](https://github.com/nimbalyst/nimbalyst)) continues the concept: MIT-licensed Electron app for **macOS, Windows, Linux** plus an iOS/Android mobile companion; supports Claude Code, Codex, OpenCode (alpha), and GitHub Copilot (alpha); adds a session kanban board, visual editors (markdown/mockups/diagrams/CSV), and optional git worktrees per session ([GitHub README](https://github.com/nimbalyst/nimbalyst), [pricing page](https://nimbalyst.com/pricing/) — free for individuals, Teams $20/user/mo, free during beta). Migration from Crystal is point-at-your-folder; same CLI underneath ([nimbalyst.com/crystal](https://nimbalyst.com/crystal/)).

### BIGGEST WEAKNESS
**It is dead software.** The maintainers' own v0.3.5 notes say Crystal "will not be updated in the future"; breakage against future Claude Code/Codex versions will go unfixed ([Ry Walker research](https://rywalker.com/research/crystal), [repo README](https://github.com/stravu/crystal)). Even at its peak it was macOS-centric, required separately installed and authenticated CLIs, consumed a full worktree copy of the repo per session (disk-heavy on monorepos), and had no team/cloud features ([Ry Walker research](https://rywalker.com/research/crystal)).

---

## 3. Similar tools (2025–2026)

### 3a. Sculptor — Imbue
- **What:** Open desktop app for running coding agents in parallel; each workspace is "an isolated worktree with its own branch, terminal, and diff view"; pitched as "Run 5+ agents on 5+ tickets at the same time" ([product page](https://imbue.com/product/sculptor/), [GitHub README](https://github.com/imbue-ai/sculptor)).
- **Isolation:** git worktrees + branches locally; an **experimental container backend** (Docker or remote) exists behind a flag ([README docs index](https://raw.githubusercontent.com/imbue-ai/sculptor/main/README.md)). Integration style is unusual: agents push to a **local git remote** and you `git fetch && git checkout` from your normal repo — "Sculptor stays out of your editor, your merge tool, and your shell" ([product page](https://imbue.com/product/sculptor/)).
- **UI:** all active agents visible from one surface, each with worktree/branch/terminal/diff; command palette; bundled "skills" that themselves run as agents spawning subagents ([product page](https://imbue.com/product/sculptor/), [README](https://raw.githubusercontent.com/imbue-ai/sculptor/main/README.md)).
- **Backends:** integrated support for the **Pi agentic harness** and **Claude Code**, plus "any terminal-based agents" ([README](https://raw.githubusercontent.com/imbue-ai/sculptor/main/README.md)).
- **Form factor:** standalone desktop app — Mac (Apple Silicon), Linux x64/ARM64; **no Windows, no mobile** ([README downloads](https://raw.githubusercontent.com/imbue-ai/sculptor/main/README.md)).
- **Pricing/licence:** free; Imbue describes it as open source, but the README explicitly says they currently lack bandwidth for external contributions ("We know it's not truly open source until the community is involved") ([README](https://raw.githubusercontent.com/imbue-ai/sculptor/main/README.md)). Exact SPDX licence: **UNVERIFIED** (I did not retrieve the LICENSE file).
- **BIGGEST WEAKNESS:** Self-declared "experimental research preview" where "things will not be perfect… may change quickly and significantly" ([README](https://raw.githubusercontent.com/imbue-ai/sculptor/main/README.md)) — combined with no Windows build and a closed-to-contributors governance model, it's the least settled of the survivors.

### 3b. Vibe Kanban — Bloop AI ⚠️ COMPANY SHUT DOWN
- **What:** Local orchestration UI launched via `npx vibe-kanban`: a kanban board where each task/card runs a coding agent in its own **git worktree** with branch, terminal, and dev server; diff review with inline comments sent back to the agent; built-in browser preview with devtools; PR creation with AI descriptions ([vibekanban.com](https://vibekanban.com/), [GitHub README](https://github.com/BloopAI/vibe-kanban/)). Technically a **local web UI, not a native desktop app** — included here because it is constantly named alongside the desktop tools.
- **Isolation:** git worktrees per task/workspace ([features docs](https://vibe-kb.com/features/)).
- **Backends:** the widest list I found — Claude Code, Codex, Gemini CLI, GitHub Copilot, Amp, Cursor CLI, OpenCode, Droid, CCR, Qwen Code ("10+ coding agents") ([GitHub README](https://github.com/BloopAI/vibe-kanban/)).
- **Status:** Bloop **shut down April 10, 2026**; the project continues as community-maintained open source; remote services (shared kanban issues/comments/orgs) were removed after 30 days, moving it to fully-local architecture; refunds issued ([shutdown post](https://www.vibekanban.com/blog/shutdown)). Stated reason: "the vast majority are free users and we couldn't find a business model" (Louis Knight-Webb, quoted in [Nimbalyst's analysis, May 2026](https://nimbalyst.com/blog/vibe-kanban-after-bloop-whats-next/)). Licence post-shutdown reported as Apache 2.0 by that same secondary source (**UNVERIFIED directly against the repo LICENSE**).
- **BIGGEST WEAKNESS:** Orphaned by its company — the canonical example of the category's monetization failure; teams wanting shared boards must now self-host/community-maintain it ([shutdown post](https://www.vibekanban.com/blog/shutdown)).

### 3c. Superset — superset.sh
- **What:** Source-available desktop app to "run 100+ parallel coding agents on your machine," each in its own isolated git worktree; positions itself purely as the orchestration layer around any CLI agent ([superset.sh](https://superset.sh/)).
- **Isolation:** git worktree + branch per agent/task ([superset.sh](https://superset.sh/)).
- **UI:** dashboard with diff review before merging, persistent terminals surviving restarts, port management, cron-like scheduled "automations" ([superset.sh](https://superset.sh/)).
- **Backends:** any CLI agent — names Claude Code, OpenAI Codex, OpenCode, Gemini CLI, Copilot, Cursor Agent ([superset.sh](https://superset.sh/)).
- **Form factor / extras:** macOS app, experimental Linux AppImage, **no Windows yet**; ships a CLI, TypeScript SDK, and MCP server for programmatic control ([superset.sh](https://superset.sh/)).
- **Pricing/licence:** free; **Elastic License 2.0** (source-available, per the vendor's own wording) ([superset.sh](https://superset.sh/)).
- **BIGGEST WEAKNESS:** Maturity and independence are hard to assess — I found no independent hands-on reviews, and the macOS-only stance plus non-OSI licence limit adoption versus MIT alternatives. (Absence of reviews is my observation from searching, not proof none exist.)

### 3d. ParallelCode — parallelcode.dev
- **What:** A free desktop **git worktree manager GUI**: create/switch/delete worktrees visually and launch a separate Cursor, Claude Code, Copilot, Aider, or Cline window per worktree; supports opening related repos as one workspace ([parallelcode.dev](https://parallelcode.dev/)).
- **Isolation:** git worktrees (it is essentially a worktree GUI; the agents themselves are whatever you launch) ([parallelcode.dev](https://parallelcode.dev/)).
- **BIGGEST WEAKNESS:** Thinnest orchestration of the group — dispatching sub-tasks to local background agents is listed as "Coming soon — join the waitlist" ([parallelcode.dev](https://parallelcode.dev/)), i.e., its headline differentiator was unshipped at retrieval time.

### 3e. Terragon Labs ⚠️ SHUT DOWN (cloud, included for contrast)
- **What:** A *cloud* counterpart to these desktop tools: delegate tasks to Claude Code, Codex, Gemini, OpenCode, or Amp running in isolated remote sandbox containers; agents open PRs when done; `terry` CLI and MCP server for local handoff; GitHub/Slack triggers ([terragon-oss README](https://github.com/terragon-labs/terragon-oss), [docs](https://docs.terragonlabs.com/docs/integrations/cli)).
- **Isolation:** per-task sandbox **containers** with their own repo copy — the main non-worktree data point in this space ([terragon-oss README](https://github.com/terragon-labs/terragon-oss)).
- **Status:** **Service shut down February 9, 2026**; sandboxes terminated; code open-sourced at [terragon-labs/terragon-oss](https://github.com/terragon-labs/terragon-oss); users redirected to Claude Code Web / Codex Web ([terragonlabs.com](https://www.terragonlabs.com/)).
- **BIGGEST WEAKNESS:** Dead, and its death illustrates the cloud variant's structural problem — running other people's sandboxes costs real money with weak willingness to pay.

---

## Cross-cutting findings

1. **Worktrees won, containers lost (locally).** Every desktop tool here isolates via git worktrees + a branch per task. Containers appear only in cloud products (Conductor Cloud on Vercel sandboxes, Terragon) or experimental flags (Sculptor's Docker backend). Sources: respective pages cited above.
2. **Brutal category churn in ~12 months.** Of the notable entrants: Crystal deprecated (Feb 2026), Terragon shut down (Feb 9, 2026), Vibe Kanban's company shut down (Apr 10, 2026). The stated causes are consistently "no business model," not product failure ([Nimbalyst/VK analysis](https://nimbalyst.com/blog/vibe-kanban-after-bloop-whats-next/), [terragonlabs.com](https://www.terragonlabs.com/)). Apparent survivors: Conductor (now charging $50–60/mo tiers), Sculptor (research preview), Superset, Nimbalyst.
3. **Shared gaps nobody has solved:** agents executing with full local user permissions (no OS-level sandboxing in local modes — [Conductor docs](https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions)); worktree bootstrap friction from untracked files like `.env`/`node_modules` ([madewithlove](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/)); linear token-cost multiplication with agent count ([madewithlove](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/)); and the human reviewer remaining the bottleneck — a framing Vibe Kanban itself used in its marketing ([vibekanban.com](https://vibekanban.com/)).
4. **Adjacent prior art worth noting:** Anthropic ships a native `claude --worktree` CLI flow that Conductor's docs explicitly position against ([Conductor guide](https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions)); Claude Squad offers a terminal-native tmux + worktrees approach per [madewithlove](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/) (not independently verified by me — treat details as **UNVERIFIED** beyond that citation).

---

## Verification statement

Web access was functional throughout this session (multiple successful searches and page fetches on 2026-08-21). Every claim above links to a page retrieved during this session. Items marked **UNVERIFIED**: Sculptor's exact licence file; Vibe Kanban's post-shutdown Apache 2.0 licence (secondary source only); existence of any graph/dependency views in Conductor or Crystal; whether Conductor publishes source code; Claude Squad details. I did not test any of these applications hands-on; UI descriptions come from vendor docs, screenshots' captions, and third-party reviews as cited.
