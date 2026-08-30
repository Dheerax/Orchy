<div align="center">

<img src="media/logo.png" alt="Orchy Logo" width="180" height="180" />

# Orchy

**Autonomous Multi-Agent Coding Orchestration for VS Code**

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/dheerax.orchy-ai?style=flat-square&logo=visual-studio-code&logoColor=white&color=38bdf8)](https://marketplace.visualstudio.com/items?itemName=dheerax.orchy-ai)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/dheerax.orchy-ai?style=flat-square&color=3fb950)](https://marketplace.visualstudio.com/items?itemName=dheerax.orchy-ai)
[![GitHub Stars](https://img.shields.io/github/stars/Dheerax/Orchy?style=flat-square&logo=github&color=bc8cff)](https://github.com/Dheerax/Orchy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Powered By OpenCode](https://img.shields.io/badge/Powered%20By-OpenCode-10b981?style=flat-square)](https://opencode.ai)

*An orchestrator plans a pipeline DAG you approve; every agent runs in its own isolated Git worktree; you watch the branches diverge, deliver, and merge in real time.*

[**Explore Interactive Walkthrough**](https://dheerax.github.io/Orchy/docs/demo.html) · [**Report Bug**](https://github.com/Dheerax/Orchy/issues) · [**Architecture Deep Dive**](ARCHITECTURE.md)

</div>

---

## ⚡ Why Orchy?

Running several coding agents at once is easy now. Knowing what they are doing and preventing broken state is not.

- 🛡️ **"Idle" does not mean "Done"**: Agents often stop or go quiet without writing files or passing checks. In Orchy, every session declares strict **deliverables** (files, types, commands) up front and only reaches `complete` when verified on disk. If an agent goes idle without producing its deliverables, it is parked at `idle_unverified`.
- 🌲 **Zero Shared State & Collision-Free Git Worktrees**: Every agent gets its own isolated Git worktree and dedicated branch. Two agents can never overwrite each other's files, clobber the working tree, or corrupt git index state.
- 🚦 **Interactive DAG Approval**: A pipeline is a structured shape, not a blind queue. Two agents can run in parallel while a third depends on both. You review and approve the visual execution DAG before any agent spends tokens.
- 📊 **Unified Single-Panel Observability**: Monitor live token spend, deliverables verification, terminal outputs, and the multi-lane git railway commit graph in one high-density mission control panel.

---

## 🏗️ How It Works

```text
Orchestrator (Claude Code, Antigravity, Cursor, or MCP client)
        │
        ▼ (MCP / JSON-RPC)
    orchy-mcp ──HTTP──▶ VS Code Extension Host ──▶ .orchy/events.jsonl
                              │                     (append-only source of truth)
                              ▼
                 Unified Mission Control Panel
                 Agents · Pipeline · Git History
```

- **Extension Host owns all state**: Every UI surface is a reactive renderer that rebuilds from `.orchy/events.jsonl`. Window reloads or panel closures never lose ongoing runs or pending plans.
- **Strict Dependency Inheritance**: Dependent agents inherit their upstream dependencies' commits automatically before starting.
- **Native Terminal Attach**: Connects directly via `opencode attach` to real interactive pseudo-terminal TUIs—no fake keystroke injection.

---

## 📦 Installation

### Option 1: VS Code Marketplace (Recommended)

1. Open VS Code.
2. Press `Ctrl+P` (or `Cmd+P` on macOS) and run:
   ```bash
   ext install dheerax.orchy-ai
   ```
3. Or search for **`Orchy`** in the Extensions View (`Ctrl+Shift+X`).

### Option 2: From VSIX Release

Download the latest `.vsix` from [GitHub Releases](https://github.com/Dheerax/Orchy/releases) and run:
```bash
code --install-extension orchy-ai-0.39.1.vsix
```

### Option 3: From Source

```bash
git clone https://github.com/Dheerax/Orchy.git
cd Orchy
npm install
npm test
npx @vscode/vsce package --no-dependencies
code --install-extension orchy-ai-*.vsix
```

---

## 🚀 Quickstart

### 1. Prerequisites
- [OpenCode CLI](https://opencode.ai) on your `PATH` with at least one model provider configured.
- A Git repository open in VS Code.

### 2. Connect Your AI Assistant via MCP

Add the Orchy MCP server to your AI tool's global configuration. The server automatically detects your active workspace:

#### For Claude Code (`~/.claude.json`):
```json
{
  "mcpServers": {
    "orchy": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/Orchy/mcp/orchy-mcp.mjs"]
    }
  }
}
```

#### For Cursor / Windsurf / Antigravity (`mcp.json`):
```json
{
  "mcpServers": {
    "orchy": {
      "command": "node",
      "args": ["/absolute/path/to/Orchy/mcp/orchy-mcp.mjs"]
    }
  }
}
```

### 3. Run a Multi-Agent Pipeline

Ask your AI assistant:
> *"Use the orchy tools — read `orchy_guide` and `orchy_models`. Add a plugin system: define the interface in Stage 1, implement file and memory sinks in parallel in Stage 2, and create the router test suite in Stage 3."*

The Orchy panel in VS Code will pop up with the proposed visual DAG:
1. Click **`[ Approve and run ]`**.
2. Watch parallel git worktrees spawn with live token counters and verified deliverable status.
3. Switch between **Agents**, **Pipeline**, and **History** to inspect the live Git commit railway graph.

---

## 🛠️ MCP Tools Reference

| Tool | Purpose |
| :--- | :--- |
| **`orchy_guide`** | Authoritative operational guide & workflow best practices. |
| **`orchy_project`** | Reads project house rules from `.orchy/config.json`. |
| **`orchy_models`** | Fetches live catalogue of available models with tier and pricing. |
| **`orchy_plan`** | Proposes a multi-stage execution DAG and awaits human approval. |
| **`orchy_plan_status`** | Checks decision status on a pending plan. |
| **`orchy_spawn`** | Spawns an individual agent session in an isolated worktree. |
| **`orchy_list`** / **`orchy_status`** | Introspects live sessions, spend, and missing deliverables. |
| **`orchy_wait`** | Event-driven blocking wait for agent state changes (no sleep-polling). |
| **`orchy_verify`** | Re-evaluates file, glob, and command deliverables on disk. |
| **`orchy_merge`** | Merges and fast-forwards verified agent work into the base branch. |
| **`orchy_send`** / **`orchy_relay`** | Sends follow-up prompts or pipes output between agents. |
| **`orchy_set_model`** | Dynamically changes the LLM model for a running session. |
| **`orchy_interrupt`** / **`orchy_kill`** | Pauses, cancels, or archives sessions and tears down worktrees. |

---

## ⚙️ Configuration & Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `orchy.autoOpenTerminals` | `true` | Automatically opens interactive agent terminals upon start. |
| `orchy.baseBranch` | `main` | Base branch that worktrees branch from and merge back into. |
| `orchy.autoMerge` | `false` | Automatically merges sessions once deliverables verify cleanly. |
| `orchy.globalBudgetCap` | `0` | Estimated spend ceiling per session in USD (`0` disables). |

---

## 📋 Project Configuration (`.orchy/config.json`)

Run **`Orchy: Create Project Config`** (`Ctrl+Shift+P`) to generate project rules:

```json
{
  "rules": [
    "TypeScript strict mode. No any.",
    "All unit tests must pass before submitting deliverables.",
    "Do not commit to main branch directly."
  ],
  "verify": "npm test",
  "models": {
    "preferred": "anthropic/claude-3-7-sonnet",
    "cheap": "google/antigravity-gemini-3-flash"
  },
  "baseBranch": "main",
  "budgetCap": 5.0
}
```

---

## 🧪 Running Tests

Orchy includes comprehensive unit and integration test suites:

```bash
npm test
```

Runs 11 test suites testing the state layer, planner DAG resolution, model tier policies, setup doctor, binary resolution, panel render parsing, rail graph geometry, real-git worktree orchestration, and the MCP protocol.

---

## 📄 License

Distributed under the **MIT License**. See [LICENSE](LICENSE.txt) for details.
