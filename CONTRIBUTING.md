# Contributing

## Getting it running

```bash
npm install
npm run compile
npm test
```

Press <kbd>F5</kbd> for an Extension Development Host, or package and install:

```bash
npx @vscode/vsce package --no-dependencies
code --install-extension orchy-*.vsix
```

VS Code keeps running the extension it loaded at startup, so **reload the window
after installing** or you will debug a build that is not running. The version is
written into `.orchy/daemon.json` and shown in the Orchy output channel; check it
before diagnosing anything.

## The shape of the code

```
src/core/          state, orchestration, planning, model policy — no vscode imports
src/backends/      one file per agent runtime, behind AgentBackend
src/daemon/        loopback HTTP the MCP server talks to
src/ui/            webviews and tree views. Renderers only
mcp/               the MCP server, hand-rolled JSON-RPC over stdio
```

Two rules hold the design together:

**The extension host owns all state.** `.orchy/events.jsonl` is the source of
truth and the registry is a projection of it. Every surface rebuilds from that
log and may be destroyed at any time. If you find yourself keeping state in a
webview that matters after a reload, it belongs in the log.

**Nothing in `src/core` imports `vscode`.** That is what makes the core testable
in plain Node, and every test here runs in plain Node.

## Traps that have already cost real time

**The webview scripts are TypeScript template literals.** The compiler never
parses them, so a typo there compiles cleanly and produces a panel that draws
nothing — which looks exactly like a pipeline with nothing in it. A `\n` written
with one backslash becomes a real line break inside a quoted string; a backtick
in a comment closes the literal; `\/` in a regex loses its backslash and stops
being a regex. **Anything with a backslash needs writing twice.** `npm test`
extracts the script from the compiled output and parses it as a browser would,
which is the only reason these are caught before install.

**Windows binary resolution.** `opencode` on `PATH` may be an npm `.cmd` shim
that Windows cannot exec directly. `resolveOpenCodeBinary` parses the shim; there
are regression tests, and a stale global install shadowing a newer one has cost
a debugging session before.

**Worktrees share more than they look like they do.** The stash and refs are
shared across every worktree of a repository. That is why agents are forbidden
`git stash` and `git reset --hard`.

## Tests

Every suite is a plain Node script that prints `ok` lines and exits non-zero on
failure — no framework, no watch mode, no configuration.

When you fix a bug, write the test that fails without the fix, then **verify it
fails**: put the bug back, run the suite, watch it go red. A test that passes
either way is worse than no test, because it claims coverage it does not have.
There are notes in this repository's history about exactly that happening.

## Commits

Explain the failure, not the diff. "Fix the newline that killed the whole panel"
followed by *why* the newline died is worth more in six months than a list of
changed files, which git already has.
