# OpenCode Agentic Orchestration Pipeline

This document details the architecture and ideation for a parallel, multi-agent orchestration pipeline utilizing `opencode-mcp-bridge` to manage specialized subagents with a shared memory block.

## 1. Architectural Overview

The core objective is to maximize development productivity by running specialized, concurrent subagents on different parts of a codebase (UI, Backend, Docs, ML/Scripting) while maintaining alignment through a centralized, reactive state.

```
                  ┌────────────────────────┐
                  │   Coordinator Agent    │ (Main CLI Session)
                  └───────────┬────────────┘
                              │
             Writes updates   │   Reads status / Coordinates
             to Memory Block  │   via opencode-mcp-bridge
                              ▼
                  ┌────────────────────────┐
                  │  Shared Memory Block   │ (.opencode-context.json)
                  └───────────┬────────────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       │ (Read State)         │ (Read State)         │ (Read State)
       ▼                      ▼                      ▼
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│   UI Agent   │       │Backend Agent │       │   ML Agent   │
│  (Session A) │       │  (Session B) │       │  (Session C) │
└──────────────┘       └──────────────┘       └──────────────┘
```

---

## 2. Component Design

### 2.1 The Coordinator (Conductor)
The main OpenCode / Antigravity session acts as the conductor of the pipeline. Its responsibilities are:
1. **Planning**: Taking user requirements and breaking them down into decoupled sub-tasks.
2. **Context Seeding**: Initializing the Shared Memory Block with the overall task scope and boundaries.
3. **Delegation**: Spawning individual specialist sessions via `opencode_start` or `opencode_batch`.
4. **Monitoring**: Tailing the `~/.opencode-mcp-events.jsonl` event log for completion and interaction events.
5. **Conflict Resolution**: Merging code changes, checking for test regressions, and updating the Shared Memory Block as agents execute.

### 2.2 Specialist Subagents
Each subagent is spawned as a dedicated background session with a highly tailored system prompt:
* **Frontend/UI Agent**: Instructed only to modify design, CSS/styles, and UI components.
* **Backend/Referee Agent**: Focuses on core business logic, simulation rules, and database engines (e.g., in `sim/world`).
* **Docs/Specs Agent**: Ensures documentation, test specifications, and README files stay updated in parallel.
* **ML/Data Agent**: Works on training scripts, Blender sprite pipelines, and data transformations.

### 2.3 The Shared Memory Block
Rather than passing the entire codebase state to every agent, the pipeline utilizes a lightweight, structured state file: `.opencode-context.json` located at the root of the workspace.

#### Structured Schema Example:
```json
{
  "project": "WorldY",
  "pipeline_status": "in_progress",
  "global_invariants": [
    "No LLM calls or network activity inside sim/world.",
    "Always iterate maps in sorted key order to ensure determinism."
  ],
  "shared_memory": {
    "active_branches": ["main"],
    "recent_modifications": {
      "sim/world/verbs_social.go": "Modified by Backend Agent at tick 12 to add the 'bribe' verb.",
      "art/post/color.py": "Adjusted palette calculations."
    },
    "current_api_contracts": {
      "verbs": ["bribe", "attack", "observe"]
    }
  }
}
```

---

## 3. Workflow & Verification Loop

1. **Initialization**: The Coordinator writes initial goals to `.opencode-context.json`.
2. **Launch**:
   ```javascript
   opencode_batch([
     { "task": "Implement the 'bribe' verb in backend sim/world", "model": "flash" },
     { "task": "Create Blender parametric assets for the bribe animation", "model": "pro" }
   ])
   ```
3. **Execution**:
   * Each specialist reads `.opencode-context.json` on startup.
   * Specialists write their changes.
   * If a specialist makes a breaking change, it reports to the Coordinator, which updates the `.opencode-context.json` file.
   * The other running specialists read the updated state file to adjust their output.
4. **Resolution**: The Coordinator pulls diffs using `opencode_diff`, performs linting/compilation verification, and commits clean checkpoints.

---

## 4. Why This Approach Excels

* **Context Minimization**: Solves the issue of LLMs losing context in large files.
* **Efficiency**: Running 3 parallel tasks reduces delivery time by up to 60%.
* **Cost Control**: Flash models can be assigned to simple documentation/boilerplate tasks, saving Pro-tier models for architecture and complex logic.
