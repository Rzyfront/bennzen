// Wrapper delgado de xterm.js para las secciones en modo PTY.
// Encapsula el Terminal + FitAddon + ResizeObserver y expone una API mínima.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

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

    // Teclas del usuario en el xterm → server (PTY stdin).
    this.term.onData(onData);

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

  /** Reajusta al contenedor; reporta cols/rows solo si cambiaron. */
  fit(): void {
    try {
      this.fitAddon.fit();
    } catch {
      /* contenedor aún sin dimensiones (oculto): se reintenta al observar */
    }
    const { cols, rows } = this.term;
    if (cols && rows && (cols !== this.lastCols || rows !== this.lastRows)) {
      this.lastCols = cols;
      this.lastRows = rows;
      this.onResize(cols, rows);
    }
  }

  focus(): void {
    this.term.focus();
  }

  clear(): void {
    this.term.clear();
  }

  dispose(): void {
    this.ro.disconnect();
    this.term.dispose();
    this.el.remove();
  }
}
