import type { PermMode, AgentKind, Delta, RouterConfig, RouterTestResult } from '../../shared/protocol';

export type { PermMode, AgentKind, Delta, RouterConfig, RouterTestResult };

export interface CreateSessionOpts {
  /** Directorio de trabajo donde el agente operará. */
  cwd: string;
  /** Modo de permiso → se traduce al flag nativo del CLI. */
  mode: PermMode;
}

/**
 * Contrato común para los 3 agentes. La PWA y el servidor solo hablan esto;
 * cambiar de agente = elegir qué implementación instanciar.
 */
export interface AgentAdapter {
  readonly kind: AgentKind;
  createSession(opts: CreateSessionOpts): Promise<{ sessionId: string }>;
  /** Envía un turno y devuelve los fragmentos de respuesta en streaming. */
  send(sessionId: string, text: string): AsyncIterable<Delta>;
  /** Cierra una sesión liberando sus recursos (procesos, sesión remota). */
  close(sessionId: string): Promise<void>;
  /** Teardown global del adaptador (al apagar el orquestador). Opcional. */
  shutdown?(): Promise<void>;
}
