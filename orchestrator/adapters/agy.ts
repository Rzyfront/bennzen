import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { AgentAdapter, CreateSessionOpts, Delta, PermMode } from './types';

interface AgyState {
  cwd: string;
  mode: PermMode;
  conversationId?: string;
  hasStreamedDelta?: boolean;
}

/** Flags de ejecución según el modo de permiso */
function modeArgs(mode: PermMode): string[] {
  switch (mode) {
    case 'yolo':
      return ['--dangerously-skip-permissions'];
    case 'safe-auto':
      return ['--mode', 'accept-edits'];
    case 'readonly':
      return ['--mode', 'plan'];
  }
}

/**
 * Adaptador Antigravity CLI (`agy`).
 * Ejecuta `agy -p <text> --output-format stream-json` en cada turno y parsea sus
 * eventos JSON por línea. Mantiene el hilo conversacional con `--conversation <id>`.
 */
export class AgyAdapter implements AgentAdapter {
  readonly kind = 'agy' as const;
  private state = new Map<string, AgyState>();
  private children = new Map<string, ChildProcess>();
  private counter = 0;

  async createSession(opts: CreateSessionOpts): Promise<{ sessionId: string }> {
    const handle = `agy-${++this.counter}`;
    this.state.set(handle, { cwd: opts.cwd, mode: opts.mode });
    return { sessionId: handle };
  }

  async *send(handle: string, text: string): AsyncIterable<Delta> {
    const st = this.state.get(handle);
    if (!st) {
      yield { type: 'error', message: 'Sesión agy inexistente' };
      yield { type: 'done' };
      return;
    }

    st.hasStreamedDelta = false;

    const common = ['-p', text, '--output-format', 'stream-json', ...modeArgs(st.mode)];
    const args = st.conversationId
      ? [...common, '--conversation', st.conversationId]
      : common;

    const child = spawn('agy', args, { cwd: st.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.set(handle, child);

    const queue: Delta[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const push = (d: Delta) => {
      queue.push(d);
      wake?.();
      wake = null;
    };

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.handleEvent(line, st, push);
      }
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });

    child.on('error', (e) => {
      push({ type: 'error', message: `No se pudo lanzar agy: ${e.message}` });
      finished = true;
      wake?.();
      wake = null;
    });

    child.on('close', (code, signal) => {
      this.children.delete(handle);
      if (code !== 0 && !signal) {
        push({ type: 'error', message: stderr.trim().slice(-500) || `agy salió con código ${code}` });
      }
      finished = true;
      wake?.();
      wake = null;
    });

    while (true) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (finished) break;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
    yield { type: 'done' };
  }

  private handleEvent(line: string, st: AgyState, push: (d: Delta) => void): void {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }

    if (ev.conversation_id) {
      st.conversationId = ev.conversation_id;
    }

    if (ev.event === 'init') {
      if (ev.init?.conversation_id) st.conversationId = ev.init.conversation_id;
    } else if (ev.event === 'step_update' && ev.step_update) {
      const su = ev.step_update;
      if (su.conversation_id) st.conversationId = su.conversation_id;

      if (su.step_type === 'agent_response') {
        if (su.text_delta) {
          st.hasStreamedDelta = true;
          push({ type: 'text', text: su.text_delta });
        } else if (su.state === 'DONE' && su.text) {
          if (!st.hasStreamedDelta) {
            push({ type: 'text', text: su.text });
          }
          st.hasStreamedDelta = false;
        }
      } else if (su.step_type === 'tool') {
        if (su.state === 'ACTIVE') {
          const toolName = su.tool_name || su.tool_info?.name || 'tool';
          push({ type: 'tool', name: toolName });
        }
      } else if (su.step_type === 'error') {
        push({ type: 'error', message: su.message || 'Error en paso de ejecución' });
      }
    } else if (ev.event === 'result') {
      if (ev.result?.conversation_id) st.conversationId = ev.result.conversation_id;
      if (ev.result?.status === 'ERROR') {
        push({ type: 'error', message: ev.result.error || ev.result.response || 'Error de ejecución en agy' });
      } else if (!st.hasStreamedDelta && ev.result?.response) {
        push({ type: 'text', text: ev.result.response });
      }
    } else if (ev.event === 'error') {
      push({ type: 'error', message: ev.error || ev.message || 'Error en agy' });
    }
  }

  async close(handle: string): Promise<void> {
    this.children.get(handle)?.kill('SIGTERM');
    this.children.delete(handle);
    this.state.delete(handle);
  }

  async shutdown(): Promise<void> {
    for (const child of this.children.values()) child.kill('SIGTERM');
    this.children.clear();
    this.state.clear();
  }
}
