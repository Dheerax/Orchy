# Orchy

Multi-agent coding orchestration inside VS Code. You describe the work; an
orchestrator proposes a pipeline; you approve it; each agent runs in its own git
worktree, and you watch the branches diverge and merge in real time.

> **Status: early but usable.** Everything below works. Not yet on the
> Marketplace — install from a `.vsix` or run it from source.

---

## Why this exists

Running several coding agents at once is easy now. Knowing what they are doing is not.

**"Idle" does not mean "done."** Agents go quiet all the time without having
produced anything. This project started after three delegated research agents
reported idle repeatedly for an hour while writing zero files. In Orchy a session
declares its deliverables up front and can only reach `complete` when every one of
them verifies on disk. A backend going quiet proves nothing — it parks the session
at `idle_unverified`, which is a different thing and says so.

**Past three or four agents, you are the bottleneck.** Not merge conflicts —
noticing which agent is blocked. Orchy puts that count on the panel's own tab,
so it is legible while you are looking at your code.

**A pipeline is a shape, not a queue.** Two agents can wait on one. One agent can
wait on three. You approve that shape before anything runs, as a diagram, and
then watch it happen as a branch graph.

## How it works

```
Orchestrator (Claude Code, or any MCP client)
        │  MCP
   orchy-mcp  ──HTTP──▶  Extension host  ──▶  .orchy/events.jsonl
                              │                (append-only source of truth)
                              │
                    one window, in the panel
                 agents · pipeline · history
```

- **The extension host owns all state.** Every surface is a disposable renderer
  that rebuilds from the event log. Close a panel, reload the window, quit and
  reopen — nothing is lost, including a plan you had not decided on yet.
- **One worktree per agent, one branch per worktree.** Git itself guarantees two
  agents never share a branch.
- **Terminals are views, never control surfaces.** `opencode attach` binds a real
  TUI to a session Orchy drives over HTTP. Nothing sends synthetic keystrokes to
  an agent.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design and what was
deliberately deferred.

## See it

[**A 30-second walkthrough**](docs/demo.html) — one prompt becomes a pipeline you approve,
five agents run on their own branches, and the branches fold back into main. Open the file
in a browser; it plays on load.

## Quickstart

You need [OpenCode](https://opencode.ai) on your `PATH` with at least one
provider configured, and a git repository to work in. Orchy starts and manages
`opencode serve` itself.

```bash
git clone https://github.com/Dheerax/Orchy.git
cd Orchy
npm install
npm test              # optional, ~20s, uses real git worktrees
npx @vscode/vsce package --no-dependencies
code --install-extension orchy-*.vsix
```

Point your orchestrator at the MCP server. Register it once, globally — the
server finds the right project by walking up from its working directory, so one
entry covers every workspace. For Claude Code that is `~/.claude.json`:

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

Then open your project in VS Code and tell the orchestrator what you want:

> Use the orchy tools — read `orchy_guide` and `orchy_models` first. Add a
> validation library: a core plus three independent validators and a test suite.
> Plan the validators to run in parallel.

A plan appears in the **Orchy** panel at the bottom, next to your terminal: a
diagram of who depends on whom, what each agent owes, and which model each will
run on. Approve it and the agents start.

## Project rules

Run **`Orchy: Create Project Config`** to write a `.orchy/config.json`. It is where the things an orchestrator cannot infer live:

```json
{
  "rules": [
    "Plain CommonJS. Do not introduce a build step.",
    "No new dependencies without saying why in the commit message."
  ],
  "verify": "npm test",
  "models": { "cheap": "opencode/ling-3.0-flash-free" },
  "baseBranch": "main",
  "budgetCap": 0
}
```

`rules` are appended verbatim to every agent's brief — the prompt being the only
place they can actually change what an agent does — and `verify` is a command
every agent must pass on top of its own deliverables. Commit the file: the rest
of the team gets them too. A malformed one costs you the settings you got wrong
and nothing else.

## What you see

One window, in the panel beside your terminal, with three views of the same run.

**Agents** — what exists and what each owes: status, model, spend, and whether
its deliverables actually verified, with its terminal, a diff of what it changed,
verify and merge one click away. A plan awaiting approval takes over this view,
because the decision matters more than the run behind it.

**Pipeline** — agents by stage, so the width of the widest stage is the
parallelism you are actually buying. Fitted to the pane; zooming in is a
deliberate act.

**History** — the branch graph: time left to right, main across the top, each
agent forking away where it was created and folding back where it merged. Every
step is labelled, and clicking one opens that agent.

## The pipeline

Prefer `orchy_plan` over spawning agents one at a time. It checks the plan before
a human ever sees it — a need nobody provides, two agents promising the same
symbol, a dependency cycle, an agent with no deliverables, two siblings writing
the same file — and shows the warnings alongside the diagram.

A dependency means **"after, and on top of"**: the dependency's branch is merged
into the dependent's worktree before it starts, so it builds on real work rather
than a base that predates it.

Plans survive a window reload. If you close VS Code mid-decision, the plan comes
back and approving it still spawns the agents.

## Models

`orchy_models` returns every model the backend can currently run, with its tier
and price. Matching the model to the work is most of what makes a pipeline cheap
or expensive.

A model named in a plan is a **preference, not an instruction**. Orchy sorts the
live catalogue into cheap / standard / strong by price — not by a table of model
names that would be stale in a month — and if a model cannot be honoured it
substitutes the nearest available one **of the same tier** and records that it
did. A cheap mechanical agent whose free model was withdrawn does not quietly
start costing frontier money. Only failures that read as model problems trigger a
retry; a dead server fails the same way forever.

## Tools

| Tool | What it does |
|---|---|
| `orchy_guide` | How to operate the pipeline. Read this first |
| `orchy_project` | This repository's rules, from its `.orchy/config.json` |
| `orchy_models` | Available models with tier and price |
| `orchy_plan` / `orchy_plan_status` | Propose a pipeline and await approval |
| `orchy_spawn` | One agent, in its own worktree |
| `orchy_list` / `orchy_status` | Session state, including missing deliverables |
| `orchy_wait` | Block until something needs attention — never sleep-poll |
| `orchy_send` / `orchy_relay` | Follow-up prompt; hand one agent's output to another |
| `orchy_set_model` | Change a running session's model mid-flight |
| `orchy_verify` | Re-check deliverables. The only path to `complete` |
| `orchy_fork` | Branch a session to try a second approach |
| `orchy_merge` | Rebase onto main and fast-forward. Refused unless verified |
| `orchy_interrupt` / `orchy_kill` / `orchy_archive` | Stop a turn, a session, or clean up |

## Settings

| Setting | Default | |
|---|---|---|
| `orchy.baseBranch` | `main` | Branch worktrees cut from and merge into |
| `orchy.autoMerge` | `false` | Merge a verified session when nothing is ambiguous |
| `orchy.globalBudgetCap` | `0` | Stop a session past this spend. `0` disables |

## Design decisions worth knowing

- **Closing a terminal does not kill the session.** It detaches. Killing is
  explicit — a stray <kbd>Ctrl</kbd>+<kbd>W</kbd> should not destroy an hour of work.
- **`git stash`, `git reset --hard` and force-push are forbidden to agents.**
  Worktrees isolate *files*, not the stash — which is shared across every worktree
  of a repo, so one agent popping a stash can consume another's.
- **Bootstrapped files are excluded per-worktree.** `.worktreeinclude` copies
  `.env` and friends into new worktrees, then adds them to that worktree's
  `info/exclude` so they do not read as dirty.
- **The layout command is a command.** Rearranging someone's editor the moment an
  extension activates is hostile.
- **A plan is a decision, so it survives everything.** Reload, close, crash. It is
  also written into the page as plain HTML with `command:` links, so it can be
  approved even if the webview's script never runs.

## Adding a backend

Implement [`AgentBackend`](src/backends/types.ts) in one file and register it. No
changes to the extension host. `capabilities()` is how the orchestrator routes
work; `models()` is optional and feeds the model policy.

Planned: Codex, agy, Claude Code.

## Tests

```bash
npm test
```

State layer, planner, model policy, binary resolution, grid layout, panel
rendering, branch-graph geometry, a real-git integration suite, and the MCP
protocol. The integration suite creates a throwaway repository and exercises
worktree isolation, dirty-worktree refusal, deliverable verification, merge
gating, dead dependencies, and rebuild-from-log.

Two of those suites exist because of specific production failures: the panel
renderer is a string the compiler never parses, so it is extracted from the
compiled output and parsed as a browser would; and the branch graph is geometry,
which fails as a picture that makes no sense rather than as an error.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
