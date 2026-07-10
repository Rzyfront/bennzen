import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { AgentKind, AgentAdapter, CreateSessionOpts, Delta, PermMode } from './types';
import { resolveClaudeBin } from './claude-bin';
import { proxyEnv, type ClaudeProxy } from './claude-proxy-env';

interface ProxyState {
  cwd: string;
  mode: PermMode;
  claudeSessionId?: string;
  abort?: AbortController;
}

/** Mapea el modo de permiso al esquema del Agent SDK (sin prompts interactivos). */
function permOptions(mode: PermMode): Partial<Options> {
  switch (mode) {
    case 'yolo':
      return { permissionMode: 'bypassPermissions' };
    case 'safe-auto':
      // Auto-acepta ediciones; bloquea Bash para no colgarse pidiendo aprobación.
      return { permissionMode: 'acceptEdits', disallowedTools: ['Bash'] };
    case 'readonly':
      return { permissionMode: 'plan' };
  }
}

/**
 * Adaptador para los proxies de Claude Code (`mini` → MiniMax, `ollima` → Ollama).
 *
 * No son binarios separados: son el mismo `claude` con variables de entorno que
 * repuntan el endpoint, el token y el mapeo de modelos. Por eso se spawnea el
 * `claude` real (vía `pathToClaudeCodeExecutable`) y se inyecta el env del proxy
 * con `Options.env` (que REEMPLAZA el env del subprocess, de ahí el spread de
 * `process.env`). Sin wrappers de shell: el SDK habla un protocolo por stdio y
 * un `zsh -ic` lo contaminaría con el banner del shell.
 *
 * No hay "crear sesión" explícito: el `session_id` nace en el primer `query()`
 * y se reutiliza con `resume` en los siguientes turnos.
 */
export class ClaudeProxyAdapter implements AgentAdapter {
  readonly kind: AgentKind;
  private proxy: ClaudeProxy;
  private state = new Map<string, ProxyState>();
  private counter = 0;

  constructor(proxy: ClaudeProxy) {
    this.proxy = proxy;
    this.kind = proxy;
  }

  async createSession(opts: CreateSessionOpts): Promise<{ sessionId: string }> {
    const handle = `${this.proxy}-${++this.counter}`;
    this.state.set(handle, { cwd: opts.cwd, mode: opts.mode });
    return { sessionId: handle };
  }

  async *send(handle: string, text: string): AsyncIterable<Delta> {
    const st = this.state.get(handle);
    if (!st) {
      yield { type: 'error', message: `Sesión ${this.proxy} inexistente` };
      yield { type: 'done' };
      return;
    }

    // El env del proxy puede fallar (p.ej. mini sin MINI_AUTH_TOKEN en .env).
    const envResult = proxyEnv(this.proxy);
    if ('error' in envResult) {
      yield { type: 'error', message: envResult.error };
      yield { type: 'done' };
      return;
    }

    const bin = resolveClaudeBin();
    const abort = new AbortController();
    st.abort = abort;
    const options: Options = {
      cwd: st.cwd,
      abortController: abort,
      // El SDK reemplaza el env del subprocess por completo → spread process.env.
      env: { ...process.env, ...envResult.env },
      ...permOptions(st.mode),
      ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
      ...(st.claudeSessionId ? { resume: st.claudeSessionId } : {}),
    };

    try {
      for await (const msg of query({ prompt: text, options })) {
        const sid = (msg as { session_id?: string }).session_id;
        if (sid) st.claudeSessionId = sid;

        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) yield { type: 'text', text: block.text };
            else if (block.type === 'tool_use') yield { type: 'tool', name: block.name };
          }
        } else if (msg.type === 'result') {
          break;
        }
      }
    } catch (e) {
      // Aborto intencional (cierre de sesión) → no es un error que reportar.
      if (!abort.signal.aborted) {
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      }
    } finally {
      if (st.abort === abort) st.abort = undefined;
    }
    yield { type: 'done' };
  }

  async close(handle: string): Promise<void> {
    this.state.get(handle)?.abort?.abort();
    this.state.delete(handle);
  }

  /** Aborta cualquier query en vuelo al apagar el orquestador. */
  async shutdown(): Promise<void> {
    for (const st of this.state.values()) st.abort?.abort();
    this.state.clear();
  }
}