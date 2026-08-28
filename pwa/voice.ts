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
  /**
   * Tiempos del debounce del flush en modo ON (avanzado, Fase 6). Ausentes → los
   * defaults del motor (CLEAN_SETTLE_MS / CLEAN_MAX_INTERVAL_MS). `settleMs`: ventana
   * de silencio tras la última ráfaga antes de sintetizar. `maxMs`: techo que fuerza
   * síntesis cada tanto aunque el stream no pare (evita "solo habla al final").
   */
  settleMs?: number;
  maxMs?: number;
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
  /**
   * Solo la ruta API: se dispara con el MediaStream del micro cuando abre (Fase 7).
   * Permite REUTILIZAR ese stream para el medidor de nivel (una sola apertura de
   * micro por gesto, menos latencia y un solo permiso). El dueño del ciclo de vida
   * del stream sigue siendo startApiStt; el consumidor solo lo analiza.
   */
  onStream?(stream: MediaStream): void;
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

/** Duración mínima de una grabación para molestarse en transcribirla (ms). Por
 *  debajo es un toque accidental: no vale el round-trip y Whisper alucina con ruido. */
const MIN_TALK_MS = 350;
/** Tamaño mínimo del blob de audio para subirlo (bytes). Con opus ~24kbps, 350ms
 *  ronda 1KB; por debajo de esto es silencio o un toque. */
const MIN_BLOB_BYTES = 1500;

/** STT vía API: graba con MediaRecorder mientras se mantiene; al stop() sube el audio. */
function startApiStt(cfg: VoiceConfig, h: SttHandlers): SttSession {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  const chunks: BlobPart[] = [];
  let stopped = false; // si se soltó antes de que abriera el micro
  let mime = 'audio/webm';
  let startedAt = 0; // Date.now() al arrancar la grabación (0 = nunca grabó)

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
      // Constraints: mono + cancelación de eco/ruido/ganancia → menos payload y
      // mejor transcripción (evita captar el propio TTS y ruido ambiente).
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (stopped) {
        // Se soltó antes de abrir: no dejamos el micro vivo ni grabamos nada.
        s.getTracks().forEach((t) => t.stop());
        h.onEnd?.();
        return;
      }
      stream = s;
      // Comparte el micro ya abierto con el medidor de nivel (Fase 7.1): evita un
      // segundo getUserMedia. startApiStt sigue siendo el dueño (lo cierra en cleanup).
      h.onStream?.(s);
      // Preferimos Opus explícito (mejor compresión que el default) y bajamos el
      // bitrate: voz mono a ~24kbps basta para STT y aligera la subida.
      mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      recorder = mime
        ? new MediaRecorder(s, { mimeType: mime, audioBitsPerSecond: 24000 })
        : new MediaRecorder(s);

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.onstop = () => {
        void uploadAndTranscribe();
      };
      recorder.onerror = () => finishWithError('Error grabando audio.');

      h.onInterim?.('🎙 grabando…');
      startedAt = Date.now();
      recorder.start();
    } catch {
      finishWithError('Permiso de micrófono denegado o micrófono no disponible.');
    }
  })();

  const uploadAndTranscribe = async () => {
    const type = recorder?.mimeType || mime || 'audio/webm';
    const blob = new Blob(chunks, { type });
    const elapsed = startedAt ? Date.now() - startedAt : 0;
    cleanup();
    // Toque accidental / silencio: grabación demasiado corta o demasiado pequeña
    // → no vale un round-trip de STT. (MIN_BLOB_BYTES ya cubre blob vacío.)
    if (blob.size < MIN_BLOB_BYTES || (startedAt && elapsed < MIN_TALK_MS)) {
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
  // ¿Abrimos NOSOTROS el micro? Si el stream vino de fuera (compartido con el STT,
  // Fase 7.1), NO cerramos sus tracks en stop(): su dueño (startApiStt) lo hace.
  private ownsStream = false;

  constructor(private onLevel: (level: number) => void) {}

  /**
   * Arranca el medidor. Sin argumento abre su propio micro (`{audio:true}`); con un
   * `external` reutiliza un stream ya abierto (el del STT por API) → una sola apertura
   * de micro por gesto. En el caso externo no gestiona el ciclo de vida del stream.
   */
  async start(external?: MediaStream): Promise<void> {
    this.stopped = false;
    this.ownsStream = !external;
    const stream = external ?? (await navigator.mediaDevices.getUserMedia({ audio: true }));
    // Si se soltó el botón antes de que el micro abriera, no dejamos el stream vivo
    // (solo si es NUESTRO; un stream externo lo cierra su dueño).
    if (this.stopped) {
      if (this.ownsStream) stream.getTracks().forEach((t) => t.stop());
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
    // Solo cerramos el micro si es NUESTRO; el stream compartido lo cierra su dueño.
    if (this.ownsStream) this.stream?.getTracks().forEach((t) => t.stop());
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

/** Índice (exclusivo) del fin de la primera frase (.!? seguido de espacio o fin de
 *  cadena), o -1 si no hay ninguna. Exigir espacio/fin tras el terminador evita
 *  partir decimales ("3.14") o siglas a media palabra. */
function firstSentenceEnd(s: string): number {
  const m = /[.!?]+(?=\s|$)/.exec(s);
  return m ? m.index + m[0].length : -1;
}

/** Índice (exclusivo) tras el ÚLTIMO límite de cláusula (, ; :) dentro de s, o -1. */
function lastClauseEnd(s: string): number {
  const re = /[,;:](?=\s|$)/g;
  let idx = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) idx = m.index + 1;
  return idx;
}

/**
 * Motor de segmentación unificado (modos limpieza ON y OFF). Extrae del `buf`
 * tantos segmentos hablables como pueda, cada uno de hasta ~`target` caracteres,
 * cortando en el MEJOR límite disponible: fin de frase (.!?) > cláusula (,;:) >
 * espacio > corte duro. Emite cada segmento con `emit` y devuelve el remanente NO
 * emitido (vuelve al buf del llamante).
 *
 * - Una frase completa que quepa holgadamente se emite entera (natural y
 *   progresivo), aunque no llene el target.
 * - Si el buf ya excede el target sin cerrar frase (prosa de captura total, sin
 *   puntuación), corta por cláusula/espacio dentro de la ventana → no espera.
 * - `force` (fin de turno / flush): emite también el remanente corto sin cierre.
 * - Nunca emite segmentos sin caracteres de palabra (puntuación/glifos sueltos):
 *   se descartan del remanente (no se hablan).
 */
export function segmentText(
  buf: string,
  target: number,
  force: boolean,
  emit: (seg: string) => void,
): string {
  let rest = buf.replace(/^\s+/, '');
  // Cota de seguridad: cada iteración acorta `rest` (cut>0); el tope evita cualquier
  // bucle patológico ante entradas raras.
  for (let guard = 0; rest && guard < 10000; guard++) {
    let cut: number;
    const se = firstSentenceEnd(rest);
    if (se > 0 && se <= target * 1.4) {
      cut = se; // (a) frase completa que cabe → córtala ahí
    } else if (rest.length >= target) {
      // (b) material de sobra sin frase que quepa → mejor límite dentro de target
      const w = rest.slice(0, target);
      const clause = lastClauseEnd(w);
      const space = w.lastIndexOf(' ');
      cut = clause > target * 0.5 ? clause : space > target * 0.5 ? space + 1 : target;
    } else if (force) {
      cut = rest.length; // (c) remanente corto, fin de turno → emítelo tal cual
    } else {
      break; // aún no hay un corte natural; esperar más texto
    }
    const seg = rest.slice(0, cut).trim();
    rest = rest.slice(cut).replace(/^\s+/, '');
    if (hasWord(seg)) emit(seg);
  }
  return rest;
}

// Set global para prevenir Garbage Collection de SpeechSynthesisUtterance en V8 (Chromium)
const activeUtterances = new Set<SpeechSynthesisUtterance>();

/** TTS de navegador: cola por frase con SpeechSynthesis robusto contra congelamientos en Chromium. */
export class BrowserTts implements Tts {
  onStateChange?: (speaking: boolean) => void;

  private queue: string[] = [];
  private buf = '';
  private speaking = false;
  private wasActive = false;
  private activeUtterance: SpeechSynthesisUtterance | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;
  private gen = 0;

  constructor(private lang: string, private rate = 1) {}

  push(text: string): void {
    if (this.buf && !/\s$/.test(this.buf)) this.buf += ' ';
    this.buf += text;
    this.buf = segmentText(this.buf, 200, false, (s) => this.enqueue(s));
  }

  // BrowserTts nunca limpia texto → el debounce no aplica; ignora `immediate`.
  flush(_immediate = false): void {
    this.buf = segmentText(this.buf, 200, true, (s) => this.enqueue(s));
  }

  stop(): void {
    this.gen++;
    this.queue = [];
    this.buf = '';
    this.speaking = false;
    this.isProcessing = false;
    this.clearTimers();
    this.stopHeartbeat();
    if (this.activeUtterance) {
      activeUtterances.delete(this.activeUtterance);
      this.activeUtterance = null;
    }
    try {
      if (typeof speechSynthesis !== 'undefined') {
        speechSynthesis.cancel();
      }
    } catch {}
    this.notify();
  }

  private enqueue(sentence: string): void {
    if (!sentence) return;
    this.queue.push(sentence);
    this.notify();
    if (!this.speaking && !this.isProcessing) {
      this.drain();
    }
  }

  private clearTimers(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Heartbeat: previene que Chrome pause SpeechSynthesis silenciosamente tras 15 segundos
    this.heartbeatTimer = setInterval(() => {
      if (typeof speechSynthesis !== 'undefined' && speechSynthesis.paused) {
        try {
          speechSynthesis.resume();
        } catch {}
      }
    }, 4000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private drain(): void {
    if (this.speaking || this.isProcessing) return;
    const next = this.queue.shift();
    if (!next) {
      this.stopHeartbeat();
      this.notify();
      return;
    }

    this.isProcessing = true;
    this.speaking = true;
    this.notify();
    this.startHeartbeat();

    const myGen = this.gen;
    this.clearTimers();

    const u = new SpeechSynthesisUtterance(next);
    this.activeUtterance = u;
    activeUtterances.add(u);
    u.lang = this.lang;
    u.rate = this.rate;

    try {
      const voices = speechSynthesis.getVoices();
      if (voices && voices.length > 0) {
        const langPrefix = this.lang.slice(0, 2).toLowerCase();
        const match = voices.find((v) => v.lang === this.lang) ||
          voices.find((v) => v.lang.toLowerCase().startsWith(langPrefix));
        if (match) u.voice = match;
      }
    } catch {}

    let done = false;
    const cont = () => {
      if (done) return;
      done = true;
      this.clearTimers();
      activeUtterances.delete(u);
      if (this.activeUtterance === u) {
        this.activeUtterance = null;
      }
      this.speaking = false;
      this.isProcessing = false;
      if (myGen === this.gen) {
        // Pausa breve para permitir que el hardware de audio se libere antes de la siguiente frase
        setTimeout(() => {
          if (myGen === this.gen) this.drain();
        }, 30);
      }
    };

    u.onend = () => cont();
    u.onerror = (e) => {
      console.warn('[BrowserTts] error en utterance:', (e as any)?.error ?? e);
      cont();
    };

    // Watchdog de inicio: si en 1.5s no comenzó (bug tras cancel()), fuerza resume() o avanza
    this.startTimer = setTimeout(() => {
      if (done || myGen !== this.gen) return;
      if (typeof speechSynthesis !== 'undefined') {
        if (speechSynthesis.paused) {
          try {
            speechSynthesis.resume();
          } catch {}
        }
        // Si no está hablando después de 2.5s, recupera inmediatamente
        setTimeout(() => {
          if (!done && myGen === this.gen && !speechSynthesis.speaking) {
            console.warn('[BrowserTts] utterance no inició; avanzando');
            cont();
          }
        }, 1000);
      }
    }, 1500);

    u.onstart = () => {
      if (this.startTimer) {
        clearTimeout(this.startTimer);
        this.startTimer = null;
      }
    };

    // Watchdog de fin: tiempo realista basado en longitud (mín 5s, máx 25s por frase de 200 caracteres)
    const maxDuration = Math.max(5000, Math.ceil(next.length * 150));
    this.watchTimer = setTimeout(() => {
      if (!done) {
        console.warn('[BrowserTts] watchdog timeout superado');
        cont();
      }
    }, maxDuration);

    try {
      if (speechSynthesis.paused) speechSynthesis.resume();
      speechSynthesis.speak(u);
    } catch (e) {
      this.clearTimers();
      console.warn('[BrowserTts] error al invocar speechSynthesis.speak:', e);
      cont();
    }
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
 * Ventana de "asentamiento" (ms): tras el último fragmento del turno esperamos
 * este lapso sin fragmentos nuevos antes de sintetizar. Reacciona rápido al fin
 * de una ráfaga. Se REPROGRAMA en cada fragmento (debounce clásico).
 */
const CLEAN_SETTLE_MS = 1000;
/**
 * Techo del debounce (ms): tiempo máximo que un fragmento pendiente puede esperar
 * aunque el stream NO pare. Se arma UNA vez cuando aparece contenido pendiente y
 * NO se reprograma → garantiza síntesis cada ~3s en un turno continuo (mata el
 * viejo bug de "solo habla al final", cuando el debounce se reiniciaba sin fin).
 */
const CLEAN_MAX_INTERVAL_MS = 3000;
/**
 * Tamaño objetivo al re-segmentar el TEXTO YA LIMPIO por frase hacia el TTS (modo
 * ON). La limpieza ya pasó (bloques grandes → /api/clean), aquí solo troceamos su
 * salida en frases naturales para el gapless. Sin ramp-up: no aplica al texto limpio.
 */
const CLEAN_SENTENCE_TARGET = 220;

/** ¿La cadena tiene al menos un carácter de palabra (letra o número)? */
function hasWord(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

type JobStatus = 'pending' | 'fetching' | 'ready' | 'error';
/**
 * Unidad del pipeline TTS: un trozo de texto y la promesa de su audio ya en vuelo.
 * La cola guarda estos jobs EN ORDEN; la síntesis (fetch) y la reproducción están
 * desacopladas para poder prefetchear el trozo N+1 mientras suena el N. Desde Fase 2
 * el texto SIEMPRE llega ya limpio (modo ON limpia antes, vía /api/clean), así que
 * /api/tts es TTS puro: sin cabeceras de limpieza ni métricas por-job.
 */
interface AudioJob {
  seq: number; // orden monotónico de encolado
  gen: number; // generación de cancelación a la que pertenece este job
  text: string; // frase lista para sintetizar (OFF: cruda; ON: ya limpiada)
  controller: AbortController; // aborta ESTE fetch en barge-in (uno por job)
  status: JobStatus;
  blobPromise: Promise<Blob> | null; // null hasta que startFetch la crea
}
/**
 * Unidad de la etapa de LIMPIEZA (modo ON): un bloque grande de texto pendiente de
 * mandar a /api/clean. Su respuesta limpia se re-segmenta por frase hacia el
 * pipeline TTS. Se procesan EN ORDEN (worker secuencial) para no barajar el turno.
 */
interface CleanJob {
  gen: number; // generación de cancelación (barge-in lo invalida)
  text: string; // bloque a limpiar
  controller: AbortController; // aborta el fetch a /api/clean en barge-in
}

/**
 * TTS vía API con PREFETCH. Encola jobs de texto y sintetiza hasta `lookahead`
 * trozos en paralelo con POST /api/tts, guardando su audio ORDENADO. Un pump de
 * reproducción los consume en orden con un HTMLAudioElement por trozo: cuando
 * termina el trozo N, el audio de N+1 ya suele estar listo → reproduce sin hueco.
 */
export class ApiTts implements Tts {
  onStateChange?: (speaking: boolean) => void;
  onLevel?: (level: number) => void;
  onCleaning?: (state: 'start' | 'done', info?: { before: number; after: number }) => void;

  // Pipeline ORDENADO (FIFO): la reproducción consume jobs[0]; los fetches de los
  // trozos siguientes ya van en vuelo. Reemplaza la vieja cola de texto `queue`.
  private jobs: AudioJob[] = [];
  private seq = 0;
  // Segmentos emitidos desde el último stop() (= inicio de turno del agente, tras
  // el barge-in). Alimenta el ramp-up: los primeros segmentos del turno son cortos
  // (arranque de audio veloz), luego crecen (menos llamadas y mejor prosodia).
  private segCount = 0;
  // Cap de trozos con fetch en vuelo o ya listos por delante del cabezal. Acota la
  // RAM (blobs pre-buscados) y frena el prefetch solo si la reproducción se estanca.
  private readonly lookahead = 3;
  // Etapa de limpieza (modo ON): cola de bloques pendientes de /api/clean. Se
  // procesa de UNO EN UNO (worker `cleanBusy`) para emitir las frases limpias EN
  // ORDEN al pipeline TTS. Vacía en modo OFF.
  private cleanQueue: CleanJob[] = [];
  private cleanBusy = false;
  private buf = '';
  private audio: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private playing = false;
  private wasActive = false;
  // Token de cancelación: al stop() lo incrementamos para descartar fetchs en vuelo.
  private gen = 0;
  // Debounce con techo del flush con cleanup activo (modo pty). `settleTimer` se
  // reprograma en cada fragmento (dispara al fin de la ráfaga); `maxTimer` se arma
  // una sola vez con contenido pendiente y NO se reprograma (dispara cada ~3s
  // aunque el stream siga) → lectura progresiva, no "todo al final".
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  // Web Audio para medir el nivel REAL del audio TTS (alimenta el orbe).
  private actx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelData: Uint8Array<ArrayBuffer> | null = null;
  private currentSource: MediaElementAudioSourceNode | null = null;
  private meterRaf = 0;
  // Métricas por turno (Fase 6.2): llamadas + hits de caché a /api/tts y /api/clean,
  // y latencia hasta el primer audio. Se vuelcan con console.info al fin del turno
  // (transición activo→inactivo) o en barge-in. NUNCA a disco (regla anti-appendFileSync).
  private metrics = { tts: 0, ttsHit: 0, clean: 0, cleanHit: 0 };
  private turnStart = 0; // performance.now() del inicio del turno (0 = sin turno)
  private firstAudioMs = -1; // latencia al primer audio del turno (-1 = aún no suena)

  constructor(private cfg: VoiceConfig) {}

  push(text: string): void {
    // Separador entre fragmentos que llegan sueltos (pty): sin él se pegarían
    // palabras al concatenar ("…sesión.Hola"). Solo si el buf no acaba en espacio.
    if (this.buf && !/\s$/.test(this.buf)) this.buf += ' ';
    this.buf += text;
    // Motor unificado: emite segmentos completos (corte natural + ramp-up) y deja
    // el remanente incompleto en buf. Mismo camino en limpieza ON y OFF; lo que
    // cambia por modo es el tamaño objetivo (targetLen), el debounce del flush y el
    // destino del segmento (emitSegment: TTS directo en OFF, /api/clean en ON).
    this.buf = segmentText(this.buf, this.targetLen(), false, (s) => this.emitSegment(s));
  }

  /**
   * Tamaño objetivo del próximo segmento, con RAMP-UP: los primeros segmentos del
   * turno son cortos (el primer audio arranca en <1s) y crecen con cada segmento
   * emitido (menos llamadas y mejor prosodia después). En limpieza ON los tamaños
   * son mayores: cada segmento es una llamada al LLM de limpieza, así que conviene
   * más contexto por unidad.
   */
  private targetLen(): number {
    const clean = !!this.cfg.ttsClean?.enabled;
    const first = clean ? 160 : 60; // primer segmento del turno
    const cap = clean ? 900 : 240; // régimen estable
    const step = clean ? 240 : 80; // crecimiento por segmento emitido
    return Math.min(cap, first + this.segCount * step);
  }

  flush(immediate = false): void {
    // Con cleanup activo y sin flush inmediato: debounce CON TECHO. `settleTimer`
    // se reprograma en cada fragmento (dispara al fin de la ráfaga); `maxTimer` se
    // arma una vez con contenido pendiente y NO se reprograma → un flush cada
    // ~CLEAN_MAX_INTERVAL_MS aunque el stream no pare. `immediate` (el `done` de
    // rpc, fin de turno real) salta el debounce.
    if (this.cfg.ttsClean?.enabled && !immediate) {
      // Tiempos configurables (Fase 6) con fallback a los defaults del motor.
      const settleMs = this.cfg.ttsClean.settleMs ?? CLEAN_SETTLE_MS;
      const maxMs = this.cfg.ttsClean.maxMs ?? CLEAN_MAX_INTERVAL_MS;
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.timedFlush(), settleMs);
      if (!this.maxTimer && hasWord(this.buf)) {
        this.maxTimer = setTimeout(() => this.timedFlush(), maxMs);
      }
      return;
    }
    this.clearFlushTimers();
    this.doFlush();
  }

  /** Dispara un flush por timer (settle o techo) y limpia ambos timers. */
  private timedFlush(): void {
    this.clearFlushTimers();
    this.doFlush();
  }

  /** Cancela los timers de debounce del flush (fin de turno, stop, o flush ya hecho). */
  private clearFlushTimers(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
  }

  /**
   * Vacía el buf al final del turno: segmenta con `force` → emite todo lo que tenga
   * caracteres de palabra (incluido el último trozo aunque no cierre frase) y deja
   * en buf solo remanente sin palabras (puntuación/glifos), que se concatenará con
   * el próximo fragmento. Sin material hablable, es un no-op (no sintetiza vacío).
   */
  private doFlush(): void {
    this.buf = segmentText(this.buf, this.targetLen(), true, (s) => this.emitSegment(s));
  }

  /**
   * Enruta un segmento del buf al pipeline correcto según el modo y alimenta el
   * ramp-up (el siguiente bloque/segmento del turno será mayor):
   *  - ON  (limpieza): manda el BLOQUE a la etapa de limpieza (/api/clean); su
   *    salida limpia se re-segmenta por frase y se sintetiza.
   *  - OFF: encola el segmento directo al pipeline TTS.
   */
  private emitSegment(seg: string): void {
    this.segCount++; // ramp-up: cuenta bloques/segmentos emitidos en el turno
    if (this.cfg.ttsClean?.enabled) this.enqueueClean(seg);
    else this.enqueue(seg);
  }

  /** Encola un bloque para limpiar en /api/clean (modo ON), preservando el orden. */
  private enqueueClean(text: string): void {
    if (this.turnStart === 0) this.turnStart = performance.now(); // inicio de turno (métricas)
    this.cleanQueue.push({ gen: this.gen, text, controller: new AbortController() });
    this.notify(); // mantiene el orbe activo durante la limpieza
    void this.pumpClean();
  }

  /**
   * Worker de limpieza: procesa el cabezal de `cleanQueue` de UNO EN UNO (en orden),
   * manda el bloque a /api/clean y, con la respuesta limpia, la re-segmenta por frase
   * encolándola al pipeline TTS (que la cachea, Fase 1). La UX "limpiando" (onCleaning)
   * se ata a ESTE fetch, no al TTS. Mismas guardas por generación que pumpPlayback: un
   * barge-in (stop → gen++) invalida el trabajo en vuelo sin tocar el estado ya reseteado.
   */
  private async pumpClean(): Promise<void> {
    if (this.cleanBusy) return;
    const job = this.cleanQueue[0];
    if (!job) {
      this.notify();
      return;
    }
    this.cleanBusy = true;
    this.notify();
    const myGen = this.gen;
    this.onCleaning?.('start');
    try {
      const res = await fetch(`${this.cfg.apiBaseUrl}/api/clean`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cleanHeaders(this.cfg.ttsClean) },
        body: JSON.stringify({ text: job.text }),
        signal: job.controller.signal,
      });
      if (myGen !== this.gen) return; // barge-in mientras limpiaba → estado ya reseteado
      this.metrics.clean++;
      if (res.headers.get('x-clean-cache') === 'hit') this.metrics.cleanHit++;
      let clean = job.text; // fallback: si algo va raro, se habla el original
      let metrics: { before: number; after: number } | undefined;
      if (res.ok) {
        const data = (await res.json()) as { clean?: string; before?: number; after?: number };
        if (myGen !== this.gen) return;
        if (data.clean) clean = data.clean;
        const b = Number(data.before);
        const a = Number(data.after);
        if (Number.isFinite(b) && Number.isFinite(a) && b > 0 && a > 0) metrics = { before: b, after: a };
      }
      this.cleanQueue.shift(); // consume el cabezal (en orden)
      this.onCleaning?.('done', metrics);
      this.emitCleanSentences(clean);
      this.cleanBusy = false;
      void this.pumpClean(); // siguiente bloque
    } catch {
      if (myGen !== this.gen) return; // barge-in / abort → estado ya reseteado por stop()
      // Falló la limpieza (red/timeout): se habla el original para no perder información.
      this.cleanQueue.shift();
      this.onCleaning?.('done');
      this.emitCleanSentences(job.text);
      this.cleanBusy = false;
      void this.pumpClean();
    }
  }

  /** Re-segmenta el texto YA LIMPIO por frase y encola cada frase al pipeline TTS. */
  private emitCleanSentences(clean: string): void {
    segmentText(clean, CLEAN_SENTENCE_TARGET, true, (s) => this.enqueue(s));
  }

  stop(): void {
    this.gen++;
    // Aborta TODOS los fetches en vuelo del pipeline (no solo uno). El chequeo
    // `myGen !== this.gen` tras cada await sigue siendo la guarda lógica principal;
    // abortar es el complemento para cortar las requests de red cuanto antes.
    for (const job of this.jobs) {
      try {
        job.controller.abort();
      } catch {
        /* ya abortado */
      }
    }
    // Aborta también los fetches de limpieza en vuelo y vacía su cola (barge-in).
    for (const cj of this.cleanQueue) {
      try {
        cj.controller.abort();
      } catch {
        /* ya abortado */
      }
    }
    this.jobs = [];
    this.cleanQueue = [];
    this.cleanBusy = false;
    this.buf = '';
    this.segCount = 0; // nuevo turno → reinicia el ramp-up
    this.clearFlushTimers();
    this.playing = false;
    this.stopMeter();
    this.disconnectSource();
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    this.revokeUrl();
    this.notify();
  }

  private enqueue(text: string): void {
    if (!text) return;
    if (this.turnStart === 0) this.turnStart = performance.now(); // inicio de turno (métricas)
    const job: AudioJob = {
      seq: this.seq++,
      gen: this.gen, // si stop() cambia gen, este job quedará invalidado
      text,
      controller: new AbortController(),
      status: 'pending',
      blobPromise: null,
    };
    this.jobs.push(job);
    this.notify();
    this.pumpPrefetch(); // arranca su fetch si hay cupo en la ventana de prefetch
    void this.pumpPlayback(); // arranca la reproducción si no hay nada sonando
  }

  /** Cabeceras del POST /api/tts (comunes a todos los jobs). TTS puro: la limpieza
   *  (modo ON) ya ocurrió en /api/clean, así que aquí NO van cabeceras x-voice-clean-*. */
  private buildTtsHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...apiHeaders(this.cfg.ttsApi),
      // x-voice-lang: deja que MiniMax fuerce la pronunciación según el idioma
      // configurado (es-ES → Spanish). Otros proveedores lo ignoran.
      'x-voice-lang': this.cfg.lang,
    };
  }

  /** Lanza el fetch de un job y guarda su promesa de audio (sin reproducir aún). */
  private startFetch(job: AudioJob): void {
    job.status = 'fetching';
    job.blobPromise = (async (): Promise<Blob> => {
      const res = await fetch(`${this.cfg.apiBaseUrl}/api/tts`, {
        method: 'POST',
        headers: this.buildTtsHeaders(),
        body: JSON.stringify({ text: job.text }),
        signal: job.controller.signal,
      });
      if (job.gen !== this.gen) throw new Error('cancelado'); // barge-in mientras sintetizaba
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`TTS ${res.status} ${detail.slice(0, 240)}`);
      }
      this.metrics.tts++;
      if (res.headers.get('x-tts-cache') === 'hit') this.metrics.ttsHit++;
      const blob = await res.blob();
      if (job.gen !== this.gen) throw new Error('cancelado');
      job.status = 'ready';
      return blob;
    })();
    // Un 'ready' NO libera cupo (sigue ocupado hasta consumirse); un 'error' sí,
    // así que en ambos casos re-evaluamos el prefetch por si hay que arrancar otro.
    job.blobPromise
      .then(() => this.pumpPrefetch())
      .catch(() => {
        job.status = 'error';
        this.pumpPrefetch();
      });
  }

  /**
   * Rellena la ventana de prefetch: arranca fetches de los jobs 'pending' EN ORDEN
   * mientras haya menos de `lookahead` con fetch en vuelo o ya listos por delante.
   * Como recorre desde el cabezal, el trozo que se reproducirá antes se sintetiza
   * primero; el desorden de red queda absorbido por el orden de `jobs`.
   */
  private pumpPrefetch(): void {
    let active = this.jobs.filter((j) => j.status === 'fetching' || j.status === 'ready').length;
    for (const job of this.jobs) {
      if (active >= this.lookahead) break;
      if (job.status === 'pending') {
        this.startFetch(job);
        active++;
      }
    }
  }

  /**
   * Pump de reproducción: consume jobs EN ORDEN, uno a la vez (mutex `playing`).
   * `await job.blobPromise` resuelve al instante si el trozo ya se prefetcheó
   * mientras sonaba el anterior → reproducción encadenada sin hueco de red.
   */
  private async pumpPlayback(): Promise<void> {
    if (this.playing) return;
    const job = this.jobs[0];
    if (!job) {
      this.notify();
      return;
    }
    if (job.status === 'pending') this.pumpPrefetch(); // por si aún no arrancó su fetch
    this.playing = true;
    this.notify();
    const myGen = this.gen;
    try {
      const blob = await job.blobPromise!;
      if (myGen !== this.gen) return; // cancelado mientras esperaba el blob
      this.jobs.shift(); // consume el cabezal
      this.pumpPrefetch(); // liberó un slot → arranca el siguiente pending

      // Crea el <audio> AQUÍ (no en el fetch): createMediaElementSource solo puede
      // llamarse UNA vez por elemento, así que cada trozo estrena su propio Audio.
      this.revokeUrl();
      this.currentUrl = URL.createObjectURL(blob);
      const audio = new Audio(this.currentUrl);
      this.audio = audio;
      const cont = () => {
        if (myGen !== this.gen) return;
        this.playing = false;
        this.stopMeter();
        this.disconnectSource();
        // El blob del siguiente trozo ya suele estar 'ready' → arranca sin hueco.
        void this.pumpPlayback();
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
      // Latencia al primer audio del turno (métricas Fase 6.2).
      if (this.firstAudioMs < 0 && this.turnStart > 0) {
        this.firstAudioMs = performance.now() - this.turnStart;
      }
      // Engancha el medidor de nivel después, sin bloquear (mejor esfuerzo).
      if (this.onLevel) void this.attachMeter(audio);
    } catch (e) {
      // Fetch fallido o abortado (barge-in): descartamos el job del cabezal y
      // seguimos con el siguiente para no bloquear la cola.
      if (this.jobs[0] === job) this.jobs.shift();
      this.pumpPrefetch();
      this.playing = false;
      if (myGen !== this.gen) return;
      console.warn('[TTS] job fallido:', e instanceof Error ? e.message : e);
      void this.pumpPlayback();
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
    // Activo también mientras hay limpieza en vuelo (modo ON): el orbe no debe
    // apagarse en el hueco entre el fin del stream y la llegada del audio limpio.
    const active =
      this.playing || this.jobs.length > 0 || this.cleanBusy || this.cleanQueue.length > 0;
    if (active !== this.wasActive) {
      this.wasActive = active;
      if (!active) this.logMetrics(); // fin de turno (o barge-in) → vuelca métricas
      this.onStateChange?.(active);
    }
  }

  /** Vuelca las métricas del turno a console.info (estructurado) y las reinicia. */
  private logMetrics(): void {
    const m = this.metrics;
    if (m.tts > 0 || m.clean > 0) {
      const hitPct = (h: number, n: number) => (n > 0 ? Math.round((h / n) * 100) : 0);
      console.info('[voz] turno', {
        ttsCalls: m.tts,
        ttsCacheHitPct: hitPct(m.ttsHit, m.tts),
        cleanCalls: m.clean,
        cleanCacheHitPct: hitPct(m.cleanHit, m.clean),
        primerAudioMs: this.firstAudioMs >= 0 ? Math.round(this.firstAudioMs) : null,
      });
    }
    this.resetMetrics();
  }

  private resetMetrics(): void {
    this.metrics = { tts: 0, ttsHit: 0, clean: 0, cleanHit: 0 };
    this.turnStart = 0;
    this.firstAudioMs = -1;
  }
}
