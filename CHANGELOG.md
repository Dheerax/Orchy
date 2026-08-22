# Changelog

## 0.33.0

First release intended for other people to install.

**Planning.** `orchy_plan` proposes a pipeline as a diagram — who depends on
whom, what each agent owes, which model each will run on — and nothing spawns
until you approve it. Plans are checked first for needs nobody provides, two
agents promising the same symbol, dependency cycles, agents with no
deliverables, and siblings writing the same file. They survive a window reload,
and approving a restored plan still spawns its agents.

**Project rules.** `.orchy/config.json` holds what an orchestrator cannot infer
about your repository: house conventions handed to every agent verbatim, a
command their work must pass, preferred models per tier, the base branch, a
budget cap. Committed, so a team shares them. A malformed field costs you that
field and nothing else.

**Models.** A model named in a plan is a preference. Orchy reads the backend's
live catalogue, sorts it into cheap / standard / strong by price rather than by
a table of names that would be stale in a month, and substitutes the nearest
available model of the same tier when one cannot be honoured — recording that it
did. A cheap agent whose free model was withdrawn does not quietly start costing
frontier money.

**Views.** A session manager in the bottom panel: every agent's live transcript,
or one agent in full with its deliverables, changed files, tokens and spend. A
pipeline view with the topology above and a branch graph below — time left to
right, main across the top, each agent forking away where it was created and
folding back where it merged.

**Safety.** Deliverables are verified on disk; a quiet backend parks a session at
`idle_unverified` rather than calling it done. Merges are refused unless
verified. Agents may not run `git stash`, `git reset --hard` or force-push, since
the stash is shared across every worktree of a repository. Budget caps stop a
session without killing it, so the work so far can still be merged.

**Setup.** Orchy checks the machine before a plan is written rather than after it
is approved: a repository, a commit to branch from, the base branch, the backend,
and a provider to run on. Each answer says what to do.

---

Earlier versions were developed in the open against a real workspace and are not
listed individually. The commit history is the honest record: most of it is the
fixes that came from actually running the thing, including four releases spent
on a single missing backslash that stopped the panel from drawing anything at
all.
