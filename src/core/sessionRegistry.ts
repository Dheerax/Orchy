import { EventEmitter } from 'events';
import { EventLog } from './eventLog';
import {
  DraftEvent,
  NEEDS_ATTENTION,
  OrchyEvent,
  Session,
  SessionStatus,
} from './types';

/**
 * The projection of the event log into current session state.
 *
 * The registry holds no truth of its own: `rebuild()` replays the log and must
 * produce exactly the state the live instance had. That property is what lets
 * every surface be disposable — a closed terminal, a destroyed webview, or a
 * reloaded window costs nothing because nothing was stored there.
 */
export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, Session>();

  constructor(private readonly log: EventLog) {
    super();
    this.rebuild();
  }

  /** Replay the log from scratch. Idempotent. */
  rebuild(): void {
    this.sessions.clear();
    for (const event of this.log.readAll()) {
      this.project(event);
    }
    this.emit('changed');
  }

  /** Record an event and fold it into state. The only write path. */
  record(draft: DraftEvent): OrchyEvent {
    const event = this.log.append(draft);
    this.project(event);
    this.emit('changed');
    this.emit('event', event);
    return event;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * Bring replayed state in line with what this window can actually see.
   *
   * A new window owns no terminals and no backend handles, but the log may say
   * sessions are visible in grid slots and still running. Left uncorrected, dead
   * sessions hold slots hostage and new agents get pushed into empty columns
   * further right.
   */
  reconcileForFreshWindow(): void {
    for (const session of this.all()) {
      if (session.surface.visible) {
        this.record({ type: 'surface', session: session.id, visible: false });
      }
      if (session.status === 'running' || session.status === 'spawning') {
        this.record({ type: 'status', session: session.id, status: 'detached' });
      }
    }
  }

  /** Sessions a human needs to look at right now. Drives the sidebar badge. */
  needingAttention(): Session[] {
    return this.all().filter((s) => NEEDS_ATTENTION.has(s.status));
  }

  /** Live sessions currently occupying a visible grid slot. */
  visible(): Session[] {
    return this.all().filter((s) => s.surface.visible);
  }

  /**
   * A session may only reach `complete` when it declared deliverables and every
   * one of them verified. A backend reporting "done" is not evidence of done —
   * observed repeatedly: agents sit at idle for an hour having written nothing.
   */
  private resolveStatus(session: Session, requested: SessionStatus): SessionStatus {
    if (requested !== 'complete') {
      return requested;
    }
    const allVerified =
      session.deliverables.length > 0 && session.deliverables.every((d) => d.verified);
    return allVerified ? 'complete' : 'idle_unverified';
  }

  private project(event: OrchyEvent): void {
    if (event.type === 'spawned') {
      this.sessions.set(event.session, {
        id: event.session,
        name: event.name,
        role: event.role,
        task: event.task,
        status: (event.dependsOn ?? []).length > 0 ? 'queued' : 'spawning',
        backend: event.backend,
        worktree: event.worktree,
        dependsOn: event.dependsOn ?? [],
        surface: { visible: false },
        deliverables: event.deliverables,
        contract: event.contract,
        budget: { tokensUsed: 0, costEstimate: 0 },
        createdAt: event.t,
        lastEventAt: event.t,
      });
      return;
    }

    const session = this.sessions.get(event.session);
    if (!session) {
      // An event for a session we never saw spawned — possible after log
      // rotation drops the head. Ignore rather than fabricate a partial session.
      return;
    }
    session.lastEventAt = event.t;

    switch (event.type) {
      case 'status':
        session.status = this.resolveStatus(session, event.status);
        if (event.error) {
          session.lastError = event.error;
        }
        break;

      case 'deliverable': {
        const existing = session.deliverables.find((d) => d.spec === event.spec);
        if (existing) {
          existing.verified = event.verified;
          existing.checkedAt = event.t;
          existing.detail = event.detail;
        }
        // Re-resolve: verifying the last outstanding deliverable can promote a
        // session that was parked at idle_unverified.
        if (session.status === 'idle_unverified') {
          session.status = this.resolveStatus(session, 'complete');
        }
        break;
      }

      case 'budget':
        session.budget.tokensUsed = event.tokensUsed;
        session.budget.costEstimate = event.costEstimate;
        break;

      case 'surface':
        session.surface = {
          terminalId: event.terminalId,
          gridSlot: event.gridSlot,
          visible: event.visible,
        };
        break;

      case 'attached':
        // Persisted so a reloaded window can reconnect to a session that is
        // still running on the backend, instead of stranding it forever.
        session.backend = { ...session.backend, handle: event.handle };
        break;

      case 'archived':
        session.status = 'archived';
        session.surface = { visible: false };
        break;

      case 'purged':
        // Hard delete. The event stays in the log as history, but the session
        // stops existing as far as every surface is concerned.
        this.sessions.delete(event.session);
        break;

      case 'tool':
      case 'message':
        // Timeline detail only — consumed by the graph, not by session state.
        break;
    }
  }
}
