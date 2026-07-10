import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { AgentAdapter, CreateSessionOpts, Delta, PermMode } from './types';

interface CodexState {
  cwd: string;
  mode: PermMode;
  threadId?: string;
}

/** Flags de sandbox/aprobación por modo (van antes del prompt). */
function sandboxArgs(mode: PermMode): string[] {
  switch (mode) {
    case 'yolo':
      return ['--dangerously-bypass-approvals-and-sandbox'];
    case 'safe-auto':
      return ['--sandbox', 'workspace-write'];
    case 'readonly':
      return ['--sandbox', 'read-only'];
  }
}

// Tipos de item que tratamos como "herramienta" (para narrar actividad).
const TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

/**
 * Adaptador Codex — spawnea el CLI `codex exec` por turno y parsea sus eventos
 * JSONL (`--json`). El `thread_id` del primer turno se reutiliza con
 * `codex exec resume <id>` en los siguientes. El modo se mapea al `--sandbox`.
 */
export class CodexAdapter implements AgentAdapter {
  readonly kind = 'codex' as const;
  private state = new Map<string, CodexState>();
  private children = new Map<string, ChildProcess>();
  private counter = 0;

  async createSession(opts: CreateSessionOpts): Promise<{ sessionId: string }> {
    const handle = `codex-${++this.counter}`;
    this.state.set(handle, { cwd: opts.cwd, mode: opts.mode });
    return { sessionId: handle };
  }

  async *send(handle: string, text: string): AsyncIterable<Delta> {
    const st = this.state.get(handle);
    if (!st) {
      yield { type: 'error', message: 'Sesión Codex inexistente' };
      yield { type: 'done' };
      return;
    }

    const common = ['--json', '--skip-git-repo-check', '-C', st.cwd, ...sandboxArgs(st.mode)];
    const args = st.threadId
      ? ['exec', 'resume', ...common, st.threadId, text]
      : ['exec', ...common, text];

    const child = spawn('codex', args, { cwd: st.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.set(handle, child);

    // Puente evento → async iterator.
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
      push({ type: 'error', message: `No se pudo lanzar codex: ${e.message}` });
      finished = true;
      wake?.();
      wake = null;
    });
    child.on('close', (code, signal) => {
      this.children.delete(handle);
      // code !== 0 sin señal = error real; con señal = cierre intencional (close/shutdown).
      if (code !== 0 && !signal) {
        push({ type: 'error', message: stderr.trim().slice(-500) || `codex salió con código ${code}` });
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

  private handleEvent(line: string, st: CodexState, push: (d: Delta) => void): void {
    let ev: { type?: string; thread_id?: string; item?: { type?: string; text?: string; message?: string } };
    try {
      ev = JSON.parse(line);
    } catch {
      return; // línea parcial o no-JSON
    }
    if (ev.type === 'thread.started' && ev.thread_id) {
      st.threadId = ev.thread_id;
    } else if (ev.type === 'item.completed' && ev.item) {
      const item = ev.item;
      if (item.type === 'agent_message' && item.text) push({ type: 'text', text: item.text });
      else if (item.type === 'error' && item.message) push({ type: 'error', message: item.message });
      else if (item.type && TOOL_ITEMS.has(item.type)) push({ type: 'tool', name: item.type });
    } else if (ev.type === 'turn.failed') {
      push({ type: 'error', message: 'Codex: turno fallido' });
    }
  }

  async close(handle: string): Promise<void> {
    this.children.get(handle)?.kill('SIGTERM');
    this.children.delete(handle);
    this.state.delete(handle);
  }

  /** Mata cualquier proceso codex en vuelo al apagar el orquestador. */
  async shutdown(): Promise<void> {
    for (const child of this.children.values()) child.kill('SIGTERM');
    this.children.clear();
    this.state.clear();
  }
}
