// Extrae prosa estable de un stream ANSI usando @xterm/headless.
//
// Por qué un terminal headless: la TUI de un CLI redibuja regiones de la
// pantalla constantemente (spinners, cajas, reflows). Si extraemos texto de
// los bytes crudos hablaríamos lo mismo muchas veces. Manteniendo el estado
// renderizado, leemos el área de conversación (por ENCIMA de la caja de input)
// y hablamos solo las líneas que no hemos dicho aún.
//
// Clave para TUIs de pantalla alterna (claude/codex/opencode): NO usamos un
// cursor monotónico (eso solo sirve para una shell con scroll, donde el cursor
// baja). Estos CLIs redibujan en sitio con el cursor fijo en la caja de input
// abajo, así que rastreamos un CONJUNTO de líneas ya habladas y emitimos las
// nuevas. El banner/tips de arranque se "siembra" como ya-visto en la primera
// interacción del usuario para no hablarlo nunca.

import { createRequire } from 'node:module';
import type { AgentKind } from '../shared/protocol';

// @xterm/headless es CommonJS: bajo ESM `import { Terminal }` compila (los tipos
// declaran el named export) pero falla en runtime (solo expone `default`). Lo
// cargamos vía require, cuyo module.exports SÍ trae { Terminal }.
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

/** Glyphs decorativos de TUI que ensucian la prosa (se quitan al inicio de línea). */
const TUI_GLYPHS = /^[│>●⏺•*✻✶✳✢✣—╭╮╯╰─┌┐└┘├┤┬┴┼⎿\s]+/u;
/**
 * Línea que ARRANCA con un glifo de aviso/error → es chrome del CLI (warnings,
 * errores, no-encontrado), no prosa del agente. Se descarta entera.
 */
const WARN_PREFIX = /^\s*[⚠✗✘✖⛔🚫❗❌‼⚡]/u;

// --- Roles de línea por glifo inicial (señal POSITIVA de "qué es") -----------
// Solo se habla el BLOQUE DEL ASISTENTE: la línea marcada + sus continuaciones.
// Todo lo demás (input del usuario, herramientas, pensamientos, avisos, cajas)
// se descarta. La marca de asistente DEPENDE DEL CLI (verificada con capturas
// reales: ver scripts/capture-tui.mjs):
//   claude → ⏺ (U+23FA)        codex → ● / •        opencode → SIN marca.
// Por eso es per-agente: una lista global fija no sirve para los tres.
interface ExtractProfile {
  /** Glifos iniciales que marcan prosa del asistente. */
  assistant: Set<string>;
  /** El CLI no marca su prosa (opencode): hablar líneas sin marca que sobrevivan al filtro. */
  speakUnmarked: boolean;
}
function profileFor(agent: AgentKind): ExtractProfile {
  switch (agent) {
    case 'claude':
      // claude usa ⏺ para prosa Y para tool-calls; cleanLine descarta `Tool(...)`.
      return { assistant: new Set(['⏺', '●']), speakUnmarked: false };
    case 'codex':
      return { assistant: new Set(['●', '•']), speakUnmarked: false };
    case 'opencode':
      // Su prosa sale como texto plano sin glifo → modo sin-marca + exclusión de chrome.
      return { assistant: new Set(['●', '•']), speakUnmarked: true };
    default:
      return { assistant: new Set(['●', '•', '⏺']), speakUnmarked: false }; // mock/bash
  }
}
/** Marca de input del usuario (prompt). */
const USER_MARK = new Set(['›', '❯', '>']);
/** Herramientas, resultados, pensamientos, avisos y cajas → no es prosa.
 *  Incluye chrome de opencode (caja `┃`, estado `▣`). `⏺` sigue aquí: para
 *  agentes que NO lo declaran como asistente (codex) cuenta como "otro". */
const OTHER_MARK = new Set([
  '⏺', '⎿', '⚠', '✗', '✘', '✖', '⛔', '🚫', '❗', '❌', '‼', '⚡',
  '✻', '✶', '✳', '✢', '✣',
  '│', '┃', '▣', '╭', '╮', '╰', '╯', '─', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼',
]);
/** Al menos un carácter de palabra (letra o número) para considerar la línea prosa. */
const WORD_CHAR = /[\p{L}\p{N}]/gu;
/**
 * Mobiliario de la TUI con palabras pero sin valor para TTS (footer, atajos,
 * spinners, banner). Si una línea encaja, no se habla. El timer del spinner
 * («Cooked/Baked/Pondering… for Ns») se caza por el patrón «for Ns», ya que el
 * verbo es aleatorio en claude.
 */
const NOISE =
  /(shift\+tab|esc to interrupt|bypass permissions|for agents|to cycle|ctx:\s*\d|\bfor \d+\s*s\b|\(\d+s\)|tips for getting started|welcome back|what's new|release-notes|context left|\/effort|tokens?\b.*\bused|thought:\s*\d|ctrl\+\w|·\s*thinking|\b\d+(\.\d+)?k\b\s*\(\d+%\))/i;
/** Cuántas líneas de input recientes recordamos para suprimir su eco. */
const INPUT_RING = 8;
/** Debounce: esperamos a que el redibujado se asiente antes de extraer. */
const DEBOUNCE_MS = 500;
/** Tope de prosa por evento (evita TTS gigantes). */
const MAX_PROSE = 600;
/** Tope de líneas recordadas como "ya habladas" (ring para no crecer sin fin). */
const SPOKEN_CAP = 400;

export class TerminalExtractor {
  private term: InstanceType<typeof Terminal>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private recentInput: string[] = [];
  // Líneas ya habladas (Set para O(1) + orden para acotar el tamaño).
  private spoken = new Set<string>();
  private spokenOrder: string[] = [];
  // Hasta la primera interacción del usuario no hablamos nada (suprime banner).
  private armed = false;
  // Perfil de extracción según el agente (marca de prosa / modo sin-marca).
  private assistant: Set<string>;
  private speakUnmarked: boolean;

  constructor(
    cols: number,
    rows: number,
    agent: AgentKind,
    private onProse: (text: string) => void,
  ) {
    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    const p = profileFor(agent);
    this.assistant = p.assistant;
    this.speakUnmarked = p.speakUnmarked;
  }

  /** Alimenta bytes crudos al terminal y reprograma la extracción. */
  write(data: string): void {
    this.term.write(data);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.extract();
    }, DEBOUNCE_MS);
  }

  /**
   * Acumula líneas de entrada del usuario (teclado/voz) para suprimir su eco.
   * La PRIMERA entrada "arma" el extractor y siembra lo visible (banner/tips)
   * como ya-hablado, para que nunca se lea en voz alta.
   */
  noteInput(data: string): void {
    if (!this.armed) {
      this.armed = true;
      for (const line of this.visibleProse()) this.remember(line);
    }
    for (const raw of data.split(/[\r\n]+/)) {
      const line = raw.trim();
      if (!line) continue;
      this.recentInput.push(line);
      if (this.recentInput.length > INPUT_RING) this.recentInput.shift();
    }
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.term.dispose();
  }

  /** Clasifica una línea por su primer glifo (code point, no code unit). */
  private lineRole(raw: string): 'assistant' | 'user' | 'other' | 'cont' | 'blank' {
    const t = raw.trim();
    if (!t) return 'blank';
    const first = [...t][0];
    if (this.assistant.has(first)) return 'assistant';
    if (USER_MARK.has(first)) return 'user';
    if (OTHER_MARK.has(first)) return 'other';
    return 'cont'; // sin marca: posible continuación de un bloque del asistente
  }

  /**
   * Prosa del asistente visible (por encima de la caja de input). Recorre las
   * líneas manteniendo si estamos DENTRO de un bloque del agente: una línea
   * marcada (`●`/`•`) lo abre; las líneas sin marca son su continuación; el
   * input/herramientas/avisos/cajas lo cierran. Solo se devuelve lo del agente.
   */
  private visibleProse(): string[] {
    const buf = this.term.buffer.active;
    const top = buf.baseY;
    const absCursor = buf.baseY + buf.cursorY;
    const out: string[] = [];
    let inAssistant = false;
    for (let i = top; i < absCursor; i++) {
      const raw = buf.getLine(i)?.translateToString(true);
      if (raw === undefined) continue;
      const role = this.lineRole(raw);
      if (role === 'blank') continue; // salto de párrafo: conserva el estado
      if (role === 'assistant') {
        inAssistant = true;
      } else if (role === 'user' || role === 'other') {
        inAssistant = false; // cambia de hablante → cierra el bloque del agente
        continue;
      } else if (!inAssistant && !this.speakUnmarked) {
        continue; // 'cont' fuera de bloque → chrome (salvo opencode, que no marca su prosa)
      }
      const cleaned = this.cleanLine(raw);
      if (cleaned) out.push(cleaned);
    }
    return out;
  }

  /** Marca una línea como ya-hablada, acotando el ring. */
  private remember(line: string): void {
    if (this.spoken.has(line)) return;
    this.spoken.add(line);
    this.spokenOrder.push(line);
    if (this.spokenOrder.length > SPOKEN_CAP) {
      const old = this.spokenOrder.shift();
      if (old !== undefined) this.spoken.delete(old);
    }
  }

  /** Habla las líneas visibles que aún no se han dicho. */
  private extract(): void {
    const cur = this.visibleProse();

    // Antes de la 1ª interacción: solo memoriza (banner/tips), no habla.
    if (!this.armed) {
      for (const line of cur) this.remember(line);
      return;
    }

    const emit: string[] = [];
    for (const line of cur) {
      if (this.spoken.has(line)) continue;
      // Evita hablar un fragmento ya contenido en algo dicho (redibujado parcial).
      if (this.spokenOrder.some((s) => s.includes(line))) {
        this.remember(line);
        continue;
      }
      this.remember(line);
      emit.push(line);
    }

    if (emit.length === 0) return;
    const text = emit.join(' ').slice(0, MAX_PROSE).trim();
    if (text) this.onProse(text);
  }

  /** Devuelve la línea limpia o '' si es ruido (decoración, eco de input, vacía). */
  private cleanLine(line: string): string {
    // Avisos/errores del CLI (⚠ ✗ ⛔…) → no es prosa del agente, fuera.
    if (WARN_PREFIX.test(line)) return '';

    const trimmed = line.trim().replace(TUI_GLYPHS, '').trim();
    if (!trimmed) return '';

    // Tool-call de claude (`Bash(...)`, `Read(...)`, `Update(file)`…): no es prosa.
    if (/^[A-Z][\w.-]*\(/.test(trimmed)) return '';

    // Necesita >= 2 caracteres de palabra para valer la pena hablarla.
    const wordCount = (trimmed.match(WORD_CHAR) ?? []).length;
    if (wordCount < 2) return '';

    // Mobiliario de la TUI (footer, atajos, spinner, banner).
    if (NOISE.test(trimmed)) return '';

    // Suprime el eco del prompt: si una línea de input reciente está contenida
    // en esta línea (o viceversa), es nuestra propia voz/teclado reflejada.
    for (const input of this.recentInput) {
      if (trimmed.includes(input) || input.includes(trimmed)) return '';
    }

    return trimmed;
  }
}
