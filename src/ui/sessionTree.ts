import * as vscode from 'vscode';
import { SessionRegistry } from '../core/sessionRegistry';
import { NEEDS_ATTENTION, OrchyEvent, Session, SessionStatus } from '../core/types';

const STATUS_ICON: Record<SessionStatus, { icon: string; color?: string }> = {
  spawning: { icon: 'loading~spin' },
  queued: { icon: 'watch' },
  running: { icon: 'play-circle', color: 'charts.blue' },
  waiting_input: { icon: 'question', color: 'charts.yellow' },
  idle_unverified: { icon: 'warning', color: 'charts.orange' },
  complete: { icon: 'pass-filled', color: 'charts.green' },
  failed: { icon: 'error', color: 'charts.red' },
  detached: { icon: 'circle-outline' },
  archived: { icon: 'archive' },
};

const GROUP_ORDER = ['Needs attention', 'Working', 'Done', 'Archived'] as const;
type Group = (typeof GROUP_ORDER)[number];

class GroupNode {
  constructor(readonly label: Group, readonly sessions: Session[]) {}
}

/** Collapsed by default: history is for looking back, not for watching. */
class HistoryNode {
  readonly label = 'History';
}

class EventNode {
  constructor(readonly event: OrchyEvent) {}
}

type Node = GroupNode | HistoryNode | EventNode | Session;

/**
 * Sidebar list of sessions, grouped by what the user has to do about them.
 *
 * This is the surface that actually solves the real bottleneck. Past three or
 * four agents the problem stops being merge conflicts and becomes noticing
 * which one is blocked — and unlike the graph panel, this is on screen even
 * when the user is looking at their own code.
 */
export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private view: vscode.TreeView<Node> | undefined;

  constructor(private readonly registry: SessionRegistry) {
    this.registry.on('changed', () => this.refresh());
  }

  register(): vscode.Disposable {
    this.view = vscode.window.createTreeView('orchy.sessions', {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    this.refresh();
    return this.view;
  }

  private refresh(): void {
    this.changed.fire(undefined);
    if (!this.view) {
      return;
    }
    const blocked = this.registry.needingAttention().length;
    // A native badge, so the count is visible even when this view is collapsed
    // or the graph tab isn't open.
    this.view.badge =
      blocked > 0
        ? { value: blocked, tooltip: `${blocked} session(s) need attention` }
        : undefined;
  }

  getChildren(node?: Node): Node[] {
    if (node instanceof GroupNode) {
      return node.sessions;
    }
    if (node instanceof HistoryNode) {
      return this.registry.history(60).map((e) => new EventNode(e));
    }
    if (node) {
      return [];
    }

    const all = this.registry.all();
    if (all.length === 0) {
      return [];
    }
    const groups: Record<Group, Session[]> = {
      'Needs attention': [],
      Working: [],
      Done: [],
      Archived: [],
    };
    for (const session of all) {
      if (NEEDS_ATTENTION.has(session.status)) {
        groups['Needs attention'].push(session);
      } else if (session.status === 'archived') {
        groups.Archived.push(session);
      } else if (session.status === 'complete') {
        groups.Done.push(session);
      } else {
        groups.Working.push(session);
      }
    }
    return [
      ...GROUP_ORDER.filter((g) => groups[g].length > 0).map((g) => new GroupNode(g, groups[g])),
      new HistoryNode(),
    ];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node instanceof HistoryNode) {
      const item = new vscode.TreeItem('History', vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('git-merge');
      item.contextValue = 'orchyHistory';
      item.tooltip = 'What agents produced and when it merged';
      return item;
    }

    if (node instanceof EventNode) {
      return this.eventItem(node.event);
    }

    if (node instanceof GroupNode) {
      const item = new vscode.TreeItem(
        `${node.label} (${node.sessions.length})`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.contextValue = 'orchyGroup';
      return item;
    }

    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    const { icon, color } = STATUS_ICON[node.status];
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.description = this.describe(node);
    item.tooltip = this.tooltip(node);
    item.contextValue = `orchySession.${node.status}`;
    item.command = {
      command: 'orchy.focusSession',
      title: 'Focus session',
      arguments: [node.id],
    };
    return item;
  }

  /** One line of pipeline history: what happened, to whom, and when. */
  private eventItem(event: OrchyEvent): vscode.TreeItem {
    const when = new Date(event.t);
    const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let label: string;
    let icon: string;
    let color: string | undefined;
    switch (event.type) {
      case 'merged':
        label = `${event.session} → ${event.into}`;
        icon = 'git-merge';
        color = 'charts.purple';
        break;
      case 'spawned':
        label = `${event.session} spawned`;
        icon = 'rocket';
        break;
      case 'archived':
        label = `${event.session} archived`;
        icon = 'archive';
        break;
      case 'purged':
        label = `${event.session} deleted`;
        icon = 'trash';
        break;
      case 'status':
        label = `${event.session} ${event.status}`;
        icon = event.status === 'complete' ? 'pass-filled' : 'error';
        color = event.status === 'complete' ? 'charts.green' : 'charts.red';
        break;
      default:
        label = `${event.session} ${event.type}`;
        icon = 'circle-small';
    }

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = time;
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.tooltip = `${when.toLocaleString()}
${event.type}`;
    return item;
  }

  private describe(session: Session): string {
    if (session.status === 'idle_unverified') {
      const missing = session.deliverables.filter((d) => !d.verified).length;
      return missing > 0 ? `${missing} deliverable(s) missing` : 'unverified';
    }
    if (session.status === 'queued') {
      return `waiting on ${session.dependsOn.join(', ')}`;
    }
    if (session.status === 'failed') {
      return 'failed';
    }
    return session.status.replace('_', ' ');
  }

  private tooltip(session: Session): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${session.id}** · ${session.role}\n\n`);
    md.appendMarkdown(`${session.task}\n\n`);
    md.appendMarkdown(`Status: \`${session.status}\`\n\n`);
    if (session.worktree) {
      md.appendMarkdown(`Branch: \`${session.worktree.branch}\`\n\n`);
    }
    if (session.deliverables.length > 0) {
      md.appendMarkdown('Deliverables:\n');
      for (const d of session.deliverables) {
        md.appendMarkdown(`- ${d.verified ? '✓' : '✗'} \`${d.spec}\``);
        md.appendMarkdown(d.detail ? ` — ${d.detail}\n` : '\n');
      }
      md.appendMarkdown('\n');
    }
    if (session.budget.costEstimate > 0) {
      md.appendMarkdown(`Spend: ${session.budget.costEstimate.toFixed(3)}\n\n`);
    }
    if (session.lastError) {
      md.appendMarkdown(`\n**Error:** ${session.lastError}\n`);
    }
    return md;
  }
}
