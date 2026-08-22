#!/usr/bin/env node
/**
 * orchy-mcp — the seam between an orchestrator agent and the Orchy extension.
 *
 * Deliberately dumb: it holds no state and makes no decisions. It finds the
 * running extension via `.orchy/daemon.json` and forwards tool calls to it.
 * If the extension is not running, every tool says so plainly rather than
 * half-working.
 *
 * Hand-rolled JSON-RPC over stdio, no dependencies — this ships inside a VS Code
 * extension and pulling an SDK in for three message types is not worth it.
 *
 * Usage:  node orchy-mcp.mjs [workspace-root]
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where to look for a running Orchy.
 *
 * An explicit argument wins. Otherwise walk up from the working directory, so a
 * single global registration works across every project instead of hardcoding
 * one — MCP servers are launched with cwd set to the project being worked on.
 */
function findWorkspace() {
  if (process.argv[2]) {
    return { dir: process.argv[2], searched: [process.argv[2]] };
  }
  const searched = [];
  let dir = process.cwd();
  for (;;) {
    searched.push(dir);
    if (fs.existsSync(path.join(dir, '.orchy', 'daemon.json'))) {
      return { dir, searched };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return { dir: process.cwd(), searched };
    }
    dir = parent;
  }
}

function handshake() {
  const { dir, searched } = findWorkspace();
  const file = path.join(dir, '.orchy', 'daemon.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `Orchy is not running here. Looked for .orchy/daemon.json in:\n` +
        searched.map((d) => `  ${d}`).join('\n') +
        `\n\nOpen the project in VS Code with the Orchy extension active — the daemon ` +
        `starts with it and writes that file.`
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function call(route, body = {}) {
  const { port, token } = handshake();
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-orchy-token': token },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Orchy daemon returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(parsed.error || `Orchy daemon error ${res.status}`);
  }
  return parsed;
}

const DELIVERABLES_SCHEMA = {
  type: 'array',
  description:
    'What this session must produce. A session cannot be marked complete until every ' +
    'entry verifies, so declare something checkable — a backend going quiet is not evidence of work.',
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['file', 'glob', 'command'] },
      spec: {
        type: 'string',
        description: 'Path, glob, or shell command. e.g. "src/api.ts", "docs/*.md", "npm test"',
      },
    },
    required: ['kind', 'spec'],
  },
};

const TOOLS = [
  {
    name: 'orchy_guide',
    description:
      'How to operate the Orchy pipeline: decomposing work across agents, declaring ' +
      'deliverables, chaining with depends_on, waiting on events, reusing agents by role, ' +
      'and reading the status vocabulary. Read this before spawning anything for the first ' +
      'time in a session — it is short, and using the pipeline badly is worse than not ' +
      'using it.',
    inputSchema: { type: 'object', properties: {} },
    local: () => {
      const file = path.join(HERE, '..', 'docs', 'ORCHY-GUIDE.md');
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return `Guide not found at ${file}.`;
      }
    },
  },
  {
    name: 'orchy_project',
    description:
      "This repository's own rules, from its .orchy.json: house conventions every agent " +
      'is given, the command its work has to pass, preferred models per tier, and its ' +
      'budget. Read it before planning. The rules are already appended to every agent ' +
      'brief so they do not need repeating in tasks, but they change what a sensible plan ' +
      'looks like — a project that forbids new dependencies is not one to plan a pipeline ' +
      'around adding a framework to.',
    inputSchema: { type: 'object', properties: {} },
    route: '/project',
  },
  {
    name: 'orchy_models',
    description:
      'Every model these agents can actually run on, with its tier and its price. ' +
      'Read this before planning anything that names models. Matching the model to the ' +
      'work is most of what makes a pipeline cheap or expensive: mechanical edits behind ' +
      'a clear interface do not need a frontier model, and the agent that decides whether ' +
      'the result is correct should not be run on the cheapest thing available. Naming a ' +
      'model that is not listed is not fatal — Orchy substitutes the nearest available ' +
      'model of the same tier and records the substitution — but the catalogue changes, ' +
      'so choosing from it is how you get what you meant.',
    inputSchema: { type: 'object', properties: {} },
    route: '/models',
  },
  {
    name: 'orchy_plan',
    description:
      'Propose a pipeline and wait for the user to approve it. THIS IS THE NORMAL WAY TO ' +
      'START WORK — prefer it over spawning agents one by one, which gives the user no say ' +
      'in the shape before it runs. Describe every agent, what it will produce, what it ' +
      'needs, and which other agents it depends on (by index). Orchy checks the plan for ' +
      'needs nobody provides, two agents promising the same symbol, dependency cycles, and ' +
      'missing deliverables, then shows it for approval. On approval every agent is spawned ' +
      'in dependency order. Blocks until the user decides. If it returns before a decision, ' +
      'the user is simply still reading: check orchy_plan_status rather than proposing again, ' +
      'because a new proposal replaces the plan on their screen. Plans survive a window ' +
      'reload and spawn on approval whether or not you are still connected.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One line: what this pipeline delivers.' },
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', description: 'ui | api | schema | tests | docs | free text' },
              task: { type: 'string' },
              deliverables: DELIVERABLES_SCHEMA,
              depends_on: {
                type: 'array',
                items: { type: 'number' },
                description:
                  'Indices of agents in this same list that must finish first. Their branches ' +
                  'are merged in before this agent starts.',
              },
              provides: {
                type: 'array',
                description:
                  'The interface this agent owes others: symbols and the file they live in. ' +
                  'Checked after the work, so a renamed or unexported symbol fails rather ' +
                  'than silently breaking whoever depends on it.',
                items: {
                  type: 'object',
                  properties: { symbol: { type: 'string' }, file: { type: 'string' } },
                  required: ['symbol', 'file'],
                },
              },
              needs: {
                type: 'array',
                items: { type: 'string' },
                description: 'Symbols this agent expects to already exist, from its dependencies.',
              },
              model: { type: 'string' },
            },
            required: ['role', 'task'],
          },
        },
        timeout_seconds: { type: 'number', description: 'How long to await approval. Default 600.' },
      },
      required: ['summary', 'agents'],
    },
    route: '/plan',
  },
  {
    name: 'orchy_plan_status',
    description:
      'What became of a plan you proposed: still awaiting a decision, approved (and whether ' +
      'its agents were spawned), rejected with feedback, or superseded by a later proposal. ' +
      'Use this when orchy_plan returned without a decision — never re-propose to find out, ' +
      'since that replaces the plan the user is currently reading.',
    inputSchema: {
      type: 'object',
      properties: { plan_id: { type: 'string' } },
      required: ['plan_id'],
    },
    route: '/plan_status',
  },
  {
    name: 'orchy_spawn',
    description:
      'Start an agent session in its own git worktree and place it in the IDE grid. ' +
      'Prefer orchy_plan for anything with more than one agent — it lets the user approve ' +
      'the shape first. Use this for a single follow-up agent. Always declare deliverables: ' +
      'without them the session can never reach "complete". For work that builds on another ' +
      'agent, pass depends_on rather than waiting and spawning later.',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description:
            'Short label for this agent, e.g. ui, backend, docs. Used for its id and grouping. ' +
            'Free text — it is not a backend agent name.',
        },
        agent: {
          type: 'string',
          description:
            'Backend-native agent name (OpenCode --agent). Only set this if the agent actually ' +
            'exists; an unknown name fails the spawn. Usually omit it.',
        },
        task: { type: 'string', description: 'What this agent should do.' },
        name: { type: 'string', description: 'Short human label.' },
        model: { type: 'string', description: 'provider/model, e.g. opencode/ling-3.0-flash-free' },
        deliverables: DELIVERABLES_SCHEMA,
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Session ids that must finish first. The session is held until every one of them ' +
            'verifies complete, then their branches are merged into its worktree before it ' +
            'starts — so a dependency means "after, and on top of", not merely "after". Use ' +
            'this instead of waiting yourself and spawning later.',
        },
        budget_cap: { type: 'number', description: 'Stop the session past this spend.' },
        share_workspace: {
          type: 'boolean',
          description: 'Skip worktree isolation. Only for read-only research.',
        },
        auto_approve: {
          type: 'boolean',
          description: 'Auto-approve permission prompts. Dangerous; prefer false.',
        },
      },
      required: ['role', 'task'],
    },
    route: '/spawn',
  },
  {
    name: 'orchy_list',
    description: 'List every session with status, branch, and deliverable state.',
    inputSchema: { type: 'object', properties: {} },
    route: '/list',
  },
  {
    name: 'orchy_status',
    description: 'Full status for one session, including which deliverables are still missing.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
    route: '/status',
  },
  {
    name: 'orchy_wait',
    description:
      'Block until a session needs you, then return. Use this instead of sleeping and ' +
      'polling: it returns the moment an agent finishes, gets blocked on a permission ' +
      'prompt, fails, or finishes unverified — not N seconds later. Returns immediately ' +
      'if something already needs attention. Poll loops with sleep are the wrong shape ' +
      'here and cost a turn every time.',
    inputSchema: {
      type: 'object',
      properties: {
        session_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Sessions to watch. Omit to watch every session.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Give up after this long and report current state. Default 300, max 600.',
        },
      },
    },
    route: '/wait',
  },
  {
    name: 'orchy_send',
    description: 'Send a follow-up prompt to a running session.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, text: { type: 'string' } },
      required: ['session_id', 'text'],
    },
    route: '/send',
  },
  {
    name: 'orchy_set_model',
    description:
      'Move a running session onto a different model, from its next turn onward, keeping the ' +
      'context it has already built. Work is not uniform — start a session on something cheap ' +
      'for scaffolding and move it up for the part that needs real reasoning, or move a ' +
      'struggling session up rather than forking it. Model is provider/model, e.g. ' +
      'opencode/ling-3.0-flash-free.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        model: { type: 'string', description: 'provider/model' },
      },
      required: ['session_id', 'model'],
    },
    route: '/set_model',
  },
  {
    name: 'orchy_relay',
    description:
      'Ask one agent a question on behalf of another, and record the exchange. Use this when ' +
      'an agent needs something only another agent knows — a field name, a signature, a ' +
      'decision already made. The answer lands in the answering transcript; read ' +
      'it with orchy_status or the panel. Agents cannot talk to each other directly by ' +
      'design: unmediated chatter burns tokens and drifts, and routing through you keeps ' +
      'coordination visible.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Session the question is on behalf of.' },
        to: { type: 'string', description: 'Session being asked.' },
        question: { type: 'string' },
      },
      required: ['from', 'to', 'question'],
    },
    route: '/relay',
  },
  {
    name: 'orchy_verify',
    description:
      'Re-check a session\'s deliverables. This is the only way a session becomes "complete" — ' +
      'a session reporting idle has proven nothing.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
    route: '/verify',
  },
  {
    name: 'orchy_fork',
    description:
      'Start a new session from the work of an existing one, with a corrected task. Use when ' +
      'an agent went wrong partway: its commits are kept and the replacement starts from them ' +
      'with better instructions. Cheaper than starting over, and more reliable than arguing ' +
      'with a session that has already talked itself into an approach.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session to fork from.' },
        task: { type: 'string', description: 'The corrected instruction.' },
        deliverables: DELIVERABLES_SCHEMA,
      },
      required: ['session_id', 'task'],
    },
    route: '/fork',
  },
  {
    name: 'orchy_interrupt',
    description: 'Cancel a session\'s current turn without ending the session.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['session_id'],
    },
    route: '/interrupt',
  },
  {
    name: 'orchy_merge',
    description:
      'Rebase a session\'s branch onto main and fast-forward merge it. Refused unless the ' +
      'session is verified complete.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
    route: '/merge',
  },
  {
    name: 'orchy_archive',
    description:
      'Finish a session and remove its worktree. Refuses if the worktree has uncommitted ' +
      'changes unless force is true.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, force: { type: 'boolean' } },
      required: ['session_id'],
    },
    route: '/archive',
  },
  {
    name: 'orchy_kill',
    description: 'Stop a session immediately. Its worktree and transcript are kept.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
    route: '/kill',
  },
];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n'
  );
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'orchy-mcp', version: '0.0.1' },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return; // notification, no reply
  }

  if (method === 'tools/list') {
    reply(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
    return;
  }

  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) {
      replyError(id, `unknown tool: ${params?.name}`);
      return;
    }
    try {
      // Some tools answer from disk and need no running extension.
      const result = tool.local ? tool.local() : await call(tool.route, params.arguments ?? {});
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      reply(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      reply(id, {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      });
    }
    return;
  }

  if (id !== undefined) {
    replyError(id, `unsupported method: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // Not our frame; ignore rather than crash the transport.
  }
  handle(msg).catch((err) => {
    if (msg.id !== undefined) {
      replyError(msg.id, err.message);
    }
  });
});
