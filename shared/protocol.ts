// Tipos compartidos entre el orquestador (Node) y la PWA (navegador).
// Única fuente de verdad del contrato WebSocket y de los enums transversales.

export type PermMode = 'yolo' | 'safe-auto' | 'readonly';

export type BuiltinAgentKind = 'mock' | 'opencode' | 'claude' | 'codex' | 'mini' | 'qwen' | 'agy';
export type AgentKind = BuiltinAgentKind | `router:${string}` | (string & {});

/** Configuración de un Router personalizado de Claude Code. */
export interface RouterConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
  autoCompactWindow?: string;
  createdAt?: number;
}

export interface RouterTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * Cómo se ejecuta una sección:
 *  - 'rpc': cara programática del CLI (SDK / exec / serve) → texto limpio + voz.
 *  - 'pty': TUI real bajo un PTY (un solo proceso) → terminal interactivo + voz.
 */
export type SectionKind = 'rpc' | 'pty';

/** Fragmento de salida de un agente, en streaming (modo rpc). */
export type Delta =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** Entrada persistida del historial de una sección (modo rpc). */
export interface TranscriptEntry {
  role: 'user' | 'agent' | 'tool' | 'error' | 'system';
  text: string;
}

/** Estado completo de una sección, para restaurar la app tras un refresh. */
export interface SessionInfo {
  sectionId: string;
  agent: AgentKind;
  mode: PermMode;
  cwd: string;
  ready: boolean;
  kind: SectionKind;
  /** Historial (modo rpc). Vacío en pty. */
  transcript: TranscriptEntry[];
  /** Buffer crudo (ANSI) para reproducir en xterm al reconectar (modo pty). */
  scrollback?: string;
  /** Geometría del terminal (modo pty). */
  cols?: number;
  rows?: number;
}

/** Mensajes PWA → orquestador. El cliente genera el `sectionId`. */
export type ClientMsg =
  | {
      t: 'create';
      sectionId: string;
      agent: AgentKind;
      mode: PermMode;
      cwd: string;
      kind: SectionKind;
      cols?: number; // pty
      rows?: number; // pty
    }
  // modo rpc: un turno de conversación
  | { t: 'say'; sectionId: string; text: string }
  // modo pty: teclas crudas del xterm (o texto dictado por voz + '\r')
  | { t: 'term-input'; sectionId: string; data: string }
  // modo pty: redimensionar el PTY cuando cambia el xterm
  | { t: 'term-resize'; sectionId: string; cols: number; rows: number }
  // adjuntar imagen: el orquestador la guarda en un archivo temporal y devuelve su
  // ruta (image-saved). Luego el cliente inyecta esa ruta en el prompt (say/term-input),
  // que es como los CLIs con visión (Claude Code) reciben imágenes. `data` = base64
  // sin el prefijo `data:...;base64,`. `id` lo genera el cliente para casar la respuesta.
  | { t: 'upload-image'; sectionId: string; id: string; name: string; mime: string; data: string }
  // modo pty: activa/desactiva la CAPTURA TOTAL de la prosa para el proxy de
  // limpieza. Sigue al toggle `ttsClean` del cliente: con full=true el extractor
  // relaja sus filtros y captura tablas, código, comandos y resultados de
  // herramientas (el agente de limpieza los traduce a lenguaje natural); con
  // full=false vuelve al filtrado normal (solo prosa del asistente).
  | { t: 'tts-capture'; sectionId: string; full: boolean }
  | { t: 'close'; sectionId: string };

/** Mensajes orquestador → PWA. */
export type ServerMsg =
  // Enviado al conectar (y tras crear/cerrar): el estado COMPLETO de sesiones.
  | { t: 'snapshot'; sessions: SessionInfo[] }
  | { t: 'created'; sectionId: string; agentSessionId: string; agent: AgentKind; kind: SectionKind }
  // modo rpc: fragmento de respuesta en streaming
  | { t: 'delta'; sectionId: string; delta: Delta }
  // modo pty: salida cruda del PTY → se escribe tal cual en xterm
  | { t: 'term-data'; sectionId: string; data: string }
  // texto en prosa del agente (extraído) → la PWA lo manda a TTS
  | { t: 'speak'; sectionId: string; text: string }
  // imagen adjunta ya guardada en disco: `path` es la ruta absoluta a inyectar en
  // el prompt; `id` casa con el upload-image que la originó.
  | { t: 'image-saved'; sectionId: string; id: string; path: string; name: string }
  | { t: 'error'; sectionId?: string; message: string };

/** Configuración de un Proyecto / Directorio guardado. */
export interface ProjectConfig {
  id: string; // slug único
  name: string; // Nombre amigable (ej. "Bennzen Core", "Frontend Web")
  path: string; // Ruta absoluta del directorio
  tag?: string; // Etiqueta opcional (ej. "Fullstack", "Rust", "Python")
  createdAt?: number;
}
