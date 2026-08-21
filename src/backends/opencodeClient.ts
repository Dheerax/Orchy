/**
 * Thin client for the `opencode serve` HTTP API.
 *
 * One server process, many sessions, one multiplexed SSE stream. Creating a
 * session does not spawn a CLI process or re-trigger authentication — which is
 * what makes a grid of N agents cheap.
 */

export interface OpenCodeEvent {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenCodeMessagePart {
  type: string;
  text?: string;
  name?: string;
  [key: string]: unknown;
}

export interface OpenCodeMessage {
  id: string;
  type: string;
  agent?: string;
  model?: { id?: string };
  content?: OpenCodeMessagePart[];
  tokens?: { input?: number; output?: number };
  cost?: number;
  [key: string]: unknown;
}

export interface OpenCodeSession {
  id: string;
  [key: string]: unknown;
}

export class OpenCodeClient {
  private listeners = new Set<(evt: OpenCodeEvent) => void>();
  private controller: AbortController | undefined;
  private streaming = false;
  private closed = false;

  constructor(readonly baseUrl: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`opencode ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl + '/api/health');
      return res.ok;
    } catch {
      return false;
    }
  }

  async createSession(opts: {
    directory: string;
    agent?: string;
    model?: { id: string; providerID: string };
  }): Promise<OpenCodeSession> {
    const body: Record<string, unknown> = { location: { directory: opts.directory } };
    if (opts.agent) {
      body.agent = opts.agent;
    }
    if (opts.model) {
      body.model = opts.model;
    }
    const wrapped = await this.req<{ data: OpenCodeSession }>('POST', '/api/session', body);
    return wrapped.data;
  }

  /** Change the model a session uses from its next turn onward. */
  async updateSession(
    sessionId: string,
    updates: { model?: { id: string; providerID: string }; agent?: string }
  ): Promise<void> {
    await this.req('PATCH', `/api/session/${sessionId}`, updates);
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.req('POST', `/api/session/${sessionId}/prompt`, { prompt: { text } });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.req('POST', `/api/session/${sessionId}/interrupt`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.req('DELETE', `/session/${sessionId}`);
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    const wrapped = await this.req<{ data: OpenCodeSession[] }>('GET', '/api/session');
    return wrapped.data;
  }

  /** Full transcript for a session. Newest first, as the server returns it. */
  async messages(sessionId: string): Promise<OpenCodeMessage[]> {
    const wrapped = await this.req<{ data: OpenCodeMessage[] }>(
      'GET',
      `/api/session/${sessionId}/message`
    );
    return wrapped.data ?? [];
  }

  async pendingPermissions(sessionId: string): Promise<unknown[]> {
    const wrapped = await this.req<{ data: unknown[] }>(
      'GET',
      `/api/session/${sessionId}/permission`
    );
    return wrapped.data;
  }

  async replyPermission(
    sessionId: string,
    requestId: string,
    reply: 'once' | 'always' | 'reject'
  ): Promise<void> {
    await this.req('POST', `/api/session/${sessionId}/permission/${requestId}/reply`, { reply });
  }

  onEvent(listener: (evt: OpenCodeEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.streaming) {
      void this.connect();
    }
    return () => this.listeners.delete(listener);
  }

  private async connect(): Promise<void> {
    this.streaming = true;
    this.controller = new AbortController();
    try {
      const res = await fetch(this.baseUrl + '/api/event', {
        signal: this.controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
      if (!res.ok || !res.body) {
        throw new Error(`event stream failed: ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          if (!data) {
            continue;
          }
          try {
            const evt = JSON.parse(data) as OpenCodeEvent;
            for (const listener of this.listeners) {
              listener(evt);
            }
          } catch {
            // Malformed frame — the stream is still usable, so keep reading.
          }
        }
      }
    } catch {
      // Stream dropped. Reconnect below if anyone still cares.
    } finally {
      this.streaming = false;
      if (!this.closed && this.listeners.size > 0) {
        setTimeout(() => void this.connect(), 1000);
      }
    }
  }

  close(): void {
    this.closed = true;
    this.controller?.abort();
    this.listeners.clear();
  }
}
