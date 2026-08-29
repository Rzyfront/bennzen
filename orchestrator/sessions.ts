import type { AgentAdapter } from './adapters/types';
import type { AgentKind, PermMode, SessionInfo, TranscriptEntry } from '../shared/protocol';
import { MockAdapter } from './adapters/mock';
import { OpenCodeAdapter } from './adapters/opencode';
import { ClaudeAdapter } from './adapters/claude';
import { CodexAdapter } from './adapters/codex';
import { ClaudeProxyAdapter } from './adapters/claude-proxy';
import { AgyAdapter } from './adapters/agy';
import { getRouter } from './routers';

/** Una sección activa = una sesión de agente con su contexto e historial. */
export interface Section {
  sectionId: string;
  agent: AgentKind;
  mode: PermMode;
  cwd: string;
  adapter: AgentAdapter;
  agentSessionId: string;
  ready: boolean;
  transcript: TranscriptEntry[];
}

/**
 * Instancia perezosa de adaptadores: uno por tipo, reutilizado entre secciones.
 * (OpenCode mantiene un solo `opencode serve`; el mock no tiene estado global.)
 */
class AdapterPool {
  private pool = new Map<AgentKind, AgentAdapter>();

  get(kind: AgentKind): AgentAdapter {
    let a = this.pool.get(kind);
    if (!a) {
      a = this.build(kind);
      this.pool.set(kind, a);
    }
    return a;
  }

  private build(kind: AgentKind): AgentAdapter {
    switch (kind) {
      case 'mock':
        return new MockAdapter();
      case 'opencode':
        return new OpenCodeAdapter();
      case 'claude':
        return new ClaudeAdapter();
      case 'codex':
        return new CodexAdapter();
      case 'mini':
        return new ClaudeProxyAdapter('mini');
      case 'qwen':
        return new ClaudeProxyAdapter('qwen');
      case 'agy':
        return new AgyAdapter();
      default: {
        const router = getRouter(kind);
        if (router) {
          return new ClaudeProxyAdapter(router);
        }
        throw new Error(`Agente desconocido: ${String(kind)}`);
      }
    }
  }

  all(): AgentAdapter[] {
    return [...this.pool.values()];
  }
}

/** Registro de secciones: sectionId (del cliente) → estado de la sesión. */
export class SessionRegistry {
  private sections = new Map<string, Section>();
  private pool = new AdapterPool();

  async create(
    sectionId: string,
    agent: AgentKind,
    mode: PermMode,
    cwd: string,
  ): Promise<Section> {
    const adapter = this.pool.get(agent);
    const { sessionId } = await adapter.createSession({ cwd, mode });
    const section: Section = {
      sectionId,
      agent,
      mode,
      cwd,
      adapter,
      agentSessionId: sessionId,
      ready: true,
      transcript: [],
    };
    this.sections.set(sectionId, section);
    return section;
  }

  get(sectionId: string): Section | undefined {
    return this.sections.get(sectionId);
  }

  /** Estado completo de todas las sesiones (para el snapshot al conectar). */
  list(): SessionInfo[] {
    return [...this.sections.values()].map((s) => ({
      sectionId: s.sectionId,
      agent: s.agent,
      mode: s.mode,
      cwd: s.cwd,
      ready: s.ready,
      kind: 'rpc' as const,
      transcript: s.transcript,
    }));
  }

  async close(sectionId: string): Promise<void> {
    const s = this.sections.get(sectionId);
    if (!s) return;
    await s.adapter.close(s.agentSessionId);
    this.sections.delete(sectionId);
  }

  /** Teardown global: cierra cada sección y apaga los adaptadores. */
  async shutdownAll(): Promise<void> {
    for (const s of this.sections.values()) {
      await s.adapter.close(s.agentSessionId).catch(() => {});
    }
    this.sections.clear();
    for (const adapter of this.pool.all()) {
      await adapter.shutdown?.().catch(() => {});
    }
  }
}
