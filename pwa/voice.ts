// Capa de voz: STT push-to-talk + TTS por frase + medidor de amplitud de micro.
// La Web Speech API no está en lib.dom.d.ts por defecto → declaramos lo mínimo.
//
// STT y TTS son INTERCAMBIABLES entre dos proveedores:
//  - 'browser': Web Speech (SpeechRecognition) + SpeechSynthesis (lo de siempre).
//  - 'api':     graba/sintetiza vía el orquestador (POST /api/stt, /api/tts).
// El consumidor elige por sesión vía startStt(engine, cfg, ...) / createTts(engine, cfg).

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

// ---- Configuración de proveedores ---------------------------------------

export type VoiceEngine = 'browser' | 'api';

// 'groq' es un preset OpenAI-compatible: el cliente lo manda como 'groq' pero el
// proxy lo normaliza a 'openai' (mismo multipart /audio/transcriptions + Bearer).
// 'minimax' es TTS con response JSON+hex (propio del proxy, no OpenAI-compatible).
export type VoiceFormat = 'openai' | 'generic' | 'groq' | 'minimax';

/** Config del proveedor por API (vive en localStorage; se manda por cabeceras). */
export interface VoiceApiSettings {
  format: VoiceFormat;
  /** Endpoint; vacío = el server usa el default OpenAI o el de su .env. */
  url: string;
  /** API key (se manda como Authorization: Bearer). Solo en uso local. */
  key: string;
  model: string;
  /** Solo TTS: voz del proveedor (p.ej. 'alloy'). */
  voice?: string;
  /** Solo TTS: velocidad de habla (0.25–4.0; 1 = normal). */
  speed?: number;
}

/**
 * Config del proxy de limpieza de texto (opcional, vía cabeceras x-voice-clean-*).
 * Si `enabled` está apagado, el flujo TTS es idéntico al actual (trocea por frase).
 * Si está encendido, ApiTts acumula TODO el turno sin trocear y lo manda en una
 * sola request; el proxy primero lo limpia con un LLM OpenAI-compatible y luego
 * lo sintetiza. Vive en localStorage junto a sttApi/ttsApi.
 */
export interface CleanSettings {
  /** true = acumula el turno y manda cabeceras x-voice-clean-* al proxy. */
  enabled: boolean;
  /** Preset del proveedor de limpieza: 'minimax' (rápido, sin reasoning) u 'openai'. */
  format: 'openai' | 'minimax';
  /** Base OpenAI-compatible o endpoint completo /chat/completions; vacío = .env. */
  url: string;
  /** Bearer token del LLM de limpieza; vacío = .env. */
  key: string;
  /** Model id del LLM de limpieza (p.ej. 'anthropic/claude-3.5-haiku'). */
  model: string;
  /** Prompt de limpieza; vacío = el proxy usa su DEFAULT_CLEANUP_PROMPT. */
  prompt: string;
}

export interface VoiceConfig {
  stt: VoiceEngine;
  tts: VoiceEngine;
  /** Idioma BCP-47 (p.ej. 'es-ES'). */
  lang: string;
  /** Base http del orquestador, p.ej. http://host:4319 (sin slash final). */
  apiBaseUrl: string;
  /** Config del proveedor por API para STT y TTS. */
  sttApi: VoiceApiSettings;
  ttsApi: VoiceApiSettings;
  /** Proxy de limpieza de texto opcional (acumula el turno y lo manda limpiar). */
  ttsClean: CleanSettings;
}

/** Construye las cabeceras x-voice-* que el proxy reenvía al proveedor. */
function apiHeaders(s: VoiceApiSettings): Record<string, string> {
  const h: Record<string, string> = { 'x-voice-format': s.format };
  if (s.url) h['x-voice-url'] = s.url;
  if (s.key) h['x-voice-key'] = s.key;
  if (s.model) h['x-voice-model'] = s.model;
  if (s.voice) h['x-voice-tts-voice'] = s.voice;
  if (s.speed && s.speed !== 1) h['x-voice-speed'] = String(s.speed);
  return h;
}

/**
 * Construye las cabeceras x-voice-clean-* que activan el proxy de limpieza de
 * texto en el flujo TTS. Patrón de apiHeaders: solo emite las cabeceras que tengan
 * valor. `x-voice-clean-prompt` se omite si está vacío → el proxy usa su default.
 * Si `enabled` es false, NO emite nada (el proxy ignora la limpieza por completo).
 */
export function cleanHeaders(s: CleanSettings): Record<string, string> {
  const h: Record<string, string> = {};
  if (s.enabled) h['x-voice-clean-enabled'] = 'on';
  if (s.format) h['x-voice-clean-format'] = s.format;
  if (s.url) h['x-voice-clean-url'] = s.url;
  if (s.key) h['x-voice-clean-key'] = s.key;
  if (s.model) h['x-voice-clean-model'] = s.model;
  // encodeURIComponent: los headers HTTP NO admiten bytes no-ASCII (acentos/ñ
  // harían que fetch() lanzara "Invalid value"). El prompt del server default
  // tiene acentos → debe viajar codificado. El proxy lo decodifica con
  // decodeURIComponent.
  if (s.prompt) h['x-voice-clean-prompt'] = encodeURIComponent(s.prompt);
  return h;
}

// ---- STT: push-to-talk (mantener pulsado) -------------------------------

export interface HoldListener {
  start(): void;
  stop(): void;
}

/** Errores de SpeechRecognition que NO deben terminar el push-to-talk:
 *  Chrome corta el motor por silencio/aborto aunque sigamos pulsando. */
const RECOVERABLE = new Set(['no-speech', 'aborted', 'audio-capture']);

/**
 * Reconocedor "mantener para hablar": acumula el texto mientras se mantiene y
 * lo entrega completo al soltar. Como Chrome autodetiene el reconocimiento por
 * silencio (error `no-speech`/`aborted`), lo REINICIAMOS mientras el botón siga
 * pulsado; solo se cierra de verdad cuando se llama a `stop()`.
 */
export function createHoldListener(opts: {
  lang?: string;
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onEnd?: () => void;
  onError?: (msg: string) => void;
}): HoldListener {
  const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Ctor) throw new Error('Reconocimiento de voz no disponible — usa Chrome de escritorio (no Brave/Arc/Firefox).');

  const rec = new Ctor();
  rec.lang = opts.lang ?? 'es-ES';
  rec.continuous = true;
  rec.interimResults = true;

  let finalText = '';
  let holding = false; // true mientras el usuario mantiene pulsado
  let fatal = ''; // error que SÍ debe abortar (permiso/red)

  const begin = () => {
    try {
      rec.start();
    } catch {
      /* InvalidStateError: aún no terminó el anterior; onend reintentará */
    }
  };

  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript + ' ';
      else interim += r[0].transcript;
    }
    if (interim) opts.onInterim?.(interim);
  };

  rec.onerror = (e) => {
    if (RECOVERABLE.has(e.error)) return; // onend reiniciará si seguimos pulsando
    fatal =
      e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'Permiso de micrófono denegado. Habilítalo en el candado de la barra de direcciones.'
        : e.error === 'network'
          ? 'Sin red: el dictado de Chrome usa un servicio en línea.'
          : `Error de reconocimiento: ${e.error}`;
  };

  rec.onend = () => {
    // Si seguimos pulsando y no hubo error fatal → reiniciar (no soltó el usuario).
    if (holding && !fatal) {
      begin();
      return;
    }
    const t = finalText.trim();
    finalText = '';
    if (fatal) {
      opts.onError?.(fatal);
      fatal = '';
    } else if (t) {
      opts.onFinal(t);
    }
    opts.onEnd?.();
  };

  return {
    start: () => {
      finalText = '';
      fatal = '';
      holding = true;
      begin();
    },
    stop: () => {
      holding = false;
      try {
        rec.stop();
      } catch {
        /* ya detenido */
      }
    },
  };
}

// ---- STT unificado (browser | api) --------------------------------------

/** Sesión de dictado en curso: stop() = "soltar" (entrega el final). */
export interface SttSession {
  stop(): void;
}

export interface SttHandlers {
  onInterim?(t: string): void;
  onFinal(t: string): void;
  onError(m: string): void;
  onEnd?(): void;
}

/**
 * Inicia el dictado con el proveedor elegido. Devuelve la sesión activa:
 * llamar `stop()` para soltar y obtener el texto final.
 * El arranque es inmediato (igual que el push-to-talk de navegador).
 */
export function startStt(engine: VoiceEngine, cfg: VoiceConfig, h: SttHandlers): SttSession {
  if (engine === 'browser') {
    const hold = createHoldListener({
      lang: cfg.lang,
      onInterim: h.onInterim,
      onFinal: h.onFinal,
      onError: h.onError,
      onEnd: h.onEnd,
    });
    hold.start();
    return { stop: () => hold.stop() };
  }
  return startApiStt(cfg, h);
}

/** STT vía API: graba con MediaRecorder mientras se mantiene; al stop() sube el audio. */
function startApiStt(cfg: VoiceConfig, h: SttHandlers): SttSession {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  const chunks: BlobPart[] = [];
  let stopped = false; // si se soltó antes de que abriera el micro
  let mime = 'audio/webm';

  const cleanup = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    recorder = null;
  };

  const finishWithError = (msg: string) => {
    h.onError(msg);
    cleanup();
    h.onEnd?.();
  };

  void (async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (stopped) {
        // Se soltó antes de abrir: no dejamos el micro vivo ni grabamos nada.
        s.getTracks().forEach((t) => t.stop());
        h.onEnd?.();
        return;
      }
      stream = s;
      mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.onstop = () => {
        void uploadAndTranscribe();
      };
      recorder.onerror = () => finishWithError('Error grabando audio.');

      h.onInterim?.('🎙 grabando…');
      recorder.start();
    } catch {
      finishWithError('Permiso de micrófono denegado o micrófono no disponible.');
    }
  })();

  const uploadAndTranscribe = async () => {
    const type = recorder?.mimeType || mime || 'audio/webm';
    const blob = new Blob(chunks, { type });
    cleanup();
    if (blob.size === 0) {
      h.onEnd?.();
      return;
    }
    try {
      const res = await fetch(`${cfg.apiBaseUrl}/api/stt`, {
        method: 'POST',
        headers: { 'Content-Type': type, ...apiHeaders(cfg.sttApi) },
        body: blob,
      });
      if (!res.ok) throw new Error(`STT ${res.status}`);
      const data = (await res.json()) as { text?: string };
      const text = (data.text ?? '').trim();
      if (text) h.onFinal(text);
    } catch (e) {
      h.onError(e instanceof Error ? e.message : 'Error transcribiendo audio.');
    } finally {
      h.onEnd?.();
    }
  };

  return {
    stop: () => {
      stopped = true;
      // Si el recorder ya arrancó, su onstop dispara la subida; si no, el flag
      // de `stopped` evita dejar el micro abierto y emite onEnd.
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* ya detenido */
        }
      }
    },
  };
}

// ---- Medidor de amplitud del micrófono (halo reactivo) ------------------

/** Abre el micro y reporta el nivel RMS (0..1) por frame para animar el orbe. */
export class MicMeter {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private raf = 0;
  private stopped = false;

  constructor(private onLevel: (level: number) => void) {}

  async start(): Promise<void> {
    this.stopped = false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Si se soltó el botón antes de que el micro abriera, no dejamos el stream vivo.
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / data.length);
      this.onLevel(Math.min(1, rms * 3));
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.onLevel(0);
    this.stream = undefined;
    this.ctx = undefined;
  }
}

// ---- TTS unificado (browser | api) --------------------------------------

export interface Tts {
  /** Empuja texto en streaming; trocea por frase y reproduce en orden. */
  push(text: string): void;
  /**
   * Reproduce el remanente sin terminador de frase. Con cleanup activo y en modo
   * pty (fragmentos que llegan sueltos de la TUI), un flush por fragmento trocearía
   * el turno en N audios. Por eso, si `immediate` es false (default), el flush se
   * DEBOUNCEA: acumula y solo sintetiza tras una ventana de silencio. `immediate`
   * true fuerza el flush ya (lo usa el `done` de rpc, que sí marca fin de turno).
   */
  flush(immediate?: boolean): void;
  /** Vacía la cola y corta la reproducción en curso (barge-in). */
  stop(): void;
  /** Notifica si está sonando algo (para animar el orbe). */
  onStateChange?: (speaking: boolean) => void;
  /** Nivel de amplitud (0..1) del audio TTS real, por frame. Solo lo emite ApiTts. */
  onLevel?: (level: number) => void;
  /**
   * Se dispara SOLO cuando la limpieza de texto está activa (ttsClean.enabled):
   *  - 'start' al iniciar el fetch al proxy (el proxy limpia server-side, invisible en Network).
   *  - 'done'  al recibir la respuesta; `info` trae el ratio de compactación
   *    (`before`/`after` = longitudes del texto original y limpio) si el proxy
   *    expuso las cabeceras x-clean-before/x-clean-after, o viene sin `info` si
   *    hubo limpieza pero sin métricas legibles. Solo lo emite ApiTts.
   */
  onCleaning?: (state: 'start' | 'done', info?: { before: number; after: number }) => void;
}

export function createTts(engine: VoiceEngine, cfg: VoiceConfig): Tts {
  return engine === 'browser'
    ? new BrowserTts(cfg.lang, cfg.ttsApi.speed ?? 1)
    : new ApiTts(cfg);
}

/** Trocea el buffer en frases completas (terminadas en . ! ?). */
function chunkSentences(buf: string, emit: (sentence: string) => void): string {
  const re = /[^.!?]*[.!?]+/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) {
    emit(m[0].trim());
    lastIndex = re.lastIndex;
  }
  return buf.slice(lastIndex);
}

/** TTS de navegador: cola por frase con SpeechSynthesis. */
export class BrowserTts implements Tts {
  onStateChange?: (speaking: boolean) => void;

  private queue: string[] = [];
  private buf = '';
  private speaking = false;
  private wasActive = false;

  constructor(private lang: string, private rate = 1) {}

  push(text: string): void {
    this.buf += text;
    this.buf = chunkSentences(this.buf, (s) => this.enqueue(s));
  }

  // BrowserTts nunca limpia texto → el debounce no aplica; ignora `immediate`.
  flush(_immediate = false): void {
    const tail = this.buf.trim();
    this.buf = '';
    if (tail) this.enqueue(tail);
  }

  stop(): void {
    this.queue = [];
    this.buf = '';
    this.speaking = false;
    speechSynthesis.cancel();
    this.notify();
  }

  private enqueue(sentence: string): void {
    if (!sentence) return;
    this.queue.push(sentence);
    this.notify();
    this.drain();
  }

  private drain(): void {
    if (this.speaking) return;
    const next = this.queue.shift();
    if (!next) {
      this.notify();
      return;
    }
    this.speaking = true;
    this.notify();
    const u = new SpeechSynthesisUtterance(next);
    u.lang = this.lang;
    u.rate = this.rate; // velocidad de habla (1 = normal)
    const cont = () => {
      this.speaking = false;
      this.drain();
    };
    u.onend = cont;
    u.onerror = cont;
    speechSynthesis.speak(u);
  }

  private notify(): void {
    const active = this.speaking || this.queue.length > 0;
    if (active !== this.wasActive) {
      this.wasActive = active;
      this.onStateChange?.(active);
    }
  }
}

/**
 * Compat: alias histórico de la clase de TTS de navegador.
 * El código viejo importaba `Speaker`; ahora es la impl 'browser' del Tts.
 */
export { BrowserTts as Speaker };

/**
 * Ventana de silencio (ms) para agrupar fragmentos de un turno con cleanup activo.
 * En modo pty la prosa llega en trozos sueltos según se dibuja la TUI; esperamos
 * este lapso sin trozos nuevos antes de sintetizar, para leer el turno de una vez.
 */
const CLEAN_FLUSH_DEBOUNCE_MS = 1500;

/**
 * TTS vía API: encola frases, las sintetiza con POST /api/tts y las reproduce
 * con un HTMLAudioElement encadenado (una a la vez, en orden).
 */
export class ApiTts implements Tts {
  onStateChange?: (speaking: boolean) => void;
  onLevel?: (level: number) => void;
  onCleaning?: (state: 'start' | 'done', info?: { before: number; after: number }) => void;

  private queue: string[] = [];
  private buf = '';
  private audio: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private playing = false;
  private wasActive = false;
  // Token de cancelación: al stop() lo incrementamos para descartar fetchs en vuelo.
  private gen = 0;
  // AbortController del fetch en curso (complemento del gen: aborta la request
  // al proxy al barge-in, en vez de esperar a que termine para descartar el audio).
  private abortController: AbortController | null = null;
  // Timer de debounce del flush con cleanup activo (modo pty): agrupa los
  // fragmentos que llegan sueltos de la TUI en una sola síntesis por turno.
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Web Audio para medir el nivel REAL del audio TTS (alimenta el orbe).
  private actx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelData: Uint8Array<ArrayBuffer> | null = null;
  private currentSource: MediaElementAudioSourceNode | null = null;
  private meterRaf = 0;

  constructor(private cfg: VoiceConfig) {}

  push(text: string): void {
    // Limpieza ON: acumula TODO el turno sin trocear; flush() mandará el buf
    // entero como una sola unidad para que el proxy lo limpie de una pasada.
    // ttsClean puede no existir en configs viejas migradas → guard defensivo.
    if (this.cfg.ttsClean?.enabled) {
      // Separador entre fragmentos que llegan sueltos (pty): sin él se pegarían
      // palabras al concatenar ("…sesión.Hola"). Solo si el buf no acaba en espacio.
      if (this.buf && !/\s$/.test(this.buf)) this.buf += ' ';
      this.buf += text;
      return;
    }
    this.buf += text;
    this.buf = chunkSentences(this.buf, (s) => this.enqueue(s));
  }

  flush(immediate = false): void {
    // Con cleanup activo y sin flush inmediato: debounce. Cada fragmento del turno
    // (pty) reprograma el timer; solo tras CLEAN_FLUSH_DEBOUNCE_MS sin fragmentos
    // nuevos se sintetiza el turno entero de una vez → lectura fluida, no troceada.
    // `immediate` (el `done` de rpc, que sí marca fin de turno) salta el debounce.
    if (this.cfg.ttsClean?.enabled && !immediate) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.doFlush();
      }, CLEAN_FLUSH_DEBOUNCE_MS);
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.doFlush();
  }

  /** Encola el buffer acumulado como una sola unidad (lo consume drain()). */
  private doFlush(): void {
    const tail = this.buf.trim();
    this.buf = '';
    if (tail) this.enqueue(tail);
  }

  stop(): void {
    this.gen++;
    this.queue = [];
    this.buf = '';
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.playing = false;
    // Aborta el fetch al proxy en vuelo (si lo hay). El chequeo `myGen !== this.gen`
    // tras cada await sigue siendo la guarda principal; esto es complemento para
    // cortar la request de red cuanto antes.
    this.abortController?.abort();
    this.abortController = null;
    this.stopMeter();
    this.disconnectSource();
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    this.revokeUrl();
    this.notify();
  }

  private enqueue(sentence: string): void {
    if (!sentence) return;
    this.queue.push(sentence);
    this.notify();
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.playing) return;
    const next = this.queue.shift();
    if (next === undefined) {
      this.notify();
      return;
    }
    this.playing = true;
    this.notify();
    const myGen = this.gen;
    // AbortController de este fetch: stop() lo aborta para cortar la request al
    // proxy al barge-in (el gen sigue siendo la guarda lógica principal).
    const ac = new AbortController();
    this.abortController = ac;
    // [DIAG] cleanup — quitar cuando la limpieza funcione. Confirma en la consola
    // del navegador si esta instancia de ApiTts lleva la config de limpieza.
    const _ch = cleanHeaders(this.cfg.ttsClean ?? { enabled: false, format: 'openai', url: '', key: '', model: '', prompt: '' });
    console.log('[cleanup-diag-client] ttsClean=', JSON.stringify(this.cfg.ttsClean),
      '| headers enviados=', Object.keys(_ch).join(',') || '(ninguno)');
    // Limpieza activa: el proxy limpia server-side (invisible en Network) antes de
    // sintetizar. Avisamos a la UI al arrancar el fetch ('start') y al recibir la
    // respuesta ('done', con el ratio de compactación si el proxy lo expuso).
    const cleaning = !!this.cfg.ttsClean?.enabled;
    if (cleaning) this.onCleaning?.('start');
    try {
      const res = await fetch(`${this.cfg.apiBaseUrl}/api/tts`, {
        method: 'POST',
        // x-voice-lang: deja que MiniMax fuerce la pronunciación según el idioma
        // configurado (es-ES → Spanish). Otros proveedores lo ignoran.
        // x-voice-clean-*: activan la limpieza opcional con LLM en el proxy. Solo
        // se emiten si ttsClean.enabled; ttsClean puede no existir en configs viejas.
        headers: {
          'Content-Type': 'application/json',
          ...apiHeaders(this.cfg.ttsApi),
          'x-voice-lang': this.cfg.lang,
          ...cleanHeaders(this.cfg.ttsClean ?? { enabled: false, format: 'openai', url: '', key: '', model: '', prompt: '' }),
        },
        body: JSON.stringify({ text: next }),
        signal: ac.signal,
      });
      if (myGen !== this.gen) return; // cancelado mientras sintetizaba
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`TTS ${res.status} ${detail.slice(0, 240)}`);
      }
      // Respuesta OK y no cancelada: cerramos el estado de limpieza con el ratio de
      // compactación si el proxy expuso x-clean-before/x-clean-after (números > 0).
      if (cleaning) {
        const b = Number(res.headers.get('x-clean-before'));
        const a = Number(res.headers.get('x-clean-after'));
        if (Number.isFinite(b) && Number.isFinite(a) && b > 0 && a > 0) {
          this.onCleaning?.('done', { before: b, after: a });
        } else {
          this.onCleaning?.('done'); // hubo cleanup pero sin métricas legibles
        }
      }
      const blob = await res.blob();
      if (myGen !== this.gen) return;

      this.revokeUrl();
      this.currentUrl = URL.createObjectURL(blob);
      const audio = new Audio(this.currentUrl);
      this.audio = audio;
      const cont = () => {
        if (myGen !== this.gen) return;
        this.playing = false;
        this.stopMeter();
        this.disconnectSource();
        void this.drain();
      };
      audio.onended = cont;
      audio.onerror = cont;
      // Reproduce SIEMPRE primero: el sonido nunca depende del analyser ni de
      // resume() (que puede quedar pendiente sin gesto y bloquearía el play()).
      // Si play() rechaza (política autoplay sin gesto), lo registramos: antes se
      // tragaba en silencio y era imposible diagnosticar un "no se escucha".
      await audio.play().catch((e) => {
        console.warn('[TTS] play() rechazado (¿autoplay sin gesto?):', e instanceof Error ? e.message : e);
        cont();
      });
      // Engancha el medidor de nivel después, sin bloquear (mejor esfuerzo).
      if (this.onLevel) void this.attachMeter(audio);
    } catch (e) {
      // Fetch fallido o abortado (barge-in): cerramos el estado de limpieza para
      // que la UI no quede colgada en "limpiando". El handler en main lo ignora si
      // el usuario ya está escuchando (listening), así que es seguro en el abort.
      if (cleaning) this.onCleaning?.('done');
      if (myGen !== this.gen) return;
      // Frase fallida: la mostramos en consola (antes se tragaba en silencio) y
      // seguimos con la siguiente para no bloquear la cola.
      console.warn('[TTS] frase fallida:', e instanceof Error ? e.message : e);
      this.playing = false;
      void this.drain();
    }
  }

  private revokeUrl(): void {
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
  }

  /**
   * Enruta el <audio> por Web Audio (audio → analyser → destino) y arranca el
   * medidor de nivel. Si el AudioContext no arranca (sin gesto del usuario), no
   * captura el elemento: el audio se reproduce normal y el orbe usa su fallback.
   */
  private async attachMeter(audio: HTMLAudioElement): Promise<void> {
    try {
      if (!this.actx) {
        this.actx = new AudioContext();
        this.analyser = this.actx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.connect(this.actx.destination);
        this.levelData = new Uint8Array(this.analyser.frequencyBinCount);
      }
      if (this.actx.state !== 'running') {
        // Sin gesto activo, resume() puede quedar PENDIENTE: la disparamos sin
        // esperar. Este clip suena por la salida normal (no se captura); el
        // siguiente ya tendrá el contexto 'running' y reaccionará al audio.
        void this.actx.resume().catch(() => {});
        return;
      }
      if (!this.analyser) return;
      // createMediaElementSource reenruta el audio por el grafo (solo 1 vez por
      // <audio>). Como ya está sonando y el contexto corre, no lo silencia.
      const src = this.actx.createMediaElementSource(audio);
      src.connect(this.analyser);
      this.currentSource = src;
      this.startMeter();
    } catch {
      this.disconnectSource();
    }
  }

  /** Lazo por frame: RMS del audio TTS en curso → onLevel(0..1). */
  private startMeter(): void {
    if (this.meterRaf || !this.analyser || !this.levelData) return;
    const tick = () => {
      if (!this.playing || !this.analyser || !this.levelData) {
        this.meterRaf = 0;
        this.onLevel?.(0);
        return;
      }
      this.analyser.getByteTimeDomainData(this.levelData);
      let sum = 0;
      for (const v of this.levelData) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / this.levelData.length);
      this.onLevel?.(Math.min(1, rms * 3.2));
      this.meterRaf = requestAnimationFrame(tick);
    };
    this.meterRaf = requestAnimationFrame(tick);
  }

  private stopMeter(): void {
    if (this.meterRaf) cancelAnimationFrame(this.meterRaf);
    this.meterRaf = 0;
    this.onLevel?.(0);
  }

  private disconnectSource(): void {
    if (this.currentSource) {
      try {
        this.currentSource.disconnect();
      } catch {
        /* ya desconectado */
      }
      this.currentSource = null;
    }
  }

  private notify(): void {
    const active = this.playing || this.queue.length > 0;
    if (active !== this.wasActive) {
      this.wasActive = active;
      this.onStateChange?.(active);
    }
  }
}
