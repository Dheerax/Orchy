# Orchy

Multi-agent coding orchestration inside VS Code. An orchestrator agent spawns
specialist agents; each one gets its own git worktree and its own terminal in the
editor grid; a topology panel shows which of them needs you.

> **Status: early.** The state layer, worktree isolation, orchestration, MCP
> surface, and UI are built and tested. Not yet published to the Marketplace.

---

## Why this exists

Running several coding agents at once is now easy. Knowing what they're doing is not.

Two problems show up immediately, and nothing in this space solves either:

**1. "Idle" doesn't mean "done."** Agents go quiet all the time without having
produced anything. This project started after three delegated research agents
reported idle repeatedly for an hour while writing zero files. So in Orchy a
session declares its deliverables up front and can only reach `complete` when
every one of them verifies. A backend going quiet proves nothing.

**2. Past three or four agents, you are the bottleneck.** Not merge conflicts —
noticing which agent is blocked. Orchy puts that count in a native sidebar badge
and makes the blocked node the only thing on screen that moves.

## How it works

```
Orchestrator agent (Claude Code, or any MCP client)
        │  MCP
   orchy-mcp  ──HTTP──▶  Extension host  ──▶  .orchy/events.jsonl
                              │                (append-only source of truth)
             ┌────────────────┼────────────────┐
      agent terminals    topology panel    sidebar + badge
      (editor grid)       (one webview)
```

- **The extension host owns all state.** Every surface is a disposable renderer
  that rebuilds from the event log. Close a terminal, background the webview,
  reload the window — nothing is lost.
- **One worktree per agent, one branch per worktree.** Git itself guarantees two
  agents never share a branch.
- **Terminals, not custom chat UIs.** `opencode attach <url> --session <id>` binds
  a real TUI to a session that Orchy drives over HTTP. The terminal is a view,
  never a control surface — nothing sends synthetic keystrokes to an agent.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design, including the feature
surface spec and what was deliberately deferred.

## Install (development)

```bash
git clone https://github.com/Dheerax/Orchy.git
cd Orchy
npm install
npm run compile
```

Then press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

Requires [OpenCode](https://opencode.ai) on your `PATH`. Orchy starts and manages
`opencode serve` itself.

## Use

Run **`Orchy: Set Up Workspace Layout`** from the command palette, then either
spawn agents by hand (**`Orchy: Spawn Agent Session`**) or point an orchestrator
at the MCP server:

Register it once, globally — the server finds the right project by walking up
from its working directory, so one entry covers every workspace:

```json
{
  "mcpServers": {
    "orchy": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/Orchy/mcp/orchy-mcp.mjs"]
    }
  }
}
```

For Claude Code that is `~/.claude.json`. Pass an explicit workspace path as a
second argument if you would rather pin it to one project.

A project-scoped `.mcp.json` also works, but Claude Code requires those servers
to be approved before they load — an unapproved one is silently invisible, which
looks exactly like the tools not existing.

Then tell your orchestrator: *"Spin up a UI agent and a backend agent."*

### Tools

| Tool | What it does |
|---|---|
| `orchy_spawn` | Start an agent in its own worktree, placed in the grid |
| `orchy_list` / `orchy_status` | Session state, including missing deliverables |
| `orchy_send` | Follow-up prompt to a running session |
| `orchy_verify` | Re-check deliverables — the only path to `complete` |
| `orchy_interrupt` / `orchy_kill` | Stop a turn, or stop a session |
| `orchy_merge` | Rebase onto main and fast-forward. Refused unless verified |
| `orchy_archive` | Finish and remove the worktree. Refuses if dirty |

## Settings

| Setting | Default | |
|---|---|---|
| `orchy.baseBranch` | `main` | Branch worktrees cut from and merge into |
| `orchy.visibleSlots` | `2` | Terminals visible at once. Beyond this, sessions run detached |
| `orchy.autoPromoteOnBlocked` | `true` | Surface a blocked session. Never steals focus |
| `orchy.globalBudgetCap` | `0` | Stop a session past this spend. `0` disables |

## Design decisions worth knowing

- **Closing a terminal does not kill the session.** It detaches. Killing is
  explicit and confirmed — a stray <kbd>Ctrl</kbd>+<kbd>W</kbd> should not destroy
  an hour of an agent's work.
- **Two visible slots by default.** At 1920px with both sidebars open you have
  ~1040px of editor area. Two panes at ~520px are readable; three at ~347px are not.
- **`git stash`, `git reset --hard`, and force-push are forbidden to agents.**
  Worktrees isolate *files*, not the stash — which is shared across every worktree
  of a repo, so one agent popping a stash can consume another's.
- **Bootstrapped files are excluded per-worktree.** `.worktreeinclude` copies
  `.env` and friends into new worktrees, then adds them to that worktree's
  `info/exclude` so it doesn't read as dirty.
- **The layout command is a command.** Rearranging someone's editor the moment an
  extension activates is hostile.

## Adding a backend

Implement [`AgentBackend`](src/backends/types.ts) in one file and register it.
No changes to the extension host. `capabilities()` is how the orchestrator routes
work — image generation, for instance, goes to a backend that can actually do it.

Planned: Codex (rollout logs in `~/.codex/sessions`), agy, Claude Code.

## Tests

```bash
npm test          # state layer + integration (real git worktrees)
node mcp/smoke.mjs   # MCP protocol
```

The integration suite creates a throwaway repository and exercises worktree
creation, isolation, dirty-worktree refusal, deliverable verification, merge
gating, and rebuild-from-log.

## License

MIT
