import * as path from 'path';
import * as vscode from 'vscode';
import { SessionRegistry } from '../core/sessionRegistry';
import { OrchyEvent, Session } from '../core/types';
import { WorktreeManager } from '../core/worktreeManager';

interface GraphNode {
  id: string;
  role: string;
  name: string;
  task: string;
  status: string;
  layer: number;
  lane: number;
  merged: boolean;
  model?: string;
  branch?: string;
  spend: number;
  deliverablesCount: number;
  deliverablesVerified: number;
  dependsOn: string[];
  dependents: string[];
  provides: { symbol: string; file: string }[];
  needs: string[];
  lastError?: string;
  createdAt: string;
  lastEventAt: string;
}

interface GraphEdge {
  from: string;
  to: string;
  kind: 'depends' | 'relay' | 'fork';
  label?: string;
}

interface GitCommitNode {
  id: string;
  sessionId: string;
  role: string;
  branch: string;
  lane: number;
  color: string;
  kind: 'fork' | 'commit' | 'milestone' | 'merge' | 'attention' | 'closed';
  status: string;
  time: string;
  relativeTime: string;
  title: string;
  detail?: string;
  deliverables: { spec: string; verified: boolean; detail?: string }[];
  fromLane?: number;
  toLane?: number;
  spend?: number;
  activeLanes: number[];
}

interface PipelineStats {
  total: number;
  running: number;
  waiting: number;
  complete: number;
  merged: number;
  failed: number;
  queued: number;
  totalSpend: number;
}

const LANE_COLORS = [
  '#bc8cff', // main (purple)
  '#58a6ff', // blue
  '#3fb950', // green
  '#f0883e', // orange
  '#39c5cf', // teal
  '#e3b341', // yellow
  '#f778ba', // pink
  '#7ee787', // light green
  '#d2a8ff', // lavender
  '#ffa657', // light orange
];

/**
 * The Orchy Pipeline Mission Control:
 * An interactive topological workflow DAG, a GitHub-style multi-lane visual git
 * commit/merge tree, live pipeline HUD, and deep-dive agent inspector drawer.
 */
export class GraphPanel {
  private static current: GraphPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private pending: NodeJS.Timeout | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly registry: SessionRegistry,
    private readonly worktrees?: WorktreeManager
  ) {
    this.panel.webview.html = this.html();

    this.panel.webview.onDidReceiveMessage(
      async (msg: {
        type: string;
        id?: string;
        file?: string;
        mode?: string;
      }) => {
        switch (msg.type) {
          case 'ready':
            this.push();
            break;
          case 'focus':
            if (msg.id) {
              await vscode.commands.executeCommand('orchy.focusSession', msg.id);
            }
            break;
          case 'openTerminal':
            if (msg.id) {
              await vscode.commands.executeCommand('orchy.openTerminal', msg.id);
            }
            break;
          case 'openTranscript':
            if (msg.id) {
              await vscode.commands.executeCommand('orchy.openTranscript', msg.id);
            }
            break;
          case 'verify':
            if (msg.id) {
              await vscode.commands.executeCommand('orchy.verify', msg.id);
            }
            break;
          case 'merge':
            if (msg.id) {
              await vscode.commands.executeCommand('orchy.merge', msg.id);
            }
            break;
          case 'archive':
            if (msg.id) {
              await vscode.commands.executeCommand('orchy.archive', msg.id);
            }
            break;
          case 'kill':
            if (msg.id) {
              await vscode.commands.executeCommand('orchy.kill', msg.id);
            }
            break;
          case 'purge':
            if (msg.id) {
              await vscode.commands.executeCommand('orchy.purge', msg.id);
            }
            break;
          case 'spawn':
            await vscode.commands.executeCommand('orchy.spawn');
            break;
          case 'setupLayout':
            await vscode.commands.executeCommand('orchy.setupLayout');
            break;
          case 'cleanupTerminals':
            await vscode.commands.executeCommand('orchy.cleanupTerminals');
            break;
          case 'refresh':
            this.registry.rebuild();
            this.push();
            break;
          case 'toggleScope':
            this.showAllRuns = !this.showAllRuns;
            this.push();
            break;
          case 'diff':
            if (msg.id && msg.file) {
              await this.openDiff(msg.id, msg.file);
            }
            break;
        }
      },
      undefined,
      this.disposables
    );

    const onChanged = (): void => this.schedulePush();
    this.registry.on('changed', onChanged);

    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) {
          this.push();
        }
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(
      () => {
        this.registry.off('changed', onChanged);
        if (this.pending) {
          clearTimeout(this.pending);
        }
        for (const d of this.disposables) {
          d.dispose();
        }
        GraphPanel.current = undefined;
      },
      undefined,
      this.disposables
    );
  }

  static show(registry: SessionRegistry, worktrees?: WorktreeManager): void {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'orchy.graph',
      'Orchy — Pipeline',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    GraphPanel.current = new GraphPanel(panel, registry, worktrees);
  }

  private async openDiff(sessionId: string, file: string): Promise<void> {
    const session = this.registry.get(sessionId);
    if (!session?.worktree || !this.worktrees) {
      return;
    }
    const agentSide = vscode.Uri.file(path.join(session.worktree.path, file));
    const baseSide = vscode.Uri.file(path.join(this.worktrees.root, file));
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        baseSide,
        agentSide,
        `${file} — main ↔ ${session.id}`,
        { preview: true, viewColumn: vscode.ViewColumn.Beside }
      );
    } catch {
      await vscode.window.showTextDocument(agentSide, {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      });
    }
  }

  private schedulePush(): void {
    if (this.pending) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.push();
    }, 250);
  }

  /**
   * Place each session in a layer one past its deepest dependency.
   */
  private layout(sessions: Session[]): GraphNode[] {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const layerOf = new Map<string, number>();

    const resolve = (id: string, seen: Set<string>): number => {
      if (layerOf.has(id)) {
        return layerOf.get(id) as number;
      }
      if (seen.has(id)) {
        return 0; // A cycle should not hang the drawing.
      }
      seen.add(id);
      const session = byId.get(id);
      const deps = (session?.dependsOn ?? []).filter((d) => byId.has(d));
      const layer = deps.length === 0 ? 0 : Math.max(...deps.map((d) => resolve(d, seen))) + 1;
      layerOf.set(id, layer);
      return layer;
    };

    // Calculate downstream dependents for each node
    const dependentsMap = new Map<string, string[]>();
    for (const s of sessions) {
      dependentsMap.set(s.id, []);
    }
    for (const s of sessions) {
      for (const dep of s.dependsOn) {
        if (dependentsMap.has(dep)) {
          dependentsMap.get(dep)?.push(s.id);
        }
      }
    }

    const lanes = new Map<number, number>();
    return sessions.map((s) => {
      const layer = resolve(s.id, new Set());
      const lane = lanes.get(layer) ?? 0;
      lanes.set(layer, lane + 1);

      const verifiedCount = (s.deliverables || []).filter((d) => d.verified).length;

      return {
        id: s.id,
        role: s.role,
        name: s.name,
        task: s.task,
        status: s.status,
        layer,
        lane,
        merged: false,
        model: s.backend?.model,
        branch: s.worktree?.branch,
        spend: s.budget?.costEstimate ?? 0,
        deliverablesCount: (s.deliverables || []).length,
        deliverablesVerified: verifiedCount,
        dependsOn: s.dependsOn || [],
        dependents: dependentsMap.get(s.id) || [],
        provides: s.agreement?.provides || [],
        needs: s.agreement?.needs || [],
        lastError: s.lastError,
        createdAt: s.createdAt,
        lastEventAt: s.lastEventAt,
      };
    });
  }

  /**
   * Build a rich GitHub-style multi-lane visual git commit and branch timeline.
   */
  private buildGitTree(sessions: Session[], history: OrchyEvent[]): GitCommitNode[] {
    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    const branchLaneMap = new Map<string, { lane: number; color: string }>();

    // main is always lane 0
    branchLaneMap.set('main', { lane: 0, color: LANE_COLORS[0] });

    /*
     * Lanes are allocated when a branch is created and released when it ends,
     * exactly as a commit graph does it.
     *
     * Giving every session a permanent lane of its own meant nine agents drew
     * nine parallel rails, and every branch had to leap eight lanes sideways in
     * the height of a single row to reach the trunk — a diagram that is wider
     * than the pane and says nothing about the shape of the work. Reused lanes
     * keep live branches next to main, so a fork is a short hop off the trunk
     * and a merge is a short hop back.
     *
     * This walks forwards in time; `history` arrives newest first, so it is
     * reversed here and the result is looked up by sequence number below.
     */
    const chronological = [...history].reverse();
    const firstSeq = new Map<string, number>();
    const mergedAt = new Map<string, number>();
    const removedAt = new Map<string, number>();
    for (const event of chronological) {
      if (!firstSeq.has(event.session)) {
        firstSeq.set(event.session, event.seq);
      }
      // The earliest of each: a branch's life ends the first time it lands.
      if (event.type === 'merged' && !mergedAt.has(event.session)) {
        mergedAt.set(event.session, event.seq);
      }
      if (
        (event.type === 'archived' || event.type === 'purged') &&
        !removedAt.has(event.session)
      ) {
        removedAt.set(event.session, event.seq);
      }
    }
    /*
     * A merged branch ends at its merge, not at the tidying up afterwards.
     *
     * Archiving a session and deleting its worktree happen minutes later and
     * were being treated as the end of the lane, so six branches that merged
     * one after another all stayed drawn until the last archive — six lanes
     * running the full height of the list, past every merge that had already
     * closed them. Removal only ends a lane that never merged at all.
     */
    const closedAt = new Map<string, number>(
      [...firstSeq.keys()]
        .map((id): [string, number | undefined] => [id, mergedAt.get(id) ?? removedAt.get(id)])
        .filter((e): e is [string, number] => e[1] !== undefined)
    );
    // A branch that has simply gone quiet is not a branch that has ended: it
    // still exists, unmerged, and its rail should reach the top of the list.
    // Only merging or removing it closes the lane.
    const newestSeq = chronological.length ? chronological[chronological.length - 1].seq : 0;
    const lastSeq = new Map<string, number>(
      [...firstSeq.keys()].map((id) => [id, closedAt.get(id) ?? newestSeq])
    );

    /*
     * A lane is occupied for exactly as long as its branch has events, and no
     * longer.
     *
     * Releasing lanes only on merge was not enough: most agents end without
     * merging — they fail, or they finish and sit there — so their lanes were
     * held forever and every later row drew them. That is what filled the
     * gutter with vertical lines running the full height past everything,
     * attached to nothing at either end.
     *
     * With the span known up front this is ordinary interval packing: take the
     * lowest lane whose previous occupant has already finished.
     */
    const laneOfSession = new Map<string, number>();
    const laneFreeAfter: number[] = [];
    const byStart = [...firstSeq.keys()].sort(
      (x, y) => (firstSeq.get(x) ?? 0) - (firstSeq.get(y) ?? 0)
    );
    for (const id of byStart) {
      const start = firstSeq.get(id) ?? 0;
      let lane = 1;
      while (laneFreeAfter[lane] !== undefined && (laneFreeAfter[lane] ?? 0) >= start) {
        lane++;
      }
      laneFreeAfter[lane] = lastSeq.get(id) ?? start;
      laneOfSession.set(id, lane);
    }

    const laneBySeq = new Map<number, number>();
    const activeBySeq = new Map<number, number[]>();
    for (const event of chronological) {
      laneBySeq.set(event.seq, laneOfSession.get(event.session) ?? 0);
      const live = [0];
      for (const [id, lane] of laneOfSession) {
        if ((firstSeq.get(id) ?? 0) <= event.seq && event.seq <= (lastSeq.get(id) ?? 0)) {
          live.push(lane);
        }
      }
      activeBySeq.set(event.seq, live);
    }

    const getLaneForSession = (sessionId: string): { lane: number; color: string } => {
      const lane = laneOfSession.get(sessionId) ?? branchLaneMap.get(sessionId)?.lane ?? 1;
      return { lane, color: LANE_COLORS[lane % LANE_COLORS.length] };
    };

    const now = Date.now();
    const formatRelTime = (iso: string): string => {
      const diff = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
      if (diff < 45) return 'just now';
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
      return `${Math.floor(diff / 86400)}d ago`;
    };

    const commits: GitCommitNode[] = [];

    for (const event of history) {
      const s = sessionMap.get(event.session);
      const sessionLane = laneBySeq.get(event.seq) ?? getLaneForSession(event.session).lane;
      const sessionColor = LANE_COLORS[sessionLane % LANE_COLORS.length];
      const branchName = s?.worktree?.branch || `agent/${event.session}`;
      const role = s?.role || event.session;
      const time = new Date(event.t).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const relTime = formatRelTime(event.t);

      const currentActive = activeBySeq.get(event.seq) ?? [0, sessionLane];

      if (event.type === 'merged') {
        commits.push({
          id: `merge-${event.seq}`,
          sessionId: event.session,
          role,
          branch: branchName,
          lane: 0,
          color: LANE_COLORS[0],
          fromLane: sessionLane,
          toLane: 0,
          kind: 'merge',
          status: 'merged',
          time,
          relativeTime: relTime,
          title: `Merged ${branchName} into main`,
          detail: `Changes from ${event.session} (${role}) verified and integrated into main`,
          deliverables: (s?.deliverables || []).map((d) => ({
            spec: d.spec,
            verified: d.verified,
            detail: d.detail,
          })),
          spend: s?.budget?.costEstimate,
          activeLanes: currentActive,
        });
      } else if (
        (event.type === 'archived' || event.type === 'purged') &&
        !mergedAt.has(event.session)
      ) {
        // Worth a row of its own: without one, a branch that was archived
        // rather than merged had nowhere to end, so its lane ran the whole
        // height of the list looking for a dot that was never drawn.
        //
        // Only when it never merged. Archiving a branch that has already
        // landed is bookkeeping — the branch's life ended at the merge, and a
        // second ending after it would drag the lane back up past its own.
        commits.push({
          id: `${event.type}-${event.seq}`,
          sessionId: event.session,
          role,
          branch: branchName,
          lane: sessionLane,
          color: sessionColor,
          kind: 'closed',
          status: 'archived',
          time,
          relativeTime: relTime,
          title:
            event.type === 'purged'
              ? `Deleted ${branchName}`
              : `Archived ${branchName}`,
          detail:
            event.type === 'purged'
              ? `Branch and worktree removed. Nothing of ${event.session} is left on disk.`
              : `${event.session} was closed without merging. Its branch is no longer live.`,
          deliverables: (s?.deliverables || []).map((d) => ({
            spec: d.spec,
            verified: d.verified,
            detail: d.detail,
          })),
          activeLanes: currentActive,
        });
      } else if (event.type === 'spawned') {
        const parentLane = 0;
        commits.push({
          id: `spawn-${event.seq}`,
          sessionId: event.session,
          role: event.role || role,
          branch: branchName,
          lane: sessionLane,
          color: sessionColor,
          fromLane: parentLane,
          toLane: sessionLane,
          kind: 'fork',
          status: 'spawning',
          time,
          relativeTime: relTime,
          title: `Branched ${branchName} from main`,
          detail: event.task || s?.task || `Spawned agent for role: ${event.role || role}`,
          deliverables: (event.deliverables || s?.deliverables || []).map((d) => ({
            spec: d.spec,
            verified: d.verified,
            detail: d.detail,
          })),
          activeLanes: currentActive,
        });
      } else if (event.type === 'deliverable') {
        commits.push({
          id: `deliv-${event.seq}`,
          sessionId: event.session,
          role,
          branch: branchName,
          lane: sessionLane,
          color: sessionColor,
          kind: 'milestone',
          status: event.verified ? 'complete' : 'idle_unverified',
          time,
          relativeTime: relTime,
          title: `${event.verified ? '✓ Verified' : '⚠ Unverified'} deliverable on ${branchName}`,
          detail: `${event.spec}${event.detail ? ` — ${event.detail}` : ''}`,
          deliverables: [{ spec: event.spec, verified: event.verified, detail: event.detail }],
          activeLanes: currentActive,
        });
      } else if (event.type === 'status') {
        const isAttention = event.status === 'waiting_input' || event.status === 'failed';
        commits.push({
          id: `status-${event.seq}`,
          sessionId: event.session,
          role,
          branch: branchName,
          lane: sessionLane,
          color: sessionColor,
          kind: isAttention ? 'attention' : 'commit',
          status: event.status,
          time,
          relativeTime: relTime,
          title: `Status → ${event.status.replace('_', ' ')} on ${branchName}`,
          detail: event.error || s?.lastError || `Agent ${event.session} entered state: ${event.status}`,
          deliverables: (s?.deliverables || []).map((d) => ({
            spec: d.spec,
            verified: d.verified,
            detail: d.detail,
          })),
          spend: s?.budget?.costEstimate,
          activeLanes: currentActive,
        });
      } else if (event.type === 'message') {
        commits.push({
          id: `msg-${event.seq}`,
          sessionId: event.session,
          role,
          branch: branchName,
          lane: sessionLane,
          color: sessionColor,
          kind: 'commit',
          status: 'running',
          time,
          relativeTime: relTime,
          title: `Coordinated with ${event.to}`,
          detail: event.summary,
          deliverables: [],
          activeLanes: currentActive,
        });
      }
    }

    const shown = commits.slice(0, 100);

    /*
     * Lanes are finally assigned from the rows that exist, not from the events
     * that happened.
     *
     * Sequence numbers include events that draw nothing — archiving a session,
     * deleting its worktree. A lane closed by one of those ended at a position
     * with no row in it, so it stayed active on every row that *was* drawn and
     * ran the full height of the list with no dot to end at. That is the
     * second line beside the trunk: a branch whose life ended somewhere the
     * list cannot show.
     *
     * Working in row positions makes that impossible. A lane spans its own
     * first and last rows, both of which are on screen by construction.
     */
    const newestRow = new Map<string, number>();
    const oldestRow = new Map<string, number>();
    const finished = new Set<string>();
    shown.forEach((c, i) => {
      if (!newestRow.has(c.sessionId)) {
        newestRow.set(c.sessionId, i);
        // The topmost row for a branch is the newest thing that happened to
        // it. If that is where it merged or was closed, the lane ends there;
        // anything else and the branch is still live, so its lane carries on
        // past the newest row in the list rather than stopping mid-air.
        if (c.kind === 'merge' || c.kind === 'closed') {
          finished.add(c.sessionId);
        }
      }
      oldestRow.set(c.sessionId, i);
    });
    for (const id of newestRow.keys()) {
      if (!finished.has(id)) {
        newestRow.set(id, 0);
      }
    }

    // Rows run newest first, so a branch begins at its highest index.
    const byBirth = [...oldestRow.keys()].sort(
      (x, y) => (oldestRow.get(y) ?? 0) - (oldestRow.get(x) ?? 0)
    );
    const laneFor = new Map<string, number>();
    const takenUntil: number[] = [];
    for (const id of byBirth) {
      const birth = oldestRow.get(id) ?? 0;
      let lane = 1;
      // Larger index means older, so a lane is free only if its last occupant
      // died below where this branch is born.
      while (takenUntil[lane] !== undefined && (takenUntil[lane] ?? 0) <= birth) {
        lane++;
      }
      takenUntil[lane] = newestRow.get(id) ?? birth;
      laneFor.set(id, lane);
    }

    const covers = (id: string, row: number): boolean =>
      (newestRow.get(id) ?? 0) <= row && row <= (oldestRow.get(id) ?? 0);

    shown.forEach((c, i) => {
      const lane = laneFor.get(c.sessionId) ?? 1;
      if (c.kind === 'merge') {
        c.fromLane = lane;
        c.toLane = 0;
        c.lane = 0;
        c.color = LANE_COLORS[0];
      } else {
        c.lane = lane;
        c.fromLane = 0;
        c.color = LANE_COLORS[lane % LANE_COLORS.length];
      }
      const live = [0];
      for (const id of laneFor.keys()) {
        if (covers(id, i)) {
          live.push(laneFor.get(id) ?? 1);
        }
      }
      c.activeLanes = live;
    });

    return shown;
  }

  /** Show every agent this workspace has ever had, rather than the current run. */
  private showAllRuns = false;

  /**
   * The agents belonging to the run in progress.
   *
   * A workspace accumulates: three abandoned attempts, a merged pipeline from
   * last week, and the five agents you just started, all drawn on one canvas.
   * The shape of what is happening now is the whole point of this view, and it
   * cannot survive being mixed with the shape of what happened before.
   *
   * The run is the newest plan. Agents spawned by hand after it started count
   * as part of it — they were started while looking at it.
   */
  private currentRun(sessions: Session[]): Session[] {
    const planned = sessions.filter((s) => s.planId);
    if (planned.length === 0) {
      /*
       * No plan ids: agents spawned one at a time, or from before Orchy
       * recorded which run an agent belonged to. Fall back to the burst — a
       * long quiet gap between two spawns is a run boundary, because that is
       * what starting a new pipeline looks like from the outside.
       */
      const RUN_GAP_MS = 8 * 60 * 1000;
      const byTime = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let start = 0;
      for (let i = 1; i < byTime.length; i++) {
        const gap = Date.parse(byTime[i].createdAt) - Date.parse(byTime[i - 1].createdAt);
        if (gap > RUN_GAP_MS) {
          start = i;
        }
      }
      return byTime.slice(start);
    }
    const newest = planned.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
    const run = planned.filter((s) => s.planId === newest.planId);
    const startedAt = run.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b)).createdAt;
    const strays = sessions.filter((s) => !s.planId && s.createdAt >= startedAt);
    return [...run, ...strays].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private push(): void {
    if (!this.panel.visible) {
      return;
    }
    const everything = this.registry.all();
    const sessions = this.showAllRuns ? everything : this.currentRun(everything);
    const inScope = new Set(sessions.map((s) => s.id));
    const nodes = this.layout(sessions);
    const known = new Set(sessions.map((s) => s.id));

    const edges: GraphEdge[] = [];
    for (const session of sessions) {
      for (const dep of session.dependsOn) {
        if (known.has(dep)) {
          edges.push({ from: dep, to: session.id, kind: 'depends' });
        }
      }
    }

    // The timeline follows the same scope: a rail for an agent that is not on
    // the canvas is a line with nothing at either end of it.
    const history = this.registry.history(300).filter((e) => inScope.has(e.session));
    const merged = new Set<string>();
    for (const event of history) {
      if (event.type === 'merged') {
        merged.add(event.session);
      }
    }
    for (const node of nodes) {
      node.merged = merged.has(node.id);
    }

    for (const event of this.registry.messages(150)) {
      if (known.has(event.session) && known.has(event.to)) {
        edges.push({
          from: event.session,
          to: event.to,
          kind: event.summary === 'forked' ? 'fork' : 'relay',
          label: event.summary === 'forked' ? undefined : event.summary,
        });
      }
    }

    const gitTree = this.buildGitTree(sessions, history);

    const stats: PipelineStats = {
      total: sessions.length,
      running: sessions.filter((s) => s.status === 'running' || s.status === 'spawning').length,
      waiting: sessions.filter((s) => s.status === 'waiting_input' || s.status === 'idle_unverified').length,
      complete: sessions.filter((s) => s.status === 'complete').length,
      merged: merged.size,
      failed: sessions.filter((s) => s.status === 'failed').length,
      queued: sessions.filter((s) => s.status === 'queued').length,
      totalSpend: sessions.reduce((sum, s) => sum + (s.budget?.costEstimate || 0), 0),
    };

    void this.panel.webview.postMessage({
      type: 'snapshot',
      data: {
        nodes,
        edges,
        gitTree,
        stats,
        showAllRuns: this.showAllRuns,
        runSize: sessions.length,
        totalSize: everything.length,
      },
    });
  }

  private html(): string {
    const nonce = String(Math.random()).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #cccccc);
    --muted: var(--vscode-descriptionForeground, #858585);
    --line: var(--vscode-panel-border, rgba(128,128,128,.25));
    --card: var(--vscode-editorWidget-background, rgba(127,127,127,.06));
    --hover-bg: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
    --running: var(--vscode-charts-blue, #3794ff);
    --blocked: var(--vscode-charts-yellow, #cca700);
    --unverified: var(--vscode-charts-orange, #d18616);
    --done: var(--vscode-charts-green, #89d185);
    --failed: var(--vscode-charts-red, #f14c4c);
    --merged: var(--vscode-charts-purple, #bc8cff);
    --mono: var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
    font-size: 12px; line-height: 1.4;
    display: flex; flex-direction: column;
  }

  /* Top Mission Control Toolbar */
  #toolbar {
    flex: 0 0 auto;
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 14px; background: var(--card);
    border-bottom: 1px solid var(--line);
    gap: 12px; z-index: 10;
  }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
  .brand .logo { color: var(--running); font-size: 14px; font-weight: 700; }
  
  /* Mode Switcher */
  .mode-switch {
    display: flex; background: var(--bg); border: 1px solid var(--line);
    border-radius: 6px; padding: 2px; gap: 2px;
  }
  .mode-btn {
    background: none; border: none; color: var(--muted);
    padding: 3px 10px; font-size: 11px; border-radius: 4px;
    cursor: pointer; font-weight: 500;
  }
  .mode-btn:hover { color: var(--fg); }
  .mode-btn.active { background: var(--card); color: var(--running); font-weight: 600; }

  /* Live HUD Chips */
  .hud { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 7px; border-radius: 99px;
    border: 1px solid var(--line); background: var(--bg);
    font-size: 10.5px; font-weight: 500;
  }
  .chip .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
  .chip.exec .dot { background: var(--running); }
  .chip.wait .dot { background: var(--blocked); }
  .chip.done .dot { background: var(--done); }
  .chip.mrg .dot { background: var(--merged); }
  .chip.err .dot { background: var(--failed); }
  .chip.spend { color: var(--muted); font-family: var(--mono); }

  /* Actions & Search */
  .actions-bar { display: flex; align-items: center; gap: 6px; }
  .search-box {
    background: var(--bg); border: 1px solid var(--line);
    color: var(--fg); border-radius: 5px;
    padding: 3px 8px; font-size: 11px; outline: none; width: 160px;
    transition: width .2s ease, border-color .2s ease;
  }
  .search-box:focus { width: 220px; border-color: var(--running); }
  .tbtn {
    background: var(--bg); border: 1px solid var(--line);
    color: var(--fg); border-radius: 5px;
    padding: 3px 9px; font-size: 11px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .tbtn:hover { border-color: var(--running); color: var(--running); }
  .tbtn.primary { background: color-mix(in srgb, var(--running) 20%, var(--bg)); border-color: var(--running); }

  /* Main Workspace Area */
  #main-content {
    flex: 1 1 auto; display: flex; min-height: 0; position: relative;
  }

  /* Left Pane: Workflow DAG */
  #workflow-pane {
    flex: 1 1 50%; display: flex; flex-direction: column;
    min-width: 320px; border-right: 1px solid var(--line);
    position: relative; overflow: hidden;
  }
  .pane-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 12px; background: var(--card); border-bottom: 1px solid var(--line);
    font-size: 11px; color: var(--muted); font-weight: 600; text-transform: uppercase;
  }
  .pane-header .ctrls { display: flex; gap: 4px; align-items: center; }
  .icon-btn {
    background: none; border: 1px solid var(--line); border-radius: 4px;
    color: var(--muted); cursor: pointer; width: 22px; height: 22px;
    padding: 0; display: inline-flex; align-items: center; justify-content: center;
    font-size: 12px;
  }
  .icon-btn:hover { color: var(--fg); border-color: var(--running); }

  #dag-canvas {
    flex: 1 1 auto; overflow-x: hidden; overflow-y: auto; background: var(--bg);
    position: relative; user-select: none;
  }
  #dag-canvas svg { display: block; }

  /* Stage & Node SVG Styles */
  .stage-rect { fill: color-mix(in srgb, var(--card) 40%, transparent); stroke: var(--line); stroke-dasharray: 4 3; rx: 8; }
  .stage-title { font-size: 10px; font-weight: 600; fill: var(--muted); text-transform: uppercase; }
  
  .node-g { cursor: pointer; transition: transform .15s ease; }
  .node-bg { fill: var(--card); stroke: var(--line); stroke-width: 1.4; rx: 8; transition: stroke .15s ease, filter .15s ease; }
  .node-g:hover .node-bg { stroke: var(--running); filter: drop-shadow(0 2px 8px rgba(0,0,0,.35)); }
  .node-g.selected .node-bg { stroke: var(--running); stroke-width: 2; filter: drop-shadow(0 0 8px color-mix(in srgb, var(--running) 60%, transparent)); }
  .node-g.highlighted .node-bg { stroke: var(--done); stroke-width: 2; }
  .node-g.dependent-hl .node-bg { stroke: var(--unverified); stroke-width: 2; }

  .node-g.running .node-bg { stroke: color-mix(in srgb, var(--running) 60%, var(--line)); }
  .node-g.waiting_input .node-bg { stroke: var(--blocked); }
  .node-g.idle_unverified .node-bg { stroke: var(--unverified); }
  .node-g.complete .node-bg { stroke: color-mix(in srgb, var(--done) 60%, var(--line)); }
  .node-g.failed .node-bg { stroke: var(--failed); }
  .node-g.merged .node-bg { stroke: var(--merged); }

  .node-pip { r: 4.5; }
  .running .node-pip { fill: var(--running); }
  .waiting_input .node-pip { fill: var(--blocked); }
  .idle_unverified .node-pip { fill: var(--unverified); }
  .complete .node-pip { fill: var(--done); }
  .failed .node-pip { fill: var(--failed); }
  .queued .node-pip { fill: var(--muted); }
  .merged .node-pip { fill: var(--merged); }

  .node-id { font-size: 11.5px; font-weight: 600; fill: var(--fg); }
  .node-role { font-size: 9.5px; fill: var(--muted); }
  .node-task { font-size: 9.5px; fill: var(--muted); opacity: .85; }
  .node-model { font-size: 8.5px; font-family: var(--mono); fill: var(--running); }
  .node-prog { font-size: 8.5px; font-family: var(--mono); fill: var(--done); }
  .node-spend { font-size: 9px; font-family: var(--mono); fill: var(--muted); text-anchor: end; }

  /* SVG Edges */
  .dag-edge { fill: none; stroke: var(--muted); stroke-width: 1.4; opacity: .5; transition: stroke .2s ease, opacity .2s ease, stroke-width .2s ease; }
  .dag-edge.relay { stroke: var(--running); stroke-dasharray: 4 3; }
  .dag-edge.fork { stroke: var(--merged); stroke-dasharray: 2 3; }
  .dag-edge.hl { stroke: var(--running); opacity: 1; stroke-width: 2.4; }
  .dag-edge.hl-dep { stroke: var(--done); opacity: 1; stroke-width: 2.4; }

  /* Legend footer */
  .dag-legend {
    flex: 0 0 auto; padding: 6px 12px; background: var(--card); border-top: 1px solid var(--line);
    display: flex; gap: 12px; font-size: 10px; color: var(--muted); flex-wrap: wrap; align-items: center;
  }
  .dag-legend-item { display: inline-flex; align-items: center; gap: 4px; }
  .dag-legend-item .sdot { width: 6px; height: 6px; border-radius: 50%; }

  /* Right Pane: GitHub-Style Git Tree Timeline */
  #git-tree-pane {
    flex: 1 1 50%; display: flex; flex-direction: column;
    min-width: 340px; background: var(--bg); overflow: hidden;
  }
  /* The rail is one continuous drawing behind every row, the way a commit
     graph works. Rows used to be separate cards each with its own little SVG,
     so every lane was chopped into disconnected stubs with gaps between them —
     a branch you could not actually follow with your eye. */
  #git-tree-list {
    flex: 1 1 auto; overflow-y: auto; padding: 4px 14px 24px 0;
    position: relative; --gutter: 64px;
  }
  .git-rail-overlay {
    position: absolute; left: 0; top: 0; width: var(--gutter);
    pointer-events: none; overflow: visible;
  }

  /* Every row the same height, like a commit log. Rows that grew to fit their
     own contents put every dot at a different spacing, which is the difference
     between a graph and a scatter of circles. The detail is one click away. */
  .git-row {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 6px 8px 6px 0; cursor: pointer; position: relative;
    border-left: 2px solid transparent;
    height: 52px; overflow: hidden;
  }
  .git-row.selected { height: auto; overflow: visible; }
  .git-row:hover { background: var(--hover-bg); }
  .git-row.selected { background: color-mix(in srgb, var(--running) 10%, transparent);
                      border-left-color: var(--running); }

  /* Space the rail draws into. The width follows how many lanes are alive. */
  .git-rail { flex: 0 0 var(--gutter); }

  .git-content { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .git-top { display: flex; align-items: center; gap: 8px; font-size: 11px; }
  .git-branch-badge {
    padding: 1px 7px; border-radius: 99px; font-size: 10px; font-family: var(--mono);
    font-weight: 600; border: 1px solid var(--line);
  }
  .git-badge {
    font-size: 9.5px; font-weight: 600; text-transform: uppercase;
    padding: 1px 5px; border-radius: 3px;
  }
  .git-badge.merged { background: color-mix(in srgb, var(--merged) 20%, transparent); color: var(--merged); }
  .git-badge.spawning, .git-badge.running { background: color-mix(in srgb, var(--running) 20%, transparent); color: var(--running); }
  .git-badge.waiting_input { background: color-mix(in srgb, var(--blocked) 20%, transparent); color: var(--blocked); }
  .git-badge.idle_unverified { background: color-mix(in srgb, var(--unverified) 20%, transparent); color: var(--unverified); }
  .git-badge.complete { background: color-mix(in srgb, var(--done) 20%, transparent); color: var(--done); }
  .git-badge.failed { background: color-mix(in srgb, var(--failed) 20%, transparent); color: var(--failed); }

  .git-time { margin-left: auto; color: var(--muted); font-size: 10px; }

  .git-title { font-weight: 600; font-size: 12px; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .git-detail { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  
  .git-chips { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px; }
  .deliv-chip {
    font-size: 9.5px; font-family: var(--mono); padding: 0 5px; border-radius: 3px;
    border: 1px solid var(--line); background: var(--bg);
  }
  .deliv-chip.v-yes { color: var(--done); border-color: color-mix(in srgb, var(--done) 40%, var(--line)); }
  .deliv-chip.v-no { color: var(--unverified); border-color: color-mix(in srgb, var(--unverified) 40%, var(--line)); }

  /* Every row carrying four buttons made each one tall enough that the graph
     beside it was mostly empty gutter. They appear for the row under the
     pointer, which is the only row they can be meant for. */
  /* Detail, deliverables and controls belong to the row you picked, not to all
     forty of them at once. */
  .git-detail, .git-chips, .git-actions { display: none; }
  .git-row.selected .git-detail { display: block; }
  .git-row.selected .git-chips { display: flex; }
  .git-row.selected .git-actions { display: flex; gap: 4px; align-items: center; margin-top: 4px; }
  .git-actions button {
    background: none; border: 1px solid var(--line); border-radius: 4px;
    color: var(--muted); font-size: 10px; padding: 1px 6px; cursor: pointer;
  }
  .git-actions button:hover { color: var(--fg); border-color: var(--running); }
  .git-actions button.prim:hover { color: var(--running); }

  /* Deep-Dive Inspector Drawer */
  #inspector-drawer {
    position: absolute; top: 0; right: 0; bottom: 0; width: 380px;
    background: var(--bg); border-left: 1px solid var(--line);
    box-shadow: -4px 0 16px rgba(0,0,0,.4);
    display: flex; flex-direction: column;
    transform: translateX(100%); transition: transform .2s ease-in-out;
    z-index: 20;
  }
  #inspector-drawer.open { transform: translateX(0); }
  .drawer-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; background: var(--card); border-bottom: 1px solid var(--line);
  }
  .drawer-title { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 8px; }
  .drawer-body { flex: 1 1 auto; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
  
  .d-section { display: flex; flex-direction: column; gap: 6px; }
  .d-label { font-size: 10.5px; font-weight: 600; text-transform: uppercase; color: var(--muted); letter-spacing: .04em; }
  .d-card { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font-size: 11.5px; }
  .d-row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid color-mix(in srgb, var(--line) 40%, transparent); }
  .d-row:last-child { border-bottom: none; }
  .d-key { color: var(--muted); }
  .d-val { font-weight: 500; }
  .d-val.mono { font-family: var(--mono); font-size: 10.5px; }

  .d-deliv-item {
    display: flex; align-items: baseline; gap: 6px; padding: 4px 0;
    font-size: 11px; font-family: var(--mono);
  }
  .d-deliv-item .v-icon { font-size: 11px; }
  .d-deliv-item .v-icon.pass { color: var(--done); }
  .d-deliv-item .v-icon.fail { color: var(--unverified); }

  .d-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .d-btn {
    flex: 1 1 calc(50% - 3px);
    background: var(--card); border: 1px solid var(--line); border-radius: 5px;
    padding: 6px 10px; font-size: 11.5px; font-weight: 500; color: var(--fg);
    cursor: pointer; text-align: center;
  }
  .d-btn:hover { border-color: var(--running); color: var(--running); }
  .d-btn.primary { background: color-mix(in srgb, var(--running) 20%, var(--card)); border-color: var(--running); }
  .d-btn.danger:hover { border-color: var(--failed); color: var(--failed); }

  .empty-state { text-align: center; color: var(--muted); padding: 40px 20px; line-height: 1.6; }
</style>
</head>
<body>

<!-- Top Mission Control Toolbar -->
<header id="toolbar">
  <div class="brand">
    <span class="logo">⚡</span>
    <span>Orchy Pipeline</span>
  </div>

  <div class="mode-switch">
    <button class="mode-btn active" data-view="split">Split</button>
    <button class="mode-btn" data-view="workflow">Workflow</button>
    <button class="mode-btn" data-view="tree">Git Tree</button>
  </div>

  <div class="hud" id="hud">
    <!-- Populated dynamically -->
  </div>

  <div class="actions-bar">
    <input type="text" id="search" class="search-box" placeholder="Filter agents, roles, branches...">
    <button class="tbtn primary" data-act="spawn">+ Spawn</button>
    <button class="tbtn" data-act="setupLayout">⊞ Grid</button>
    <button class="tbtn" id="scope-btn" data-act="toggleScope" title="Show only the pipeline you are running, or everything this workspace has ever run">This run</button>
    <button class="tbtn" data-act="cleanupTerminals">🧹 Terminals</button>
    <button class="tbtn" data-act="refresh">⟳</button>
  </div>
</header>

<!-- Main Workspace -->
<main id="main-content">
  
  <!-- Left: Workflow DAG Canvas -->
  <section id="workflow-pane">
    <div class="pane-header">
      <span>Workflow Topology</span>
      <div class="ctrls">
        <button class="icon-btn" data-zoom="in" title="Zoom In">+</button>
        <button class="icon-btn" data-zoom="out" title="Zoom Out">-</button>
        <button class="icon-btn" data-zoom="fit" title="Reset View">⤢</button>
      </div>
    </div>
    <div id="dag-canvas"></div>
    <div class="dag-legend">
      <span class="dag-legend-item"><span class="sdot" style="background:var(--running)"></span>Executing</span>
      <span class="dag-legend-item"><span class="sdot" style="background:var(--blocked)"></span>Waiting</span>
      <span class="dag-legend-item"><span class="sdot" style="background:var(--done)"></span>Success</span>
      <span class="dag-legend-item"><span class="sdot" style="background:var(--merged)"></span>Merged</span>
      <span class="dag-legend-item"><span class="sdot" style="background:var(--failed)"></span>Failed</span>
      <span class="dag-legend-item"><span class="sdot" style="background:var(--muted)"></span>Queued</span>
    </div>
  </section>

  <!-- Right: GitHub-Style Git Tree Timeline -->
  <section id="git-tree-pane">
    <div class="pane-header">
      <span>Git Branch & Commit Tree</span>
      <span id="commit-count" style="font-weight:400; opacity:.8;">0 events</span>
    </div>
    <div id="git-tree-list"></div>
  </section>

  <!-- Deep Dive Inspector Drawer -->
  <aside id="inspector-drawer">
    <div class="drawer-head">
      <div class="drawer-title" id="d-title">Agent Inspector</div>
      <button class="icon-btn" id="d-close" title="Close Drawer">&#10005;</button>
    </div>
    <div class="drawer-body" id="d-body">
      <!-- Populated dynamically on node select -->
    </div>
  </aside>

</main>

<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const hud = document.getElementById('hud');
  const dagCanvas = document.getElementById('dag-canvas');
  const gitTreeList = document.getElementById('git-tree-list');
  const scopeBtn = document.getElementById('scope-btn');
  const commitCount = document.getElementById('commit-count');
  const searchInput = document.getElementById('search');
  const drawer = document.getElementById('inspector-drawer');
  const drawerTitle = document.getElementById('d-title');
  const drawerBody = document.getElementById('d-body');
  const drawerClose = document.getElementById('d-close');

  let state = {
    nodes: [],
    edges: [],
    gitTree: [],
    stats: null,
    selectedNodeId: null,
    filter: '',
    viewMode: 'split',
    zoom: 1,
    // Start fitted. Zooming in is a deliberate act, and returns to this.
    fitWidth: true
  };

  const esc = s => String(s || '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'snapshot') {
      state.nodes = e.data.data.nodes || [];
      state.edges = e.data.data.edges || [];
      state.gitTree = e.data.data.gitTree || [];
      state.showAllRuns = !!e.data.data.showAllRuns;
      state.runSize = e.data.data.runSize || 0;
      state.totalSize = e.data.data.totalSize || 0;
      state.stats = e.data.data.stats || {};
      render();
    }
  });

  function render() {
    if (scopeBtn) {
      scopeBtn.textContent = state.showAllRuns
        ? 'All runs · ' + (state.totalSize || 0)
        : 'This run · ' + (state.runSize || 0);
      scopeBtn.classList.toggle('primary', !state.showAllRuns);
    }
    renderHud();
    renderWorkflow();
    renderGitTree();
    if (state.selectedNodeId) {
      renderInspector(state.selectedNodeId);
    }
  }

  function renderHud() {
    const s = state.stats;
    if (!s) return;
    hud.innerHTML =
      '<span class="chip exec"><span class="dot"></span>' + s.running + ' Active</span>' +
      (s.waiting > 0 ? '<span class="chip wait"><span class="dot"></span>' + s.waiting + ' Waiting</span>' : '') +
      '<span class="chip done"><span class="dot"></span>' + s.complete + ' Done</span>' +
      '<span class="chip mrg"><span class="dot"></span>' + s.merged + ' Merged</span>' +
      (s.failed > 0 ? '<span class="chip err"><span class="dot"></span>' + s.failed + ' Failed</span>' : '') +
      (s.queued > 0 ? '<span class="chip"><span class="dot"></span>' + s.queued + ' Queued</span>' : '') +
      (s.totalSpend > 0 ? '<span class="chip spend">$' + s.totalSpend.toFixed(3) + '</span>' : '');
  }

  const NW = 180, NH = 74, GAPX = 80, GAPY = 24, PADX = 30, PADY = 40;

  // SVG text neither wraps nor ellipsizes: anything too wide simply runs out of
  // its box and over whatever is beside it. Trim to what the box can hold.
  function fit(text, px, perChar) {
    const t = String(text || '');
    const max = Math.floor(px / perChar);
    return t.length <= max ? t : t.slice(0, Math.max(1, max - 1)) + '\u2026';
  }

  function renderWorkflow() {
    const filter = state.filter.toLowerCase();
    const visibleNodes = state.nodes.filter(n =>
      !filter || n.id.toLowerCase().includes(filter) || n.role.toLowerCase().includes(filter) || n.status.toLowerCase().includes(filter)
    );

    if (!visibleNodes.length) {
      dagCanvas.innerHTML = '<div class="empty-state">No pipeline agents found matching your filter.</div>';
      return;
    }

    const layers = Math.max(...state.nodes.map(n => n.layer), 0) + 1;
    const lanes = Math.max(...state.nodes.map(n => n.lane), 0) + 1;
    const W = PADX * 2 + layers * NW + (layers - 1) * GAPX;
    const H = PADY + lanes * (NH + GAPY) + 20;
    const pos = Object.fromEntries(state.nodes.map(n => [n.id, n]));

    const cx = n => PADX + n.layer * (NW + GAPX);
    const cy = n => PADY + n.lane * (NH + GAPY);

    /*
     * Fitted to the pane by default.
     *
     * The diagram used to be drawn at full size and left to overflow, so a
     * pipeline of any width had to be scrolled sideways to be read at all —
     * and the shape of a pipeline is the one thing that has to be legible in a
     * glance. Zooming in is a deliberate act now, not the starting position.
     */
    const avail = Math.max(160, dagCanvas.clientWidth - 18);
    const scale = state.fitWidth ? Math.min(1, avail / W) : state.zoom;
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + Math.round(W * scale) +
      '" height="' + Math.round(H * scale) + '">';

    // Stage columns
    for (let l = 0; l < layers; l++) {
      const sx = PADX + l * (NW + GAPX) - 10;
      const sw = NW + 20;
      const sh = H - PADY + 10;
      svg += '<rect class="stage-rect" x="' + sx + '" y="' + (PADY - 24) + '" width="' + sw + '" height="' + sh + '"/>';
      svg += '<text class="stage-title" x="' + (sx + 8) + '" y="' + (PADY - 10) + '">Stage ' + (l + 1) + '</text>';
    }

    // Edges
    const sel = state.selectedNodeId ? pos[state.selectedNodeId] : null;
    for (const e of state.edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      const x1 = cx(a) + NW, y1 = cy(a) + NH / 2;
      const x2 = cx(b), y2 = cy(b) + NH / 2;
      const mid = (x1 + x2) / 2;
      const isHl = sel && (sel.id === a.id || sel.id === b.id);
      const hlClass = isHl ? ' hl' : '';

      const path = e.kind === 'depends'
        ? 'M' + x1 + ' ' + y1 + ' C' + mid + ' ' + y1 + ',' + mid + ' ' + y2 + ',' + x2 + ' ' + y2
        : 'M' + (cx(a) + NW / 2) + ' ' + cy(a) + ' C' + (cx(a) + NW / 2) + ' ' + (cy(a) - 24) +
          ',' + (cx(b) + NW / 2) + ' ' + (cy(b) - 24) + ',' + (cx(b) + NW / 2) + ' ' + cy(b);

      svg += '<path class="dag-edge ' + esc(e.kind) + hlClass + '" d="' + path + '"><title>' +
             esc(e.label || e.kind) + '</title></path>';
    }

    // Nodes
    for (const n of state.nodes) {
      const x = cx(n), y = cy(n);
      const isSelected = state.selectedNodeId === n.id;
      const isUpstream = sel && sel.dependsOn.includes(n.id);
      const isDownstream = sel && sel.dependents.includes(n.id);
      let hlClasses = isSelected ? ' selected' : '';
      if (isUpstream) hlClasses += ' highlighted';
      if (isDownstream) hlClasses += ' dependent-hl';

      const progText = n.deliverablesCount > 0
        ? n.deliverablesVerified + '/' + n.deliverablesCount + ' verified'
        : 'no deliverables';

      svg += '<g class="node-g ' + esc(n.status) + (n.merged ? ' merged' : '') + hlClasses + '" data-id="' + esc(n.id) + '">' +
        '<rect class="node-bg" x="' + x + '" y="' + y + '" width="' + NW + '" height="' + NH + '"/>' +
        '<circle class="node-pip" cx="' + (x + 14) + '" cy="' + (y + 16) + '"/>' +
        '<text class="node-id" x="' + (x + 26) + '" y="' + (y + 19) + '">' +
          esc(fit(n.id, n.spend > 0 ? NW - 88 : NW - 40, 6.3)) + '</text>' +
        (n.spend > 0 ? '<text class="node-spend" x="' + (x + NW - 10) + '" y="' + (y + 18) + '">$' + n.spend.toFixed(3) + '</text>' : '') +
        '<text class="node-role" x="' + (x + 14) + '" y="' + (y + 35) + '">' +
          esc(fit(n.role + (n.merged ? ' \u00b7 merged' : ''), NW - 28, 5.9)) + '</text>' +
        '<text class="node-task" x="' + (x + 14) + '" y="' + (y + 49) + '">' +
          esc(fit(n.task, NW - 28, 5.2)) + '</text>' +
        '<text class="node-prog" x="' + (x + 14) + '" y="' + (y + 63) + '">' +
          esc(fit(progText, n.model ? (NW - 28) * 0.5 : NW - 28, 5.2)) + '</text>' +
        (n.model ? '<text class="node-model" x="' + (x + NW - 10) + '" y="' + (y + 63) + '" text-anchor="end">' +
          esc(fit(n.model.split('/').pop() || '', (NW - 28) * 0.5, 5.2)) + '</text>' : '') +
        '<title>' + esc(n.id + ' (' + n.role + ') — ' + n.status + '\\n' + n.task) + '</title></g>';
    }

    dagCanvas.innerHTML = svg + '</svg>';
  }

  function renderGitTree() {
    const filter = state.filter.toLowerCase();
    const visibleCommits = state.gitTree.filter(c =>
      !filter || c.sessionId.toLowerCase().includes(filter) || c.branch.toLowerCase().includes(filter) || c.title.toLowerCase().includes(filter) || (c.detail && c.detail.toLowerCase().includes(filter))
    );

    commitCount.textContent = visibleCommits.length + ' event' + (visibleCommits.length === 1 ? '' : 's');

    if (!visibleCommits.length) {
      gitTreeList.innerHTML = '<div class="empty-state">No git branch events recorded yet.</div>';
      return;
    }

    let html = '';
    for (const c of visibleCommits) {
      const isSelected = state.selectedNodeId === c.sessionId;

      const delivChips = (c.deliverables || []).map(d =>
        '<span class="deliv-chip ' + (d.verified ? 'v-yes' : 'v-no') + '">' +
        (d.verified ? '✓ ' : '⚠ ') + esc(d.spec) + '</span>'
      ).join('');

      html += '<div class="git-row ' + (isSelected ? 'selected' : '') + '" data-id="' + esc(c.sessionId) + '">' +
        '<div class="git-rail"></div>' +
        '<div class="git-content">' +
          '<div class="git-top">' +
            '<span class="git-branch-badge" style="color:' + esc(c.color) + '; border-color:color-mix(in srgb,' + esc(c.color) + ' 40%, var(--line));">' + esc(c.branch) + '</span>' +
            '<span class="git-badge ' + esc(c.status) + '">' + esc(c.status.replace('_', ' ')) + '</span>' +
            '<span class="git-time" title="' + esc(c.time) + '">' + esc(c.relativeTime) + '</span>' +
          '</div>' +
          '<div class="git-title">' + esc(c.title) + '</div>' +
          (c.detail ? '<div class="git-detail">' + esc(c.detail) + '</div>' : '') +
          (delivChips ? '<div class="git-chips">' + delivChips + '</div>' : '') +
          '<div class="git-actions">' +
            '<button class="prim" data-act="openTerminal" data-id="' + esc(c.sessionId) + '">&gt;_ Terminal</button>' +
            '<button data-act="inspect" data-id="' + esc(c.sessionId) + '">🔍 Details</button>' +
            '<button data-act="verify" data-id="' + esc(c.sessionId) + '">✓ Verify</button>' +
            '<button data-act="merge" data-id="' + esc(c.sessionId) + '">⑂ Merge</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    gitTreeList.innerHTML = html;
    railCommits = visibleCommits;
    drawRail();
  }

  /* Lane palette, mirrored from the extension so lanes other than the one a
     row belongs to can still be drawn in their own colour. */
  const LANE_COLORS = ['#bc8cff', '#58a6ff', '#3fb950', '#f0883e', '#39c5cf',
                       '#e3b341', '#f778ba', '#7ee787', '#d2a8ff', '#ffa657'];
  const laneColor = l => LANE_COLORS[l % LANE_COLORS.length];

  let railCommits = [];

  /**
   * Draw every lane as one figure across the whole list.
   *
   * Row heights vary — deliverable chips, an error line, the action row — so
   * the geometry cannot be assumed. It is measured after the rows are in the
   * DOM, which is also what lets a merge curve start at the row below it
   * rather than stopping at an invisible box edge.
   *
   * History runs newest first, so time runs *up* the list: a branch is created
   * at the bottom of its lane and merges back at the top.
   */
  function drawRail() {
    const existing = gitTreeList.querySelector('.git-rail-overlay');
    if (existing) existing.remove();

    const rows = Array.from(gitTreeList.querySelectorAll('.git-row'));
    if (!rows.length || !railCommits.length) return;

    const EDGE = 14, DOT = 5.2;
    let maxLane = 0;
    for (const c of railCommits) {
      for (const l of [c.lane, c.fromLane || 0, c.toLane || 0].concat(c.activeLanes || [])) {
        if (l > maxLane) maxLane = l;
      }
    }
    // The rail never pushes the text sideways off the pane: it gets at most a
    // third of the width and packs its lanes into that. Wide pipelines get
    // tighter lanes rather than a horizontal scrollbar.
    const budget = Math.max(40, Math.min(gitTreeList.clientWidth * 0.33, 190) - EDGE * 2);
    const LANE_W = maxLane > 0 ? Math.max(8, Math.min(18, Math.floor(budget / maxLane))) : 18;
    const gutter = EDGE * 2 + maxLane * LANE_W;
    gitTreeList.style.setProperty('--gutter', gutter + 'px');

    const lx = l => EDGE + l * LANE_W;
    /*
     * The dot belongs to the row's first line, not to the middle of however
     * tall the row happens to be. Anchoring to the middle meant one expanded
     * row pushed its dot out of line with every other, and a graph whose dots
     * do not line up does not read as a graph at all.
     */
    const ANCHOR = 26;
    const geo = rows.map(r => ({
      top: r.offsetTop,
      bottom: r.offsetTop + r.offsetHeight,
      mid: Math.min(r.offsetTop + r.offsetHeight / 2, r.offsetTop + ANCHOR),
    }));

    const line = (x, y1, y2, color, opacity) =>
      '<line x1="' + x + '" y1="' + y1 + '" x2="' + x + '" y2="' + y2 + '" stroke="' + color +
      '" stroke-width="2.2" opacity="' + opacity + '" stroke-linecap="round"/>';

    /*
     * A branch turns near its dot and runs straight the rest of the way.
     *
     * Stretching one S-curve across a whole row is what made this look limp:
     * rows here are tall, so the bend was a lazy diagonal drifting across the
     * gutter. Real graph tools bend tightly and travel straight, which is also
     * what makes a lane readable as a lane. BEND caps how much of the row the
     * turn is allowed to use.
     */
    const BEND = 26;
    const curve = (x1, yFar, x2, yDot, color) => {
      const dir = yFar > yDot ? 1 : -1;
      const bend = Math.min(BEND, Math.abs(yFar - yDot));
      const yTurn = yDot + dir * bend;
      const c1 = yDot + dir * bend * 0.55;
      return '<path d="M' + x1 + ' ' + yFar + ' L' + x1 + ' ' + yTurn +
        ' C' + x1 + ' ' + c1 + ',' + x2 + ' ' + c1 + ',' + x2 + ' ' + yDot +
        '" fill="none" stroke="' + color + '" stroke-width="2.2" ' +
        'stroke-linecap="round" stroke-linejoin="round"/>';
    };

    let s = '';
    railCommits.forEach((c, i) => {
      const g = geo[i];
      if (!g) return;
      const lanes = (c.activeLanes && c.activeLanes.length ? c.activeLanes : [0]);
      /*
       * Rows run newest first, so the row above is later in time and the row
       * below is earlier, and a lane missing from one of them ends here.
       *
       * Beyond the list there is nothing, which is the truth: the newest row
       * is where a branch that closed there stops. Pretending lanes continued
       * past the ends was a workaround for terminating lanes on rows they did
       * not belong to; the ownership check below handles that properly, and this made the
       * closing dot on the newest row grow a line out of the top of the list.
       */
      const above = i > 0 ? railCommits[i - 1].activeLanes || [0] : [];
      const below = i < railCommits.length - 1 ? railCommits[i + 1].activeLanes || [0] : [];

      for (const lane of lanes) {
        const color = laneColor(lane);
        const isTrunk = lane === 0;
        const opacity = lane === c.lane || isTrunk ? 0.95 : 0.5;
        // A lane may only begin or end on a row that is actually its own. Any
        // other row it merely passes through, whatever the neighbours say.
        const owns = lane === c.lane || (c.kind === 'merge' && lane === c.fromLane);
        const newest = !isTrunk && owns && above.indexOf(lane) === -1;
        const oldest = !isTrunk && owns && below.indexOf(lane) === -1;

        if (c.kind === 'merge' && lane === c.fromLane && lane !== c.lane) {
          // Folds into the trunk here, so it has no rail above this row.
          if (!oldest) {
            s += line(lx(lane), g.mid + BEND, g.bottom, color, opacity);
          }
          s += curve(lx(lane), g.mid + BEND, lx(c.lane), g.mid, color);
        } else {
          const y1 = newest ? g.mid : g.top;
          // Stops at the dot. Carrying on past it by the bend distance left a
          // stub hanging below every branch point, attached to nothing.
          const y2 = oldest ? g.mid : g.bottom;
          if (y2 > y1) {
            s += line(lx(lane), y1, y2, color, opacity);
          }
        }

        // Wherever a branch begins, it begins on the trunk.
        if (oldest && !(c.kind === 'merge' && lane === c.fromLane)) {
          s += curve(lx(0), g.bottom, lx(lane), g.mid, color);
        }
      }

      // The dot says what kind of moment this was without reading the text.
      const x = lx(c.lane), y = g.mid, col = c.color || laneColor(c.lane);
      if (c.kind === 'merge') {
        s += '<circle cx="' + x + '" cy="' + y + '" r="' + (DOT + 1.4) + '" fill="var(--bg)" ' +
             'stroke="' + col + '" stroke-width="2.6"/>';
      } else if (c.kind === 'closed') {
        // A branch that ended without landing: an open ring, deliberately
        // quiet, so it reads as a stop rather than an achievement.
        s += '<circle cx="' + x + '" cy="' + y + '" r="' + (DOT - 0.6) + '" fill="var(--bg)" ' +
             'stroke="var(--muted)" stroke-width="2"/>';
      } else if (c.kind === 'attention') {
        s += '<circle cx="' + x + '" cy="' + y + '" r="' + (DOT + 0.6) + '" fill="var(--bg)" ' +
             'stroke="var(--blocked)" stroke-width="2.4"/>';
      } else if (c.kind === 'milestone') {
        s += '<rect x="' + (x - DOT) + '" y="' + (y - DOT) + '" width="' + (DOT * 2) + '" ' +
             'height="' + (DOT * 2) + '" rx="1.4" fill="' + col + '" stroke="var(--bg)" ' +
             'stroke-width="2" transform="rotate(45 ' + x + ' ' + y + ')"/>';
      } else {
        s += '<circle cx="' + x + '" cy="' + y + '" r="' + (c.kind === 'fork' ? DOT : DOT - 1.2) +
             '" fill="' + col + '" stroke="var(--bg)" stroke-width="2"/>';
      }
    });

    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.setAttribute('class', 'git-rail-overlay');
    overlay.setAttribute('height', String(gitTreeList.scrollHeight));
    overlay.setAttribute('width', String(gutter));
    overlay.innerHTML = s;
    gitTreeList.appendChild(overlay);
  }

  // Both surfaces are sized against the pane, so both follow it.
  window.addEventListener('resize', () => {
    drawRail();
    renderWorkflow();
  });

  function renderInspector(id) {
    const node = state.nodes.find(n => n.id === id);
    if (!node) {
      drawer.classList.remove('open');
      return;
    }

    drawerTitle.textContent = node.id + ' · ' + node.role;

    const delivItems = (node.deliverablesCount > 0)
      ? state.gitTree.filter(c => c.sessionId === node.id).flatMap(c => c.deliverables || []).slice(0, 8).map(d =>
          '<div class="d-deliv-item">' +
            '<span class="v-icon ' + (d.verified ? 'pass' : 'fail') + '">' + (d.verified ? '✓' : '⚠') + '</span>' +
            '<span>' + esc(d.spec) + '</span>' +
          '</div>'
        ).join('') || '<div style="color:var(--muted); font-size:11px;">' + node.deliverablesVerified + ' of ' + node.deliverablesCount + ' deliverables verified</div>'
      : '<div style="color:var(--muted); font-size:11px;">No declared deliverables</div>';

    const providesItems = (node.provides || []).map(p =>
      '<div class="d-row"><span class="d-key">' + esc(p.symbol) + '</span><span class="d-val mono">' + esc(p.file) + '</span></div>'
    ).join('') || '<div style="color:var(--muted); font-size:11px;">None declared</div>';

    const needsItems = (node.needs || []).map(n =>
      '<span class="deliv-chip" style="margin-right:4px;">' + esc(n) + '</span>'
    ).join('') || '<span style="color:var(--muted); font-size:11px;">None</span>';

    drawerBody.innerHTML =
      '<div class="d-section">' +
        '<div class="d-label">Task Brief</div>' +
        '<div class="d-card">' + esc(node.task || 'No task summary provided.') + '</div>' +
      '</div>' +

      '<div class="d-section">' +
        '<div class="d-label">Session Metadata</div>' +
        '<div class="d-card">' +
          '<div class="d-row"><span class="d-key">Status</span><span class="d-val">' + esc(node.status) + (node.merged ? ' (Merged)' : '') + '</span></div>' +
          '<div class="d-row"><span class="d-key">Branch</span><span class="d-val mono">' + esc(node.branch || 'agent/' + node.id) + '</span></div>' +
          (node.model ? '<div class="d-row"><span class="d-key">Model</span><span class="d-val mono">' + esc(node.model) + '</span></div>' : '') +
          '<div class="d-row"><span class="d-key">Stage</span><span class="d-val">Stage ' + (node.layer + 1) + '</span></div>' +
          (node.spend > 0 ? '<div class="d-row"><span class="d-key">Cost</span><span class="d-val mono">$' + node.spend.toFixed(3) + '</span></div>' : '') +
        '</div>' +
      '</div>' +

      '<div class="d-section">' +
        '<div class="d-label">Deliverables Checklist</div>' +
        '<div class="d-card">' + delivItems + '</div>' +
      '</div>' +

      '<div class="d-section">' +
        '<div class="d-label">Contract &amp; Interfaces</div>' +
        '<div class="d-card">' +
          '<div style="font-weight:600; font-size:10.5px; margin-bottom:4px; color:var(--fg);">Provides Symbols:</div>' +
          providesItems +
          '<div style="font-weight:600; font-size:10.5px; margin:8px 0 4px; color:var(--fg);">Requires:</div>' +
          needsItems +
        '</div>' +
      '</div>' +

      '<div class="d-section">' +
        '<div class="d-label">Quick Actions</div>' +
        '<div class="d-actions">' +
          '<button class="d-btn primary" data-act="openTerminal" data-id="' + esc(node.id) + '">&gt;_ Open Terminal</button>' +
          '<button class="d-btn" data-act="openTranscript" data-id="' + esc(node.id) + '">📄 Transcript</button>' +
          '<button class="d-btn" data-act="verify" data-id="' + esc(node.id) + '">✓ Verify</button>' +
          '<button class="d-btn" data-act="merge" data-id="' + esc(node.id) + '">⑂ Merge to Main</button>' +
          '<button class="d-btn" data-act="focus" data-id="' + esc(node.id) + '">⊞ Focus Card</button>' +
          '<button class="d-btn danger" data-act="archive" data-id="' + esc(node.id) + '">Archive</button>' +
        '</div>' +
      '</div>';

    drawer.classList.add('open');
  }

  // Event Listeners
  document.addEventListener('click', e => {
    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      const act = actBtn.dataset.act;
      const id = actBtn.dataset.id;
      if (act === 'inspect') {
        state.selectedNodeId = id;
        render();
        return;
      }
      api.postMessage({ type: act, id: id });
      return;
    }

    const nodeG = e.target.closest('.node-g');
    if (nodeG) {
      const id = nodeG.dataset.id;
      state.selectedNodeId = (state.selectedNodeId === id) ? null : id;
      render();
      return;
    }

    const gitRow = e.target.closest('.git-row');
    if (gitRow && !e.target.closest('button')) {
      const id = gitRow.dataset.id;
      state.selectedNodeId = (state.selectedNodeId === id) ? null : id;
      render();
      return;
    }

    const modeBtn = e.target.closest('[data-view]');
    if (modeBtn) {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      modeBtn.classList.add('active');
      const view = modeBtn.dataset.view;
      state.viewMode = view;
      const wPane = document.getElementById('workflow-pane');
      const gPane = document.getElementById('git-tree-pane');
      if (view === 'split') {
        wPane.style.display = 'flex';
        gPane.style.display = 'flex';
      } else if (view === 'workflow') {
        wPane.style.display = 'flex';
        gPane.style.display = 'none';
      } else if (view === 'tree') {
        wPane.style.display = 'none';
        gPane.style.display = 'flex';
      }
      return;
    }

    const zoomBtn = e.target.closest('[data-zoom]');
    if (zoomBtn) {
      const z = zoomBtn.dataset.zoom;
      if (z === 'in') { state.zoom = Math.min(2.5, state.zoom * 1.2); state.fitWidth = false; }
      else if (z === 'out') { state.zoom = Math.max(0.4, state.zoom / 1.2); state.fitWidth = false; }
      else if (z === 'fit') { state.zoom = 1; state.fitWidth = true; }
      renderWorkflow();
      return;
    }
  });

  drawerClose.addEventListener('click', () => {
    state.selectedNodeId = null;
    drawer.classList.remove('open');
    renderWorkflow();
    renderGitTree();
  });

  searchInput.addEventListener('input', e => {
    state.filter = e.target.value;
    renderWorkflow();
    renderGitTree();
  });

  api.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
