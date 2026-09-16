// Wrapper delgado de xterm.js para las secciones en modo PTY.
// Encapsula el Terminal + FitAddon + ResizeObserver y expone una API mínima.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// TEMPORAL: quitar tras verificar en sesión real.
const DEBUG_REPLAY = true;

/** Vista de terminal real: salida cruda del PTY + teclas hacia el server. */
export class TermView {
  private term: Terminal;
  private fitAddon: FitAddon;
  private ro: ResizeObserver;
  // Pane propio de esta sección. Cada sección pty tiene el suyo y se muestra/oculta
  // al conmutar; así N terminales coexisten sin apilar su DOM en un contenedor único.
  readonly el: HTMLDivElement;
  // Última geometría reportada, para no emitir resizes redundantes.
  private lastCols = 0;
  private lastRows = 0;
  // Debounce de resize: durante transiciones CSS solo se informa al PTY la
  // geometría asentada (ver fit()).
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCols = 0;
  private pendingRows = 0;
  // Replays en curso: mientras > 0 se suprimen las respuestas del terminal al stdin.
  private silenced = 0;

  constructor(
    container: HTMLElement,
    onData: (d: string) => void,
    private onResize: (cols: number, rows: number) => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'term-pane';
    container.appendChild(this.el);

    this.term = new Terminal({
      convertEol: false, // el PTY ya emite \r\n; no reescribir saltos
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 5000,
      theme: {
        background: '#0f1115',
        foreground: '#e6e9ef',
        cursor: '#5b8cff',
        selectionBackground: '#2b3550',
      },
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.el);

    // Teclas del usuario en el xterm → server (PTY stdin). Durante un replay
    // se suprimen las respuestas automáticas del terminal (queries OSC 10/11…)
    // para que no se inyecten al stdin como si las hubiera tecleado el usuario.
    this.term.onData((d) => {
      if (this.silenced > 0) {
        if (DEBUG_REPLAY) console.debug('[term] respuesta suprimida durante replay:', JSON.stringify(d.slice(0, 120)));
        return;
      }
      onData(d);
    });

    // Ajuste inicial y captura de la geometría real.
    this.fit();

    // Re-ajustar cuando el pane cambia de tamaño (layout responsive / al mostrarse).
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(this.el);
  }

  /** Muestra este pane (sección activa) y reajusta a la geometría visible. */
  show(): void {
    this.el.hidden = false;
    this.fit();
    // El canvas pierde su bitmap al estar oculto: repintado completo con layout listo.
    requestAnimationFrame(() => {
      try {
        this.term.refresh(0, this.term.rows - 1);
      } catch {
        /* desechado */
      }
    });
  }

  /** Oculta este pane (sección en segundo plano). El PTY sigue vivo en el server. */
  hide(): void {
    this.el.hidden = true;
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** Escribe salida cruda del PTY (incluye secuencias ANSI). */
  write(data: string): void {
    this.term.write(data);
  }

  /** Reproduce bytes viejos (scrollback) sin inyectar respuestas al stdin. */
  async writeSilent(data: string): Promise<void> {
    this.silenced++;
    try {
      await this.term.write(data);
    } finally {
      setTimeout(() => {
        this.silenced--;
      }, 50);
    }
  }

  /** Reajusta al contenedor; informa al PTY la geometría asentada (debounce). */
  fit(): void {
    // Oculto o sin layout: no medir (propondría 0×0 y encogería el PTY).
    if (this.el.hidden || this.el.clientWidth === 0 || this.el.clientHeight === 0) return;
    try {
      this.fitAddon.fit();
    } catch {
      /* sin dimensiones todavía: se reintenta al observar */
    }
    const { cols, rows } = this.term;
    if (!cols || !rows) return;
    if (cols === this.lastCols && rows === this.lastRows && !this.resizeTimer) return;
    // Las barras colapsan con transición CSS (0.22s) y el observer escupe
    // tamaños intermedios; aporrear al PTY hace que la TUI se quede con uno
    // viejo. Solo se informa la geometría asentada (ventana mayor que la
    // transición para que ningún hueco intermedio emita).
    this.pendingCols = cols;
    this.pendingRows = rows;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (this.pendingCols !== this.lastCols || this.pendingRows !== this.lastRows) {
        this.lastCols = this.pendingCols;
        this.lastRows = this.pendingRows;
        this.onResize(this.pendingCols, this.pendingRows);
      }
    }, 260);
  }

  focus(): void {
    this.term.focus();
  }

  clear(): void {
    this.term.clear();
  }

  dispose(): void {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.ro.disconnect();
    this.term.dispose();
    this.el.remove();
  }
}
