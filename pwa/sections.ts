import type {
  ClientMsg,
  ServerMsg,
  AgentKind,
  PermMode,
  SectionKind,
  TranscriptEntry,
} from '../shared/protocol';
import type { TermView } from './terminal';

/**
 * Cliente WebSocket tipado contra el protocolo compartido, con RECONEXIÓN
 * automática. El orquestador se reinicia a menudo en desarrollo (`tsx watch`
 * recarga en cada edición) y eso mata el socket; sin reconexión la pestaña
 * quedaba "conectada" en falso y todo `send()` lanzaba sobre un socket muerto
 * (no abría sesiones, no enviaba input). Ahora:
 *  - reconecta con backoff (0.5s → 5s) mientras la página esté viva,
 *  - notifica el estado real de conexión (onStatus),
 *  - encola los mensajes mientras está caído y los vacía al reabrir.
 * Al reconectar, el orquestador reenvía su snapshot → las sesiones se restauran.
 */
export class Bridge {
  private ws: WebSocket | null = null;
  private handlers: Array<(m: ServerMsg) => void> = [];
  private statusCbs: Array<(connected: boolean) => void> = [];
  /** Mensajes pendientes de enviar (socket aún no abierto / reconectando). */
  private outbox: ClientMsg[] = [];
  private backoff = 500; // ms; sube hasta 5s
  private closedByUser = false;

  constructor(private url: string) {
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500; // éxito → resetea el backoff
      // Vacía lo que se acumuló mientras estuvo caído (en orden de llegada).
      const pending = this.outbox;
      this.outbox = [];
      for (const m of pending) ws.send(JSON.stringify(m));
      for (const cb of this.statusCbs) cb(true);
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as ServerMsg;
      for (const h of this.handlers) h(msg);
    };

    ws.onclose = () => {
      for (const cb of this.statusCbs) cb(false);
      if (this.closedByUser) return;
      // Reintenta con backoff exponencial acotado.
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };

    // onerror precede a onclose; dejamos que onclose gestione la reconexión.
    ws.onerror = () => ws.close();
  }

  /** Notifica cambios de conexión (true=abierto, false=caído/reconectando). */
  onStatus(cb: (connected: boolean) => void): void {
    this.statusCbs.push(cb);
    cb(this.ws?.readyState === WebSocket.OPEN);
  }

  on(cb: (m: ServerMsg) => void): void {
    this.handlers.push(cb);
  }

  private send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else this.outbox.push(m); // se enviará al reconectar
  }

  create(
    sectionId: string,
    agent: AgentKind,
    mode: PermMode,
    cwd: string,
    kind: SectionKind,
    cols?: number,
    rows?: number,
  ): void {
    this.send({ t: 'create', sectionId, agent, mode, cwd, kind, cols, rows });
  }

  say(sectionId: string, text: string): void {
    this.send({ t: 'say', sectionId, text });
  }

  /** Modo pty: teclas crudas (o texto dictado + '\r') hacia el PTY. */
  termInput(sectionId: string, data: string): void {
    this.send({ t: 'term-input', sectionId, data });
  }

  /** Modo pty: avisa al server del nuevo tamaño del xterm. */
  termResize(sectionId: string, cols: number, rows: number): void {
    this.send({ t: 'term-resize', sectionId, cols, rows });
  }

  close(sectionId: string): void {
    this.send({ t: 'close', sectionId });
  }
}

/**
 * Estado local de una sección en la UI.
 *  - rpc: `entries` es la fuente del log de texto.
 *  - pty: el estado vive en el xterm (`term`); guardamos geometría y el
 *    `scrollback` pendiente de pintar hasta que la TermView se monte/active.
 */
export interface UiSection {
  sectionId: string;
  agent: AgentKind;
  mode: PermMode;
  cwd: string;
  ready: boolean;
  kind: SectionKind;
  /** Historial (modo rpc). */
  entries: TranscriptEntry[];
  /** Vista de terminal viva (modo pty), si está montada. */
  term?: TermView;
  /** Geometría conocida del PTY (modo pty). */
  cols?: number;
  rows?: number;
  /** Salida pendiente de escribir cuando la TermView se monte (modo pty). */
  pendingTermData?: string;
  /** Scrollback recibido en snapshot, aún no reproducido (modo pty). */
  pendingScrollback?: string;
}

export function newSectionId(): string {
  return 'sec-' + Math.floor(performance.now()).toString(36) + '-' + (crypto.randomUUID?.() ?? '').slice(0, 8);
}
