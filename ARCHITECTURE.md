# Orchy — Architecture & Feature Surface Spec

> **Note.** This is the design document the project was built from, and parts of
> it describe decisions that have since been revised — the agent terminals in an
> editor grid became one panel window, and the sidebar tree became a badge on its
> tab. It is kept because the reasoning still explains why the pieces are shaped
> the way they are. The README describes what exists today.


**Status:** draft for review. Nothing built yet.
**Scope of v1:** terminal-based agentic session grid in VS Code, git-worktree isolation per agent, OpenCode as the first backend, node-graph webview as the topology view.

---

## 0. The one principle everything else follows from

> **The extension host owns all state. Every surface is a disposable renderer.**

Terminals get closed. Webviews get destroyed when backgrounded. VS Code restarts. None of that may lose orchestration state. Surfaces rebuild themselves from a snapshot the host hands them.

This is what makes the session surface swappable later (terminal → webview) without touching the orchestrator, and what makes the background-webview-destruction problem a non-issue rather than something to pay `retainContextWhenHidden` memory to avoid.

---

## 1. Component map

```
┌──────────────────────────────────────────────────────────────┐
│  Orchestrator agent (Claude Code / any MCP client)           │
│  Runs in the user's existing chat, left sidebar              │
└───────────────────────┬──────────────────────────────────────┘
                        │ MCP (stdio)
                ┌───────▼────────┐
                │ orchy-mcp      │  thin: translates tool calls → daemon RPC
                └───────┬────────┘
                        │ HTTP+SSE on 127.0.0.1, token from .orchy/daemon.json
┌───────────────────────▼──────────────────────────────────────┐
│  EXTENSION HOST  (the brain — all state lives here)          │
│                                                              │
│   SessionRegistry ──── projection of ────► .orchy/events.jsonl│
│        │                                    (append-only,     │
│        │                                     source of truth) │
│        ├── WorktreeManager    git worktree lifecycle          │
│        ├── GridManager        terminal slots + layout         │
│        ├── BackendRegistry    OpenCode | Agy | CLI adapters   │
│        └── DeliverableVerifier                                │
└───┬──────────────────┬──────────────────┬────────────────────┘
    │                  │                  │
┌───▼──────┐  ┌────────▼────────┐  ┌──────▼──────────┐
│ Terminals│  │ Graph webview   │  │ Sidebar TreeView│
│ (editor  │  │ (topology only) │  │ (+ native badge)│
│  grid)   │  │                 │  │                 │
└──────────┘  └─────────────────┘  └─────────────────┘
```

**Why the MCP server is separate from the extension:** the orchestrator agent spawns its MCP servers as subprocesses; it cannot reach into the VS Code extension host directly. `orchy-mcp` is deliberately dumb — it holds no state, it just forwards. If the extension isn't running, its tools return a clear "Orchy is not active in any window" error rather than half-working.

---

## 2. Data model

### 2.1 Event log — `.orchy/events.jsonl`

Append-only, one JSON object per line. **This is the source of truth.** Everything else is a projection that can be rebuilt by replaying it.

```jsonc
{"t":"2026-08-21T03:14:22Z","seq":41,"session":"ui-1","type":"status","status":"waiting_input"}
{"t":"...","seq":42,"session":"ui-1","type":"tool","name":"edit","target":"src/App.tsx"}
{"t":"...","seq":43,"session":"ui-1","type":"message","to":"api-1","summary":"needs /users shape"}
{"t":"...","seq":44,"session":"api-1","type":"deliverable","path":"src/routes/users.ts","verified":true}
```

Rotation at 50MB → `events.1.jsonl`. The graph reads a windowed tail, never the whole file.

### 2.2 Session

```ts
interface Session {
  id: string                    // "ui-1"  — stable, human-readable, used as branch suffix
  name: string                  // "Frontend — settings page"
  role: string                  // "ui" | "backend" | "ml" | "docs" | free text
  status: SessionStatus
  backend: { type: 'opencode' | 'agy' | 'cli', handle: string, model?: string }
  worktree: { path: string, branch: string, baseRef: string, baseSha: string }
  surface: { terminalId?: string, gridSlot?: number, visible: boolean }
  deliverables: Deliverable[]
  contract?: Contract           // guardrails, see §6
  budget: { tokensUsed: number, costEstimate: number, cap?: number }
  createdAt: string; lastEventAt: string
}

type SessionStatus =
  | 'spawning'          // worktree + terminal being created
  | 'running'           // backend actively working
  | 'waiting_input'     // blocked on a human — THE state the whole UI exists to surface
  | 'idle_unverified'   // backend says done, deliverables NOT confirmed  ← see §5
  | 'complete'          // deliverables verified
  | 'failed'            // backend error
  | 'detached'          // alive, but no terminal on screen
  | 'archived'          // finished, transcript kept, worktree removed
```

`idle_unverified` is deliberately a distinct status, not a flavour of complete. It is the single most important lesson from the research session that produced this document: three delegated agents reported `idle` repeatedly while producing zero files.

### 2.3 Deliverable

```ts
interface Deliverable {
  kind: 'file' | 'glob' | 'command'
  spec: string                  // "src/routes/users.ts" | "docs/*.md" | "npm test"
  verified: boolean
  checkedAt?: string
  detail?: string               // exit code, stderr tail, or "file not found"
}
```

Declared **at spawn time**, by the orchestrator, as part of the task. A session with no declared deliverables can never reach `complete` — it caps at `idle_unverified`. That is intentional friction: it forces the orchestrator to say what "done" means before work starts.

---

## 3. Backend adapter interface

The whole point of Orchy versus the incumbents is that OpenCode and Agy are first-class. That only stays true if the backend is an interface, not an assumption.

```ts
interface AgentBackend {
  readonly id: string
  spawn(opts: SpawnOpts): Promise<BackendHandle>
  send(h: BackendHandle, text: string): Promise<void>
  interrupt(h: BackendHandle, reason: string): Promise<void>
  kill(h: BackendHandle): Promise<void>
  events(h: BackendHandle): AsyncIterable<AgentEvent>   // normalized
  capabilities(): { images: boolean; attachTui: boolean; checkpoints: boolean }
}
```

`capabilities()` is how the orchestrator routes: image generation goes to Agy because OpenCode's image path rides an OAuth that fails; long tasks go to a backend with checkpoints.

### 3.1 OpenCode: the attach model (RESOLVED — verified against opencode 1.18.19)

The critical mechanic, confirmed by `opencode attach --help`:

```bash
opencode attach <server-url> --session <id> --dir <worktree-path>
```

So a session has **two faces onto one underlying session**:

| Concern | Channel |
|---|---|
| Orchestration — prompts, status, events | HTTP + SSE against the shared `opencode serve` |
| Visibility — what the user watches in the grid | `opencode attach` TUI in a terminal |

One `opencode serve` process, N sessions, N attached TUIs. Starting a session does not spawn a CLI process or re-trigger auth. **This is the thing that makes the terminal grid work** — we never drive the TUI with synthetic keystrokes; we drive the session over HTTP and the TUI simply reflects it.

Flags that matter for the grid specifically:
- `--mini` — minimal interactive interface. Likely the right default for a ~520px column.
- `--replay-limit N` / `--no-replay` — caps history replay on resize. Grid panes resize constantly; without this every reflow replays the whole transcript.
- `--fork` — branch a session from an existing one (feeds the deferred Duplicate op in §8).
- `-u` / `-p` — basic auth, if the server is started with credentials.

### 3.2 Free wins from the OpenCode CLI

Things §8–§10 called for that we do **not** need to build:

| Need | Provided by |
|---|---|
| Export (transcript) | `opencode export <sessionID>` |
| Cost governor input | `opencode stats` — token usage and cost |
| Registry reconciliation | `opencode session list` |
| Hard delete | `opencode session delete <sessionID>` |
| Per-session role | `--agent <name>` |
| Unattended sessions | `--auto` (auto-approve non-denied permissions — dangerous, opt-in per session) |

### 3.3 Backends planned

| Backend | v1 | Event source |
|---|---|---|
| `OpenCodeBackend` | ✅ | HTTP+SSE, `~/.opencode-mcp-events.jsonl` |
| `CliBackend` (generic terminal agent) | ✅ | VS Code shell integration events |
| `CodexBackend` | v1.1 | Codex writes rollout logs to `~/.codex/sessions` — pollable, no hooks needed |
| `AgyBackend` | v1.1 | agy-mcp bridge; the only one with verified image generation |
| `ClaudeCodeBackend` | v2 | hook server, the way agent-flow and Synapse do it |

**Note for a future non-VS-Code surface:** `opencode acp` starts an Agent Client Protocol server. ACP is how editors like Zed talk to agents — if Orchy ever leaves VS Code, that's the seam, not a rewrite.

---

## 4. Session lifecycle

```
orchy_spawn(role, task, deliverables, model?)
   │
   ├─ 1. WorktreeManager.create()
   │      git fetch origin
   │      git worktree add ../<repo>-<id> -b agent/<id> origin/<baseRef>
   │      record baseSha                      ← guards against base drift
   │      bootstrap: copy .worktreeinclude patterns (.env etc.)
   │      pnpm install (global virtual store → near-zero marginal disk)
   │
   ├─ 2. BackendRegistry.spawn()   → creates the session over HTTP, returns sessionId
   │      (no process spawned; the shared `opencode serve` already runs)
   │
   ├─ 3. GridManager.place()       → attaches a TUI to that same session
   │      window.createTerminal({
   │        location: TerminalLocation.Editor,
   │        color: ThemeColor('orchy.running'),
   │        iconPath: roleIcon,
   │        cwd: worktreePath,
   │        shellPath: 'opencode',
   │        shellArgs: ['attach', serverUrl, '--session', sessionId,
   │                    '--dir', worktreePath, '--mini', '--replay-limit', '200']
   │      })
   │      reveal at ViewColumn slot, preserveFocus: true
   │
   └─ 4. status → running,  emit spawn event
```

Teardown:

```
orchy_complete(id)  →  verify deliverables
                       ├─ all pass → complete → offer merge
                       └─ any fail → idle_unverified, surface which ones
merge               →  rebase onto fresh origin/<base>, run verify cmd, merge, delete branch
teardown            →  git worktree remove (refuses if dirty — we mirror that refusal)
                       terminal.dispose(), slot freed, status → archived
```

---

## 5. Grid policy

Screen-space math at 1920px with both sidebars open leaves ~1040px for the editor area. Two session terminals at ~520px each is readable; three at ~347px is not.

- **Default visible slots: 2.** Configurable, hard cap 4.
- Sessions beyond the cap run `detached` — alive, no terminal, represented as nodes in the graph and rows in the sidebar.
- **Promotion:** a session entering `waiting_input` requests a visible slot. Setting `orchy.autoPromoteOnBlocked` (default `true`, because that is the whole product) — but it never steals focus (`preserveFocus: true`), and it never evicts a terminal the user has focused in the last 30s.
- **Closing a terminal does not kill the session.** It goes `detached`. Killing is explicit. This is the single easiest way to destroy an hour of an agent's work by accident, so it gets its own decision rather than falling out of window management.

---

## 6. The permission matrix that actually applies

Orchy is a single-user local tool, so the usual owner/admin/member matrix is **N/A**. The real actors are the orchestrator, the sub-agents, and the human — and the permission questions are about blast radius:

| Action | Orchestrator | Sub-agent | Human |
|---|---|---|---|
| Spawn a session | ✅ | ❌ v1 — no recursive spawning (unbounded cost) | ✅ |
| Write outside own worktree | n/a | ❌ enforced by `allowed_paths` contract | ✅ |
| Kill a sibling session | ✅ | ❌ | ✅ |
| Message a sibling | ✅ | ✅ via host, rate-capped, logged | ✅ |
| Merge to base branch | ⚠️ only after verify passes | ❌ | ✅ always |
| Run `git stash` / `reset --hard` | ❌ | ❌ | ✅ |

That last row is a real landmine: **git stashes are shared across all worktrees.** An agent running `git stash pop` can grab a sibling's entries. Worktrees isolate files, not destructive history operations. v1 adds these to every session's `forbidden_commands` contract by default.

---

## 7. State matrix per surface

| Surface | Empty | Loading | Error | Partial | Blocked | Success |
|---|---|---|---|---|---|---|
| **Grid** | No sessions → CTA explaining `orchy_spawn` + a "Start pipeline" button, not a blank editor | `spawning` placeholder terminal with worktree progress | Backend failed to start → terminal shows the real `last_error`, not "something went wrong" | Session alive but terminal closed → `detached` chip in sidebar with "Reopen" | `waiting_input` → tab icon color flips, sidebar badge increments | Running, output streaming |
| **Graph** | No sessions → skeleton graph + hint | Replaying event log → progressive node fade-in | Event log missing/corrupt → "Cannot read event log at `<path>`" + Rebuild action | Session with zero events yet → ghost node, not omitted | Blocked node pulses; this is the visual centerpiece | Live nodes, animated edges |
| **Sidebar** | Zero sessions → empty state with setup command | Spinner row | Daemon unreachable → "Orchy daemon not running" + Restart | Sessions from a previous window → grouped "Adopted" | `TreeView.badge` = count of blocked | Grouped by status |

**Zero-results-after-filter** (filtering sessions by role): distinct from empty — "No sessions match 'ml' — clear filter."

---

## 8. Lifecycle completeness — entity: Session

| Op | v1 | Notes |
|---|---|---|
| Create | ✅ | `orchy_spawn` + palette command |
| Read (single) | ✅ | Terminal + node inspector in graph |
| Read (list) | ✅ | Sidebar tree, grouped by status |
| Update — retask | ✅ | `orchy_send` follow-up prompt |
| Update — rename | ✅ | Label only; branch name is immutable after creation |
| Delete (soft) | ✅ | `archived` — transcript + diff kept, worktree removed |
| Delete (hard) | ✅ | Purge transcript + events. Separate, explicit action |
| Archive / Restore | ✅ / ⏸ | Restore = respawn from checkpoint. Deferred — depends on backend `capabilities().checkpoints` |
| Duplicate | ⏸ | Deferred — "same task, fresh worktree, different model" is the A/B compare feature Conductor has. Flag if wanted |
| Transfer (change backend/model mid-task) | ⏸ | Deferred — `opencode_set_model` exists, but cross-backend transfer needs transcript translation |
| Export | ✅ | Transcript + `git diff` bundle → single folder. Cheap, and it's the escape hatch if Orchy breaks |
| History / audit | ✅ | The event log *is* the audit log. Free. |

**Entity: Worktree** — create ✅, list ✅, remove ✅, prune ✅ (orphan cleanup), repair ⏸. **Entity: Pipeline** (a named set of sessions) — deferred entirely to v2; v1 treats sessions as flat.

---

## 9. Destructive action tiers

| Action | Tier | Friction |
|---|---|---|
| Close a session terminal | 1 | None — goes `detached`, "Reopen" in sidebar |
| Archive a completed session | 1 | Undo toast, 10s |
| Kill a running session | 2 | Confirm modal naming the session + elapsed time + "transcript is preserved" |
| Remove a worktree with uncommitted changes | 3 | Type the branch name. Mirrors `git worktree remove`'s own refusal — we surface it, we don't `--force` past it |
| Kill all / reset pipeline | 3 | Type `reset`, lists exactly which sessions and worktrees go |
| Merge agent branch → base | 3 | Requires: deliverables verified, rebase clean, verify command exit 0. Shows the diffstat and what else merges with it |
| Hard-delete transcript | 3 | Type the session id |

No modal says only "Are you sure?" — each restates what happens and what is not recoverable.

---

## 10. Cost governor

Research finding: token cost multiplies linearly with agent count and **no tool in the category has a budget guard.** This is cheap to build and is a genuine differentiator.

- Per-session `budget.cap`; per-pipeline aggregate cap in settings
- At 80% → warning event, node turns amber
- At 100% → session auto-`interrupt`, status `waiting_input` with "budget exhausted — raise cap or kill"
- Sidebar shows live aggregate spend

---

## 11. Competitor surface diff — what v1 deliberately won't have

Against Conductor and vibe-kanban, both of which are mature in this exact area:

1. **Per-worktree setup/run scripts + port management** (Conductor's `CONDUCTOR_PORT`). Worktrees don't isolate ports; two dev servers will collide. → v1 does bootstrap but **not** port allocation. *Flag if you run dev servers per agent.*
2. **Dev server launch + preview browser** (both have it). → deferred.
3. **Diff review with inline comments fed back to the agent** (vibe-kanban). This is genuinely good UX. → deferred to v2.
4. **PR creation with generated descriptions** (both). → v1 stops at local merge.
5. **A/B same-task-two-models compare** (Conductor). → deferred; see Duplicate above.

Not building these is fine. Not *knowing* about them was the risk.

---

## 12. Anti-pattern self-check

- ❌ Unbounded event log rendering → graph reads a windowed tail; transcript panels virtualize
- ❌ Silent success → every spawn/merge/teardown emits a visible confirmation
- ❌ Generic errors → surface the backend's real `last_error`; never "something went wrong"
- ❌ Assuming complete data → sessions with zero events render as ghost nodes, not crashes
- ❌ Stale references → a session pointing at a manually-deleted worktree self-heals to `failed` with a Prune action
- ❌ No disabled state → spawn command disables while a worktree is being created
- ❌ Bespoke UI per surface → one shared `SessionState → visual` mapping used by terminal color, graph node, and tree item. Polish it once, it propagates.

---

## 13. Build order

1. ~~Spike: can OpenCode attach a TUI to an existing served session?~~ **RESOLVED — yes. See §3.1.**
2. Daemon + event log + SessionRegistry. No UI. Prove state survives a window reload.
3. WorktreeManager, with the stash guard and pnpm global store.
4. GridManager: spawn/teardown terminals into editor columns.
5. `orchy-mcp` + `orchy_spawn` / `orchy_status` / `orchy_complete`.
6. Sidebar TreeView + badge — this is the smallest thing that solves the real bottleneck.
7. DeliverableVerifier.
8. Graph webview.
9. Cost governor.

Steps 2–6 are the actual product. 8 is what makes people look twice.

---

## Resolved decisions

1. ~~Can `opencode` attach a TUI to a session created via its HTTP API?~~ **Yes** — `opencode attach <url> --session <id> --dir <path>`, verified against opencode 1.18.19. See §3.1.
2. ~~Base branch~~ — **always `main`.** Worktrees branch from fresh `origin/main`; merge target is `main`. Not per-session configurable in v1.
3. ~~Repo not git-initialized~~ — **done.** `git init -b main`, initial commit `7ab7444`. Remote to be added once the GitHub repo exists.
4. **Open source from the start** — so the backend adapter interface (§3.3) is a public contract, not an internal detail. Adding a backend should mean writing one file that implements `AgentBackend`, with no changes to the host. Codex is the reference third-party adapter.

## Still open

- **Scope of v1 in §8:** anything marked ⏸ to pull in, or ✅ to cut?
- **Per-worktree port allocation** (§11, item 1) — worktrees don't isolate ports; two agents running dev servers will collide. Currently deferred. Reconsider if you plan to run dev servers per agent.
- **`--auto` policy:** which roles, if any, get auto-approved permissions by default. Dangerous knob; currently opt-in per session.
