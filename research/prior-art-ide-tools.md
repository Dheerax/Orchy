# Prior Art: IDE-Embedded / Open-Source Multi-Agent Coding Orchestrators

**Date of research:** 2026-08-21
**Method:** Live web search + direct fetches of official docs, GitHub repos, and marketplace listings. Every claim below carries a source URL gathered in this session. Items I could not verify first-hand are explicitly marked **UNVERIFIED** or attributed to third-party sources.

---

## TL;DR — The Key Question First

> **Does ANY of them render a live node/graph visualisation of which agent is active or which agents are communicating?**

**No — none of the four target systems (vibe-kanban, Roo Code Orchestrator, Cline, VS Code's native multi-session UI) renders a live node/graph of agent activity or agent-to-agent communication.** Their visual language is exclusively: kanban cards (vibe-kanban), a linear chat transcript with a parent/child task hierarchy list (Roo Code), a chat transcript with per-subagent stat lines (Cline), and a flat sessions list / chat tabs (VS Code).

**However, at least two dedicated open-source observability tools DO exactly this**, as VS Code-adjacent overlays rather than orchestrators:

1. **AgentFlow Live** — a VS Code extension that renders an "interactive node graph with real-time tool calls, branching, and return flows" for Claude Code and Codex sessions, auto-detecting running sessions and streaming events via Claude Code hooks. Source: https://github.com/kijko-ai/agentflow-live (fetched; redirects to `david-kijko/agentflow-live`). It is very new/small (0 stars, 25 commits at time of fetch) and based on the earlier **Agent Flow** project by Simon Patole (https://github.com/patoles/agent-flow — referenced by AgentFlow Live's README; that repo itself was NOT fetched this session, so its contents are **UNVERIFIED**).
2. **Synapse** (`@synapse-ai/cli`) — a local web dashboard that renders Claude Code activity as a "live node graph" with "sessions, agents, subagents, and tool calls as connected nodes with animated edges. Color-coded by status. Auto-expanding as agents spawn." Source: https://usesynapse.dev/ (fetched). Note: the site says "Source code coming to GitHub soon" while linking https://github.com/Soarcer/synapse — repo contents **UNVERIFIED**.

Both are *observation-only* (they watch Claude Code/Codex; they do not orchestrate or delegate). Details in Section 4.

---

## 1. Vibe Kanban (Bloop AI)

### What it actually does
A local-first web application (Rust backend, React frontend) launched with `npx vibe-kanban` that puts AI coding work on a kanban board: you create issues, then create "workspaces" where external coding agents execute them. It positions itself for engineers whose job becomes "planning and reviewing coding agents." Features: kanban issues, agent workspaces with branch/terminal/dev server, diff review with inline comments sent back to the agent, built-in preview browser, PR creation/merge.
Sources: https://github.com/BloopAI/vibe-kanban (README, fetched via search excerpt); https://www.vibekanban.com/docs/getting-started (fetched); https://www.vibekanban.com/ (fetched via search excerpt).

**Status caveat:** Bloop announced Vibe Kanban is sunsetting; the README banner links to https://www.vibekanban.com/blog/shutdown. Third-party writeups state Bloop shut down on 2026-04-10, the repo is now community-maintained under Apache-2.0, and remote/cloud features (shared boards, organisations) were sunset ~30 days later while local workflows continue (third-party claims): https://runpane.com/compare/vibe-kanban and https://instify.ai/blog/vibe-kanban-alternatives. I did not fetch the shutdown blog post itself — treat exact dates as third-party-reported.

### How tasks are delegated, and to which backends
- Delegation is by **spawning external coding-agent CLIs**, not raw LLM APIs. When you create a workspace, "Vibe Kanban automatically creates git worktrees for your selected repositories, and launches your coding agent" with your prompt. Source: https://vibekanban.com/docs/getting-started (fetched).
- Supported backends (per README and docs index): **Claude Code, OpenAI Codex, Gemini CLI, GitHub Copilot CLI, Amp, Cursor Agent CLI, OpenCode, Factory Droid, CCR (Claude Code Router), Qwen Code**. Sources: https://github.com/BloopAI/vibe-kanban (README); docs index listing per-agent pages: https://vibekanban.com/docs/supported-coding-agents (index fetched via llms.txt).
- Parallelism = multiple workspaces per issue ("connect multiple workspaces to an issue... allows you to run multiple coding agents in parallel"). Source: https://vibekanban.com/docs/getting-started (fetched).
- Agent behaviour (model, effort, plan mode) is configured via reusable "Agent Profiles"; MCP servers are configured centrally in settings. Sources: docs index entries "Agent Profiles & Configuration" and "Connecting MCP Servers", https://vibekanban.com/docs/settings/agent-configurations and https://vibekanban.com/docs/settings/mcp-servers (URLs from fetched llms.txt index; pages themselves not individually fetched).
- There is also a VS Code/Cursor/Windsurf extension integration and a Vibe Kanban MCP server (docs index: https://vibekanban.com/docs/integrations/vscode-extension, https://vibekanban.com/docs/integrations/vibe-kanban-mcp-server — listed in fetched llms.txt; not individually fetched).

### What the user SEES while agents run
Live-updating UI, per the Workspaces Interface Guide (https://vibekanban.com/docs/workspaces/interface, fetched):
- A workspace sidebar where every workspace shows a **status indicator**: `Running` (agent actively processing), `Idle`, `Needs Attention` (pending approval, raised-hand icon), plus dev-server and PR badges.
- A four-panel layout: **Conversation panel** (full chat history with the agent, approvals, follow-ups), **Context panel** toggling between **Changes** (file tree + syntax-highlighted diffs + inline comments), **Logs** ("View stdout/stderr in real-time", process tabs, search), and **Preview** (built-in browser with device modes).
- A details sidebar with git status (branch, ahead/behind, uncommitted counts), an xterm.js terminal, and notes.

So: live chat stream + live process logs + live-updating diffs — but all rendered as panels/lists/diffs, never as a graph.

### How shared state/context between agents is handled
- Isolation by **git worktree**: each workspace gets its own worktree(s)/branch(es); agents never share a working directory. Source: https://vibekanban.com/docs/getting-started (fetched).
- Cross-agent context sharing is **via git** (branches, diffs, PRs) and via human-managed issues (title/description, parent/child issue relationships on the board). Sources: getting-started doc; Issue Management docs page listed at https://vibekanban.com/docs/issue-management (in fetched llms.txt index).
- There is no inter-agent messaging, shared memory, or automatic context handoff between two running agents; the human routes work between cards.

### Biggest weakness / gap
It is a **supervision layer, not an orchestrator**: agents cannot talk to each other, there is no dependency engine between agent runs, and every handoff is manual (human reads one agent's diff and writes the next prompt). Compounding this: platform coverage is limited — a third-party comparison states it runs on macOS/Linux only, not Windows (https://runpane.com/compare/vibe-kanban — third-party claim, **UNVERIFIED** against official docs) — and the parent company shut down in April 2026, putting the project in community maintenance with cloud features removed (see Status caveat above).

---

## 2. Roo Code — Orchestrator Mode / "Boomerang Tasks"

### What it actually does
A built-in mode (`🪃 Orchestrator`, historically user-built as "Boomerang Mode") inside the Roo Code VS Code extension (itself a fork of Cline). You give it a complex task; it decomposes the work into subtasks and delegates each to a specialised mode (`💻 Code`, `🏗️ Architect`, `🪲 Debug`, Ask, or custom modes). Mechanically it uses the `new_task` tool (params: `mode`, `message`, optional `todos`) to spawn a subtask, and the subtask returns via the `result` parameter of `attempt_completion`.
Sources: https://docs.roocode.com/features/boomerang-tasks (official docs, content verified via search excerpts of the same page); `new_task` tool reference: https://roocodeinc.github.io/Roo-Code/advanced-usage/available-tools/new-task (official docs mirror).

### How tasks are delegated, and to which backends
- Delegation is **internal to the extension**: subtasks are new conversation contexts run by the same Roo Code instance against whatever LLM API provider(s) the user configured (BYOK model). It does **not** spawn Claude Code, OpenCode, or any external agent CLI. (The delegation mechanism documented is `new_task` within Roo's own tool protocol — source above.)
- Subtasks can use different *modes* and therefore different tool-permission sets and even different models per mode, but all execution stays inside the single VS Code extension process.

### What the user SEES while agents run
- One chat panel. The flow: parent pauses → subtask runs (its transcript is what you see) → subtask completes → parent resumes with only the summary. Docs: "The parent task (in Orchestrator mode) pauses, and the new subtask begins... The parent task resumes with only the summary."
- Navigation is a **task hierarchy** — "Roo's interface helps you see the hierarchy of tasks (which task is the parent, which are children). You can typically navigate between active and paused tasks." That is a navigable list/tree of tasks, not a graph.
- By default each subtask creation/completion requires user approval (auto-approve optional).
Source for all: https://docs.roocode.com/features/boomerang-tasks.

### How shared state/context between agents is handled
Deliberately strict isolation with narrow pipes:
- Each subtask has "its own isolated context with a separate conversation history" and does **not** inherit parent context.
- Information flows **down** only via the `message` param of `new_task`; **up** only via the completion summary in `attempt_completion`.
- The Orchestrator mode itself is intentionally denied file read/write, command execution, and MCP tools to avoid "context poisoning" (overridable via custom-mode config).
Source: https://docs.roocode.com/features/boomerang-tasks (incl. FAQ section).

### Biggest weakness / gap
**It is sequential and lossy.** The parent pauses while each subtask runs, so there is no parallel fan-out; and because only a summary boomerangs upward, detail generated in a child is invisible to both the parent and sibling subtasks unless manually re-passed. Add default approval friction and an orchestrator that is blind to the codebase by default, and long chains become slow and error-prone. (All inherent in the documented design: https://docs.roocode.com/features/boomerang-tasks.) Notably, the community is still proposing fixes — e.g., a 2026 feature request for a "git-native task board for Roo Code's multi-agent team coordination": https://github.com/RooCodeInc/Roo-Code/issues/11929 — i.e., no such coordination board ships today. Related: Kilo Code (a Roo/Cline fork) productised the same Orchestrator idea: https://blog.kilo.ai/p/kilo-code-4191-orchestrator-mode.

---

## 3. Cline (+ its subagent / orchestration story)

### What it actually does
Cline is an autonomous coding agent delivered as a VS Code extension (also JetBrains, Zed, Neovim via ACP, a CLI, and an SDK), with Plan/Act workflow, terminal/browser/file tools gated by user approval, and BYOK model access. Sources: https://github.com/cline/cline (repo README, fetched via search excerpt); marketplace listing: https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev.

**Important negative finding:** Cline has **no Orchestrator mode** equivalent to Roo Code's. Comparison pages (vendor-authored, so biased but consistent on this point) state Cline is a "single plan/act flow" with no orchestrator routing, versus Kilo Code which has one: https://kilocode.ai/kilo-code/vs/cline and https://www.morphllm.com/comparisons/cline-alternatives.

### Its actual multi-agent feature: experimental "Subagents"
Documented at https://docs.cline.bot/features/subagents (fetched):
- Cline can invoke a `use_subagents` tool to launch **parallel read-only research agents**. Each subagent gets its own prompt, its own context window and token budget, and tools limited to: `read_file`, `list_files`, `search_files`, `list_code_definition_names`, read-only `execute_command` (e.g. `ls`, `grep`, `git log`), and `use_skill`.
- Subagents **cannot** edit files, apply patches, use the browser, access MCP servers, do web searches, or spawn nested subagents.
- Each returns a report (focused on relevant file paths) to the main agent, which synthesises.
- Enabled by default; Cline decides when parallel research is worth it; toggle off via Settings → Features → Agent. Launches respect the "Read project files" auto-approve permission.
- Marked experimental by Cline itself.

Beyond the extension: the Cline SDK advertises a "Subagent Orchestration" example ("Spawn and manage background agents with presets, skills, and cross-agent handoffs") — https://github.com/cline/cline/blob/main/sdk/README.md — and the org lists a separate web-based multi-agent **Kanban** product at `cline/kanban` (linked from the repo README's product index: https://github.com/cline/cline). Neither the SDK example nor the Kanban app was exercised this session; their existence is per the README (**UNVERIFIED in depth**).

### How tasks are delegated, and to which backends
Subagents run **inside the extension/CLI process using the user's configured LLM API providers** (BYOK — Anthropic/OpenAI/etc., or local models). They do not shell out to Claude Code/OpenCode CLIs. (Mechanism per the subagents doc above; provider model is BYOK per the repo/marketplace descriptions.)

### What the user SEES while agents run
A live-streaming chat transcript in the editor sidebar. For subagents specifically: "You can see per-subagent stats (tool calls, tokens, cost) in the chat UI as they run." So: live text stream + inline stat lines per subagent. No board, no topology view. Source: https://docs.cline.bot/features/subagents.

### How shared state/context between agents is handled
One-way funnel: subagents explore independently with fresh context windows and return textual reports; the main agent's context stays clean by design ("Run parallel research agents... without filling the main agent's context window"). There is no persistent shared memory between subagents, and since they are read-only, they cannot conflict over files — but they also cannot build anything. Source: https://docs.cline.bot/features/subagents.

### Biggest weakness / gap
Subagents are **research-only**: the parallelism covers codebase exploration, not implementation — all writes still funnel through the single main agent serially. Combined with the absence of a native hierarchical orchestrator (that exists only in forks like Roo/Kilo), Cline today offers parallel *reading* but strictly serial *doing*. (Per the docs and comparisons cited above.)

---

## 4. VS Code extensions / surfaces showing multiple concurrent AI agent sessions

### 4a. VS Code native: Agents window, Chat view, and the sessions list (not an extension — built in)
Microsoft has made multi-session agent management a first-class VS Code surface:
- A **sessions list** shows all chat sessions across projects with status, harness type, and file-change stats; filterable (active/completed/archived/external). Sessions can target different "agent harnesses": Local, Copilot, **Claude**, **Codex**, or Cloud. Source: https://code.visualstudio.com/docs/chat/chat-sessions (official doc, fetched in full).
- **Multiple chats per session**: in agent-host sessions (Copilot/Claude; Codex when on the Agent Host) you can run several chats side-by-side, each with its own history/model, sharing the session's workspace/worktree. Source: same doc.
- **Agents can orchestrate each other**: agent-host sessions expose session-management tools so an agent can list sessions, create a session for a sub-task, read another session's recent context, or message another session (with user confirmation, burst caps). Created/targeted sessions surface an "Open Session" pill in chat. Source: same doc.
- **External session discovery**: VS Code discovers sessions created outside the editor by Copilot CLI, the GitHub Copilot app, **Claude Code**, and **Codex**, and can adopt/continue them. Source: same doc.
- Copilot Chat gained visibility into cloud-agent session logs/status (June 2026 changelog): https://github.blog/changelog/2026-06-10-copilot-chat-now-sees-your-agent-sessions.
- VS Code 1.128 (July 2026) added multi-chat Claude agent-host sessions and **read-only subagent transcripts** surfaced as peer chats (opened from a "running-subagents chip" or an inline subagent pill). Secondary coverage: https://startdebugging.net/2026/07/vscode-1-128-multi-chat-claude-agent-host-sessions/ and https://byteiota.com/vs-code-1-128-parallel-agent-sessions-are-here-now/ (both fetched via search excerpts; official release notes at https://code.visualstudio.com/updates/v1_128 were **NOT fetched directly** — details as reported by these two secondary sources).
- An "Agent Sessions" sidebar is described in vscode-docs: https://github.com/microsoft/vscode-docs/blob/main/learn/foundations/agent-sessions-and-where-agents-run.md (search excerpt only).

**What you see:** a flat/grouped list of sessions with status badges, plus tabbed chat transcripts. **No node/graph rendering anywhere in the documented UI.**

### 4b. AgentFlow Live — the closest thing to a live agent graph in VS Code ⭐ (key find)
- **What:** "Real-time visualization of Claude Code and Codex agent orchestration. Watch your agents think, branch, and coordinate as they work." Features per README: "**Live agent visualization** — Interactive node graph with real-time tool calls, branching, and return flows"; auto-detection of active Claude Code/Codex sessions in the workspace; a lightweight HTTP hook server configured into Claude Code hooks "for zero-latency streaming"; Codex sessions discovered from `~/.codex/sessions` and grouped by parent so spawned Codex subagents appear in the same graph; multi-session tabs; interactive pan/zoom canvas with clickable nodes; timeline, file-attention heatmap, and transcript panels; JSONL log replay.
- **Form factor:** VS Code extension (Activity Bar icon / webview panel), installable from VSIX; Apache-2.0; based on the earlier Agent Flow project (https://github.com/patoles/agent-flow — **UNVERIFIED**, not fetched).
- **Maturity caveat:** tiny/new project — 0 stars, 0 forks, 25 commits at fetch time. It observes; it does not delegate or orchestrate.
Source: https://github.com/kijko-ai/agentflow-live (README fetched in full).

### 4c. Synapse — standalone live node-graph monitor for Claude Code
- npm CLI (`npm i -g @synapse-ai/cli`, then `synapse start`) that configures Claude Code hooks and opens a local web dashboard rendering "Sessions, agents, subagents, and tool calls as connected nodes with animated edges. Color-coded by status. Auto-expanding as agents spawn," plus four analysis lenses (tree, treemap, sankey, compaction timeline) with cross-highlighting, a node inspector (tool args, responses, tokens, timing, parent chain), tool-call grouping, and remote permission approval from a phone over LAN. MIT licensed; binds to localhost by default.
- Caveats: observation-only; site states GitHub source "coming soon" while linking https://github.com/Soarcer/synapse (repo contents **UNVERIFIED**).
Sources: https://usesynapse.dev/ (fetched in full); npm package referenced on same page.

### 4d. Other concurrent-session managers (adjacent prior art)
- **Crystal → Nimbalyst** (Electron desktop app, MIT, ~3.1k stars): ran multiple Claude Code/Codex sessions in parallel git worktrees with a kanban-style board, prompt history, session templates, and diff views; deprecated February 2026 in favour of Nimbalyst, which adds agents streaming edits into editors, worktree isolation, and multi-editor surfaces. Sources: https://github.com/stravu/crystal (README fetched via search excerpt); https://nimbalyst.com/blog/crystal-supercharge-your-development-with-multi-session-claude-code-management/.
- **Conductor** (conductor.build): Mac desktop app "for parallel management and orchestration of Claude Code agents... isolated workspaces, progress monitoring, and git worktree management" — description via the Awesome Claude Code list: https://awesome-claude-code.com/ and https://conductor.build/. (Site not fetched directly.)
- **Agent Dashboard** (VS Code Marketplace extension): "Monitor, chat with, and control your AI coding agents from anywhere... Send prompts to GitHub Copilot, Claude Code, and other agents running in VS Code, view their responses in real time, and track every session, tool call, and token across all your machines." Source: https://marketplace.visualstudio.com/items?itemName=AmiSchreiber.agent-dashboard (marketplace excerpt via search).
- **Claude Code desktop app**: every new session automatically gets its own worktree; parallel sessions are a documented workflow alongside subagents and agent teams. Source: https://code.claude.com/docs/en/worktrees (official docs, search excerpt).

---

## Key Question — Precise Answer

**Do any of the investigated tools render a live node/graph visualisation of which agent is active or which agents are communicating?**

| Tool | Live status display | Node/graph viz of agents? |
|---|---|---|
| vibe-kanban | Yes — per-workspace Running/Idle/Needs-Attention indicators, live logs, live diffs | **No** — kanban cards + panels only |
| Roo Code Orchestrator | Partial — sequential transcript; parent paused during subtask; navigable task hierarchy list | **No** |
| Cline subagents | Yes — live chat + per-subagent stat lines (tool calls/tokens/cost) | **No** |
| VS Code native sessions | Yes — sessions list w/ status badges, chat tabs, subagent chips/pills | **No** |
| AgentFlow Live (3rd-party VS Code ext) | Yes | **YES** — live interactive node graph of Claude Code/Codex sessions incl. spawned subagents, animated flows, multi-session tabs |
| Synapse (standalone monitor) | Yes | **YES** — live node graph w/ animated edges, colour-coded status, auto-expansion as subagents spawn |

**Bottom line:** among the *orchestrators themselves*, graph visualisation does not exist — they show boards, lists, and transcripts. Live agent-graph visualisation exists only in *observation-only* companion tools (AgentFlow Live, Synapse), both young, both focused on Claude Code/Codex event streams rather than on orchestrating delegation themselves. If a product combined an orchestrator's delegation with this class of live graph overlay, it would be doing something none of the surveyed orchestrators currently do.

**Honesty notes / limits of this research:**
- All four primary sections are grounded in official documentation fetched or verbatim-quoted during this session (2026-08-21).
- Explicitly UNVERIFIED items: contents of https://github.com/patoles/agent-flow, https://github.com/Soarcer/synapse, https://www.vibekanban.com/blog/shutdown, https://code.visualstudio.com/updates/v1_128, cline/kanban and the Cline SDK orchestration example (existence per README only), Conductor's site, and vibe-kanban's macOS/Linux-only claim (single third-party source).
- An AI-generated aggregator page listing many additional "visual agent orchestration UIs" surfaced during search (vidismart.com); its tool names could not be corroborated and it was deliberately excluded rather than cited.
