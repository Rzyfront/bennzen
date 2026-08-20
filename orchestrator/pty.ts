// Modo PTY: lanza la TUI real del CLI bajo un pseudo-terminal (un solo proceso),
// derivada por ambos lados:
//   - salida cruda (ANSI) → la PWA la pinta en xterm tal cual.
//   - prosa extraída (TerminalExtractor) → la PWA la manda a TTS.
//   - entrada cruda (teclado o voz dictada) → se escribe directo en el PTY.
//
// Contrasta con el modo rpc (sessions.ts), que habla la cara programática del
// CLI con texto limpio. Aquí no hay parsing de protocolo: es el terminal real.

import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { AgentKind, PermMode, SessionInfo } from '../shared/protocol';
import { TerminalExtractor } from './tts-extractor';
import { proxyEnv } from './adapters/claude-proxy-env';

/** Tope de scrollback retenido para reproducir en xterm al reconectar. */
const SCROLLBACK_MAX = 200_000;

export interface PtyHooks {
  /** Salida cruda del PTY → el server emite {t:'term-data'}. */
  onData: (sectionId: string, data: string) => void;
  /** Prosa extraída → el server emite {t:'speak'}. */
  onSpeak: (sectionId: string, text: string) => void;
}

interface PtySession {
  proc: IPty;
  agent: AgentKind;
  mode: PermMode;
  cwd: string;
  cols: number;
  rows: number;
  scrollback: string;
  extractor: TerminalExtractor;
}

/** Resuelve binario + args del CLI según agente y modo de permiso. */
function resolveCommand(
  agent: AgentKind,
  mode: PermMode,
): { file: string; args: string[]; env?: Record<string, string> } {
  switch (agent) {
    case 'mock':
      // Shell interactivo: smoke test del flujo PTY sin depender de un CLI real.
      return { file: 'bash', args: [] };
    case 'claude':
      return { file: 'claude', args: mode === 'yolo' ? ['--dangerously-skip-permissions'] : [] };
    case 'mini':
    case 'qwen': {
      // mini/qwen son `claude` + env (proxies de Claude Code: mismo binario,
      // distinto endpoint/token/modelos). node-pty hace execvp directo, así que
      // resolvemos `claude` (binario real en PATH) y mergeamos el env del proxy
      // sobre process.env. Sin wrappers de shell: un `zsh -ic` contaminaría el
      // terminal y, en modo rpc, rompería el protocolo stdio del SDK.
      const r = proxyEnv(agent);
      if ('error' in r) {
        // Falta un token obligatorio (p.ej. mini sin MINI_AUTH_TOKEN en .env):
        // nada útil que ejecutar. Lo imprimimos en el terminal y dejamos que el
        // proceso termine, para que se vea la causa en vez de un error críptico.
        return { file: 'echo', args: [`⚠️ ${r.error}`] };
      }
      return {
        file: 'claude',
        args: mode === 'yolo' ? ['--dangerously-skip-permissions'] : [],
        env: r.env,
      };
    }
    case 'codex':
      switch (mode) {
        case 'yolo':
          return { file: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox'] };
        case 'safe-auto':
          return { file: 'codex', args: ['--sandbox', 'workspace-write'] };
        case 'readonly':
          return { file: 'codex', args: ['--sandbox', 'read-only'] };
      }
    // eslint-disable-next-line no-fallthrough
    case 'opencode':
      // La TUI pregunta permisos interactivamente, lo cual es válido en PTY.
      return { file: 'opencode', args: [] };
    default: {
      const _exhaustive: never = agent;
      throw new Error(`Agente desconocido: ${String(_exhaustive)}`);
    }
  }
}

/** Registro de PTYs activos: sectionId → proceso + extractor + scrollback. */
export class PtyRegistry {
  private sessions = new Map<string, PtySession>();

  constructor(private hooks: PtyHooks) {}

  create(
    sectionId: string,
    agent: AgentKind,
    mode: PermMode,
    cwd: string,
    cols = 80,
    rows = 30,
  ): void {
    const { file, args, env: envOverride } = resolveCommand(agent, mode);
    const proc = pty.spawn(file, args, {
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env: { ...process.env, ...(envOverride ?? {}) },
    });

    const extractor = new TerminalExtractor(cols, rows, agent, (text) =>
      this.hooks.onSpeak(sectionId, text),
    );

    const session: PtySession = {
      proc,
      agent,
      mode,
      cwd,
      cols,
      rows,
      scrollback: '',
      extractor,
    };
    this.sessions.set(sectionId, session);

    proc.onData((d) => {
      session.scrollback += d;
      if (session.scrollback.length > SCROLLBACK_MAX) {
        session.scrollback = session.scrollback.slice(-SCROLLBACK_MAX);
      }
      this.hooks.onData(sectionId, d);
      session.extractor.write(d);
    });

    proc.onExit(() => {
      // El proceso murió (exit, crash, kill). Avisamos a la UI y lo retiramos
      // del mapa; el server hará broadcastSnapshot y list() ya no lo incluirá.
      const s = this.sessions.get(sectionId);
      if (!s) return; // ya cerrado vía close() → no doble-notificar.
      this.hooks.onData(sectionId, '\r\n[proceso terminado]\r\n');
      s.extractor.dispose();
      this.sessions.delete(sectionId);
    });
  }

  write(sectionId: string, data: string): void {
    const s = this.sessions.get(sectionId);
    if (!s) return;
    s.proc.write(data);
    s.extractor.noteInput(data);
  }

  resize(sectionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sectionId);
    if (!s) return;
    s.cols = cols;
    s.rows = rows;
    s.proc.resize(cols, rows);
    s.extractor.resize(cols, rows);
  }

  /** Ajusta el modo de captura total del extractor (limpieza ON en el cliente). */
  setCaptureAll(sectionId: string, full: boolean): void {
    this.sessions.get(sectionId)?.extractor.setCaptureAll(full);
  }

  has(sectionId: string): boolean {
    return this.sessions.has(sectionId);
  }

  async close(sectionId: string): Promise<void> {
    const s = this.sessions.get(sectionId);
    if (!s) return;
    // Borramos primero para que onExit no vuelva a notificar/disponer.
    this.sessions.delete(sectionId);
    s.extractor.dispose();
    try {
      s.proc.kill('SIGTERM');
    } catch {
      // El proceso ya pudo haber salido; ignorar.
    }
  }

  list(): SessionInfo[] {
    return [...this.sessions.entries()].map(([sectionId, s]) => ({
      sectionId,
      agent: s.agent,
      mode: s.mode,
      cwd: s.cwd,
      ready: true,
      kind: 'pty' as const,
      transcript: [],
      scrollback: s.scrollback,
      cols: s.cols,
      rows: s.rows,
    }));
  }

  async shutdownAll(): Promise<void> {
    for (const [sectionId] of this.sessions) {
      await this.close(sectionId);
    }
  }
}
