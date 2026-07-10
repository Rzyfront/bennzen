import { Bridge, newSectionId, type UiSection } from './sections';
import { TermView } from './terminal';
import { OrbParticles } from './orb-particles';
import {
  MicMeter,
  createTts,
  startStt,
  type Tts,
  type SttSession,
  type VoiceConfig,
  type VoiceEngine,
  type VoiceFormat,
  type VoiceApiSettings,
  type CleanSettings,
} from './voice';
import { applyDelta, pushUser, formatEntry } from '../shared/transcript';
import type { AgentKind, PermMode, SectionKind } from '../shared/protocol';
import claudeLogo from './assets/agents/claude.png';
import codexLogo from './assets/agents/codex.webp';
import opencodeLogo from './assets/agents/opencode.png';

// Logo real por agente (mock no tiene → cae a la inicial). Vite los empaqueta.
const AGENT_LOGO: Partial<Record<AgentKind, string>> = {
  claude: claudeLogo,
  codex: codexLogo,
  opencode: opencodeLogo,
};

const WS_URL = `ws://${location.hostname}:4319`;
const API_BASE = `http://${location.hostname}:4319`;
const HINT = 'Mantén espacio para hablar';

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`No existe ${sel}`);
  return el;
};

const sections = new Map<string, UiSection>();
let activeId: string | null = null;

const bridge = new Bridge(WS_URL);

// ---- Configuración de voz (localStorage; .env del server = fallback) -----
// La config completa (motor + proveedor + endpoint + key + modelo + voz) vive
// en localStorage y se edita en el modal. Se envía por cabeceras x-voice-* al
// proxy; si falta, el server cae a su .env.
interface StoredVoice {
  stt: VoiceEngine;
  tts: VoiceEngine;
  lang: string;
  sttApi: VoiceApiSettings;
  ttsApi: VoiceApiSettings;
  ttsClean: CleanSettings;
}

const STORE_KEY = 'voice.config.v2';

function defaultStored(): StoredVoice {
  return {
    stt: 'browser',
    tts: 'browser',
    lang: 'es-ES',
    sttApi: { format: 'openai', url: '', key: '', model: 'whisper-1' },
    ttsApi: { format: 'openai', url: '', key: '', model: 'tts-1', voice: 'alloy', speed: 1.3 },
    ttsClean: { enabled: false, format: 'minimax', url: '', key: '', model: '', prompt: '' },
  };
}

function loadStored(): StoredVoice {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<StoredVoice>;
      const d = defaultStored();
      return {
        ...d,
        ...p,
        sttApi: { ...d.sttApi, ...p.sttApi },
        ttsApi: { ...d.ttsApi, ...p.ttsApi },
        // Migración suave: ttsClean puede no existir en configs viejas → cae al default.
        ttsClean: { ...d.ttsClean, ...(p.ttsClean ?? {}) },
      };
    }
  } catch {
    /* json corrupto → defaults */
  }
  // Migración suave de las claves viejas (voice.stt / voice.tts).
  const d = defaultStored();
  if (localStorage.getItem('voice.stt') === 'api') d.stt = 'api';
  if (localStorage.getItem('voice.tts') === 'api') d.tts = 'api';
  return d;
}

/** ¿La config de API está completa para usarse? (openai/groq/minimax necesitan key; genérico, url) */
function apiReady(s: VoiceApiSettings): boolean {
  return s.format === 'openai' || s.format === 'groq' || s.format === 'minimax' ? !!s.key : !!s.url;
}

// Disponibilidad del fallback .env (la rellena /api/voice-config). Incluye
// `cleanup` (¿hay .env de limpieza?) y `cleanupPrompt` (prompt default del server,
// visible/editable en el modal si el usuario no puso uno propio).
let serverVoice = { stt: false, tts: false, lang: 'es-ES', cleanup: false, cleanupPrompt: '' };

let stored = loadStored();
let voiceCfg: VoiceConfig = { ...stored, apiBaseUrl: API_BASE };

// TTS activo (se recrea al guardar ajustes).
let tts: Tts = createTts(voiceCfg.tts, voiceCfg);
let muted = false;

const orb = $('#orb');
new OrbParticles(orb); // halo de partículas reactivo a la voz (lee clase/--level del orbe)
const vhint = $('#vhint');
const talkBtn = $<HTMLButtonElement>('#talk');
const muteBtn = $<HTMLButtonElement>('#mute');
const textInput = $<HTMLInputElement>('#text');
const overlay = $('#settings');
const meter = new MicMeter((lvl) => orb.style.setProperty('--level', String(lvl)));

// ---- Estado del orbe -----------------------------------------------------
type OrbState = 'idle' | 'listening' | 'speaking' | 'cleaning';
let listening = false;

function setOrb(state: OrbState): void {
  orb.className = `orb ${state}`;
  if (state !== 'listening') orb.style.setProperty('--level', '0');
}

function wireTtsState(t: Tts): void {
  t.onStateChange = (speaking) => {
    if (!listening) setOrb(speaking ? 'speaking' : 'idle');
  };
  // Nivel REAL del audio TTS (solo ApiTts) → alimenta --level mientras habla,
  // igual que MicMeter al escuchar. Así el orbe reacciona al audio del agente.
  t.onLevel = (lvl) => {
    if (!listening) orb.style.setProperty('--level', String(lvl));
  };
  // Limpieza server-side (solo ApiTts con ttsClean.enabled): el proxy limpia el
  // texto con un LLM antes de sintetizar. Como es invisible en Network, lo
  // reflejamos en el orbe (estado 'cleaning') y en la pista (vhint).
  t.onCleaning = (state, info) => {
    if (listening) return; // no pisar el estado de escucha del usuario
    if (state === 'start') {
      setOrb('cleaning');
      vhint.textContent = '🧹 Limpiando texto…';
    } else {
      // 'done': el cleanup terminó y el audio va a sonar YA. Forzamos el orbe a
      // 'speaking' porque onStateChange(true) se disparó ANTES del 'start' (en
      // enqueue) y no vuelve a dispararse sin transición → sin esto el orbe se
      // quedaría en turquesa 'cleaning' toda la reproducción.
      setOrb('speaking');
      // Contador breve del ratio de compactación si el proxy expuso las métricas.
      if (info && info.before > 0) {
        const pct = Math.round((1 - info.after / info.before) * 100);
        const sign = pct >= 0 ? '−' : '+';
        vhint.textContent = `🧹 ${info.before}→${info.after} ${sign}${Math.abs(pct)}%`;
        // Restaura la pista normal tras unos segundos, solo si nadie escribió algo
        // más reciente (error, pista de escucha, etc.) — comparamos el texto mostrado.
        const shown = vhint.textContent;
        setTimeout(() => { if (vhint.textContent === shown) vhint.textContent = HINT; }, 3500);
      } else {
        vhint.textContent = '🧹 Texto limpiado';
        const shown = vhint.textContent;
        setTimeout(() => { if (vhint.textContent === shown) vhint.textContent = HINT; }, 2000);
      }
    }
  };
}
wireTtsState(tts);

/** Habla un texto si la voz no está silenciada. */
function speak(text: string, andFlush = false): void {
  if (muted) return;
  tts.push(text);
  if (andFlush) tts.flush();
}

// ---- Conexión ------------------------------------------------------------
const statusEl = $('#status');
bridge.onStatus((connected) => {
  // Estado REAL del socket: si el orquestador se reinicia (tsx watch), el
  // Bridge reconecta solo y esto vuelve a ✓ sin recargar la página.
  statusEl.textContent = connected ? '● conectado' : '○ reconectando…';
  statusEl.className = connected ? 'ok' : 'off';
});

// ---- Mensajes del orquestador -------------------------------------------
bridge.on((m) => {
  if (m.t === 'snapshot') {
    // Estado COMPLETO del orquestador → restaura todas las sesiones (tras refresh).
    const incoming = new Set(m.sessions.map((s) => s.sectionId));
    for (const info of m.sessions) {
      const ex = sections.get(info.sectionId);
      if (ex) {
        ex.ready = info.ready;
        if (info.kind === 'rpc') ex.entries = info.transcript;
        if (info.kind === 'pty') {
          ex.cols = info.cols;
          ex.rows = info.rows;
          // Scrollback: si la TermView ya está viva la repintamos; si no, lo dejamos pendiente.
          if (info.scrollback) {
            if (ex.term) {
              ex.term.clear();
              ex.term.write(info.scrollback);
            } else {
              ex.pendingScrollback = info.scrollback;
            }
          }
        }
      } else {
        sections.set(info.sectionId, {
          sectionId: info.sectionId,
          agent: info.agent,
          mode: info.mode,
          cwd: info.cwd,
          ready: info.ready,
          kind: info.kind,
          entries: info.transcript ?? [],
          cols: info.cols,
          rows: info.rows,
          pendingScrollback: info.scrollback,
        });
      }
    }
    for (const id of [...sections.keys()]) {
      if (!incoming.has(id)) {
        sections.get(id)?.term?.dispose();
        sections.delete(id);
      }
    }
    if (!activeId || !sections.has(activeId)) {
      activeId = sections.keys().next().value ?? null;
    }
    render();
  } else if (m.t === 'created') {
    const s = sections.get(m.sectionId);
    if (s) s.ready = true;
    render();
  } else if (m.t === 'delta') {
    const s = sections.get(m.sectionId);
    if (!s) return;
    applyDelta(s.entries, m.delta);
    if (m.sectionId === activeId) {
      if (m.delta.type === 'text') speak(m.delta.text);
      // 'done' de rpc = fin de turno real → flush inmediato (salta el debounce).
      else if (m.delta.type === 'done') tts.flush(true);
    }
    render();
  } else if (m.t === 'term-data') {
    const s = sections.get(m.sectionId);
    if (!s) return;
    if (s.term) {
      s.term.write(m.data);
    } else {
      // Sección pty no activa (sin TermView montada): acumula para pintar al activar.
      s.pendingTermData = (s.pendingTermData ?? '') + m.data;
    }
  } else if (m.t === 'speak') {
    if (m.sectionId === activeId) speak(m.text, true);
  } else if (m.t === 'error') {
    const s = m.sectionId ? sections.get(m.sectionId) : undefined;
    if (s) s.entries.push({ role: 'error', text: m.message });
    else vhint.textContent = `⚠️ ${m.message}`;
    render();
  }
});

// ---- Crear / cerrar sección ---------------------------------------------
// El formulario vive en un modal; el sidebar solo lista las secciones.
const newSectionOverlay = $('#new-section-modal');
function openNewSection(): void {
  renderProfiles(); // refresca la lista de perfiles guardados cada vez que se abre
  newSectionOverlay.hidden = false;
}
function closeNewSection(): void {
  newSectionOverlay.hidden = true;
}
$('#new-section').addEventListener('click', openNewSection);
$('#ns-close').addEventListener('click', closeNewSection);
$('#ns-cancel').addEventListener('click', closeNewSection);
newSectionOverlay.addEventListener('click', (e) => {
  if (e.target === newSectionOverlay) closeNewSection(); // clic en el backdrop
});

/** Crea una sección (desde el form manual o desde un perfil) y la activa. */
function createSection(agent: AgentKind, mode: PermMode, kind: SectionKind, cwd: string): void {
  const sectionId = newSectionId();
  const s: UiSection = { sectionId, agent, mode, cwd, ready: false, kind, entries: [] };
  sections.set(sectionId, s);
  activeId = sectionId;
  closeNewSection();

  if (kind === 'pty') {
    // Montamos la TermView primero para medir cols/rows reales y crear con esa geometría.
    render(); // hace visible el contenedor de terminal
    mountTerm(s);
    bridge.create(sectionId, agent, mode, cwd, kind, s.cols ?? 80, s.rows ?? 24);
  } else {
    bridge.create(sectionId, agent, mode, cwd, kind);
    render();
  }
}

$('#ns-create').addEventListener('click', () => {
  createSection(
    $<HTMLSelectElement>('#agent').value as AgentKind,
    $<HTMLSelectElement>('#mode').value as PermMode,
    $<HTMLSelectElement>('#kind').value as SectionKind,
    $<HTMLInputElement>('#cwd').value.trim() || '.',
  );
});

// ---- Perfiles preseteados (localStorage) --------------------------------
// Un perfil congela {agente, modo, tipo, cwd} para crear sesiones de 1 clic.
interface Profile {
  id: string;
  name: string;
  agent: AgentKind;
  mode: PermMode;
  kind: SectionKind;
  cwd: string;
}
const PROFILES_KEY = 'bennzen.profiles.v1';

function loadProfiles(): Profile[] {
  try {
    const arr = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '[]');
    return Array.isArray(arr) ? (arr as Profile[]) : [];
  } catch {
    return [];
  }
}
function persistProfiles(): void {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}
let profiles: Profile[] = loadProfiles();

/** Pinta la lista de perfiles guardados dentro del modal de nueva sección. */
function renderProfiles(): void {
  const ul = $('#profiles-list');
  ul.innerHTML = '';
  if (profiles.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'profiles-empty';
    empty.textContent = 'Sin perfiles. Configura abajo y guarda con 💾.';
    ul.appendChild(empty);
    return;
  }
  for (const p of profiles) {
    const li = document.createElement('li');
    li.className = 'profile';
    li.title = `Crear sesión: ${p.agent} · ${p.kind} · ${p.mode} · ${p.cwd}`;

    const logo = AGENT_LOGO[p.agent];
    if (logo) {
      const img = document.createElement('img');
      img.className = 'profile-avatar';
      img.src = logo;
      img.alt = p.agent;
      li.appendChild(img);
    } else {
      const sp = document.createElement('span');
      sp.className = 'profile-avatar profile-avatar-fallback';
      sp.textContent = p.agent.slice(0, 1);
      li.appendChild(sp);
    }

    const info = document.createElement('span');
    info.className = 'profile-main';
    const name = document.createElement('span');
    name.className = 'profile-name';
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'profile-meta';
    meta.textContent = `${p.agent} · ${p.kind === 'pty' ? 'TUI' : 'chat'} · ${p.mode}`;
    info.append(name, meta);

    const del = document.createElement('button');
    del.className = 'profile-del';
    del.textContent = '✕';
    del.title = 'Eliminar perfil';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      profiles = profiles.filter((x) => x.id !== p.id);
      persistProfiles();
      renderProfiles();
    });

    // La fila entera lanza la sesión preconfigurada.
    li.addEventListener('click', () => createSection(p.agent, p.mode, p.kind, p.cwd));

    li.append(info, del);
    ul.appendChild(li);
  }
}

// Guarda la configuración actual del form como un perfil nuevo.
$('#ns-save-profile').addEventListener('click', () => {
  const agent = $<HTMLSelectElement>('#agent').value as AgentKind;
  const mode = $<HTMLSelectElement>('#mode').value as PermMode;
  const kind = $<HTMLSelectElement>('#kind').value as SectionKind;
  const cwd = $<HTMLInputElement>('#cwd').value.trim() || '.';
  const name = prompt('Nombre del perfil:', `${agent} ${kind === 'pty' ? 'TUI' : 'chat'}`)?.trim();
  if (!name) return;
  profiles.push({ id: newSectionId(), name, agent, mode, kind, cwd });
  persistProfiles();
  renderProfiles();
});

function closeSection(sectionId: string): void {
  bridge.close(sectionId); // backend hace teardown del agente (sin huérfanos)
  const s = sections.get(sectionId);
  s?.term?.dispose();
  sections.delete(sectionId);
  if (activeId === sectionId) {
    tts.stop();
    activeId = sections.keys().next().value ?? null;
  }
  render();
}

// ---- Terminal (modo pty) -------------------------------------------------
const termEl = $('#term');

/** Crea/monta la TermView de una sección pty en el contenedor compartido. */
function mountTerm(s: UiSection): void {
  if (s.term) return;
  const term = new TermView(
    termEl,
    (data) => bridge.termInput(s.sectionId, data), // teclas → PTY stdin
    (cols, rows) => {
      s.cols = cols;
      s.rows = rows;
      // Solo informamos al server una vez que la sección está lista en el backend.
      if (s.ready) bridge.termResize(s.sectionId, cols, rows);
    },
  );
  s.term = term;
  s.cols = term.cols;
  s.rows = term.rows;

  // Reproduce primero el scrollback persistido (snapshot) y luego lo acumulado.
  if (s.pendingScrollback) {
    term.write(s.pendingScrollback);
    s.pendingScrollback = undefined;
  }
  if (s.pendingTermData) {
    term.write(s.pendingTermData);
    s.pendingTermData = undefined;
  }
  term.focus();
}

// ---- Hablar (push-to-talk) ----------------------------------------------
let stt: SttSession | null = null;

function startTalk(): void {
  if (listening) return;
  if (!overlay.hidden || !newSectionOverlay.hidden) return; // un modal abierto → no capturar voz
  if (!activeId) {
    alert('Crea o elige una sección primero.');
    return;
  }
  listening = true;
  tts.stop(); // barge-in: corta al agente si estaba hablando
  setOrb('listening');
  talkBtn.classList.add('active');
  void meter.start().catch(() => {
    /* micro denegado: seguimos sin halo reactivo */
  });

  try {
    stt = startStt(voiceCfg.stt, voiceCfg, {
      onInterim: (t) => (vhint.textContent = `🎙 ${t}`),
      onFinal: (t) => submit(t),
      onError: (msg) => {
        vhint.textContent = `⚠️ ${msg}`;
        console.warn('[voz]', msg);
      },
      onEnd: () => {
        listening = false;
        meter.stop();
        talkBtn.classList.remove('active');
        // No pisar un mensaje de error con el hint por defecto.
        if (!vhint.textContent?.startsWith('⚠️')) vhint.textContent = HINT;
        setOrb('idle');
      },
    });
  } catch (e) {
    listening = false;
    talkBtn.classList.remove('active');
    meter.stop();
    setOrb('idle');
    alert(e instanceof Error ? e.message : String(e));
  }
}

function stopTalk(): void {
  if (!listening) return;
  stt?.stop(); // onEnd hace la limpieza
}

const isTyping = () => {
  const el = document.activeElement;
  // El xterm coloca el foco en un textarea oculto: no robamos el espacio en pty.
  return !!el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
};
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !isTyping()) {
    e.preventDefault();
    startTalk();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !isTyping()) {
    e.preventDefault();
    stopTalk();
  }
});

talkBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  startTalk();
});
talkBtn.addEventListener('pointerup', () => stopTalk());
talkBtn.addEventListener('pointerleave', () => stopTalk());
talkBtn.addEventListener('pointercancel', () => stopTalk());

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const input = e.target as HTMLInputElement;
    if (input.value.trim()) submit(input.value.trim());
    input.value = '';
  }
});

/** Enruta el texto dictado/escrito según el tipo de la sección activa. */
function submit(text: string): void {
  if (!activeId) return;
  const s = sections.get(activeId);
  if (!s) return;
  if (s.kind === 'pty') {
    // La TUI eco-eará el texto en el terminal; mostramos confirmación en la voz.
    vhint.textContent = `↵ enviado: ${text}`;
    // Texto y Enter en escrituras SEPARADAS: muchas TUIs (codex) detectan "paste"
    // por temporización y un \r pegado al texto se inserta como salto de línea en
    // vez de enviar. Mandar el \r aparte = Enter discreto → la TUI sí envía.
    bridge.termInput(s.sectionId, text);
    setTimeout(() => bridge.termInput(s.sectionId, '\r'), 50);
  } else {
    pushUser(s.entries, text);
    bridge.say(activeId, text);
    render();
  }
}

// ---- Mute (silenciar voz del agente) ------------------------------------
muteBtn.addEventListener('click', () => {
  muted = !muted;
  if (muted) tts.stop();
  muteBtn.textContent = muted ? '🔇' : '🔊';
  muteBtn.classList.toggle('active', muted);
});

// ---- Ajustes de voz (modal + localStorage) -------------------------------
const noteEl = $('#voice-config-note');
const el = {
  sttEngine: $<HTMLSelectElement>('#stt-engine'),
  sttApi: $('#stt-api'),
  sttProvider: $<HTMLSelectElement>('#stt-provider'),
  sttUrl: $<HTMLInputElement>('#stt-url'),
  sttKey: $<HTMLInputElement>('#stt-key'),
  sttModel: $<HTMLInputElement>('#stt-model'),
  ttsEngine: $<HTMLSelectElement>('#tts-engine'),
  ttsApi: $('#tts-api'),
  ttsProvider: $<HTMLSelectElement>('#tts-provider'),
  ttsUrl: $<HTMLInputElement>('#tts-url'),
  ttsKey: $<HTMLInputElement>('#tts-key'),
  ttsModel: $<HTMLInputElement>('#tts-model'),
  ttsVoice: $<HTMLInputElement>('#tts-voice'),
  ttsSpeed: $<HTMLInputElement>('#tts-speed'),
  lang: $<HTMLInputElement>('#voice-lang'),
  // Proxy de limpieza de texto (opcional).
  cleanEnabled: $<HTMLInputElement>('#clean-enabled'),
  cleanApi: $('#clean-api'),
  cleanProvider: $<HTMLSelectElement>('#clean-provider'),
  cleanUrl: $<HTMLInputElement>('#clean-url'),
  cleanKey: $<HTMLInputElement>('#clean-key'),
  cleanModel: $<HTMLInputElement>('#clean-model'),
  cleanPrompt: $<HTMLTextAreaElement>('#clean-prompt'),
};

/** Muestra los campos de API solo cuando el motor correspondiente es 'api'. */
function toggleApiFields(): void {
  el.sttApi.hidden = el.sttEngine.value !== 'api';
  el.ttsApi.hidden = el.ttsEngine.value !== 'api';
  // La limpieza es independiente del motor TTS: se muestra si su checkbox está on.
  el.cleanApi.hidden = !el.cleanEnabled.checked;
}

function renderNote(): void {
  noteEl.textContent = `Fallback .env → STT ${serverVoice.stt ? '✓' : '✗'} · TTS ${serverVoice.tts ? '✓' : '✗'} · Limpieza ${serverVoice.cleanup ? '✓' : '✗'}`;
}

/** Vuelca la config guardada a los campos del modal. */
function populateModal(): void {
  el.sttEngine.value = stored.stt;
  el.sttProvider.value = stored.sttApi.format;
  el.sttUrl.value = stored.sttApi.url;
  el.sttKey.value = stored.sttApi.key;
  el.sttModel.value = stored.sttApi.model;
  el.ttsEngine.value = stored.tts;
  el.ttsProvider.value = stored.ttsApi.format;
  el.ttsUrl.value = stored.ttsApi.url;
  el.ttsKey.value = stored.ttsApi.key;
  el.ttsModel.value = stored.ttsApi.model;
  el.ttsVoice.value = stored.ttsApi.voice ?? '';
  el.ttsSpeed.value = String(stored.ttsApi.speed ?? 1);
  el.lang.value = stored.lang;
  // Proxy de limpieza: vuelca la config guardada y muestra/oculta sus campos.
  el.cleanEnabled.checked = stored.ttsClean.enabled;
  el.cleanApi.hidden = !stored.ttsClean.enabled;
  el.cleanProvider.value = stored.ttsClean.format;
  el.cleanUrl.value = stored.ttsClean.url;
  el.cleanKey.value = stored.ttsClean.key;
  el.cleanModel.value = stored.ttsClean.model;
  // Prompt: si el usuario tiene uno propio, se muestra (editable). Si está vacío Y
  // el server ya publicó un cleanupPrompt, lo ponemos como valor visible/editable
  // para que el usuario vea el default y pueda editarlo o vaciarlo (vacío = server).
  el.cleanPrompt.value = stored.ttsClean.prompt || (serverVoice.cleanupPrompt || '');
  toggleApiFields();
  renderNote();
}

/** Lee los campos del modal a un objeto de config. */
function readModal(): StoredVoice {
  return {
    stt: el.sttEngine.value as VoiceEngine,
    tts: el.ttsEngine.value as VoiceEngine,
    lang: el.lang.value.trim() || 'es-ES',
    sttApi: {
      format: el.sttProvider.value as VoiceFormat,
      url: el.sttUrl.value.trim(),
      key: el.sttKey.value.trim(),
      model: el.sttModel.value.trim() || 'whisper-1',
    },
    ttsApi: {
      format: el.ttsProvider.value as VoiceFormat,
      url: el.ttsUrl.value.trim(),
      key: el.ttsKey.value.trim(),
      model: el.ttsModel.value.trim() || 'tts-1',
      voice: el.ttsVoice.value.trim() || 'alloy',
      speed: clampSpeed(el.ttsSpeed.value),
    },
    ttsClean: {
      enabled: el.cleanEnabled.checked,
      format: el.cleanProvider.value as 'openai' | 'minimax',
      url: el.cleanUrl.value.trim(),
      key: el.cleanKey.value.trim(),
      model: el.cleanModel.value.trim(),
      prompt: el.cleanPrompt.value.trim(),
    },
  };
}

/** Velocidad TTS válida (0.25–4.0); por defecto 1. */
function clampSpeed(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(4, Math.max(0.25, n));
}

el.sttEngine.addEventListener('change', toggleApiFields);
el.ttsEngine.addEventListener('change', toggleApiFields);
el.cleanEnabled.addEventListener('change', toggleApiFields);
el.sttProvider.addEventListener('change', () => {
  const v = el.sttProvider.value;
  if (v === 'openai' && !el.sttModel.value) el.sttModel.value = 'whisper-1';
  // Groq es un preset OpenAI-compatible: rellenamos URL base y modelo por defecto,
  // sin pisar una config custom del usuario (solo si está vacía o era el default de openai).
  if (v === 'groq') {
    if (!el.sttUrl.value || el.sttUrl.value === 'https://api.openai.com/v1') {
      el.sttUrl.value = 'https://api.groq.com/openai/v1';
    }
    if (!el.sttModel.value || el.sttModel.value === 'whisper-1') {
      el.sttModel.value = 'whisper-large-v3-turbo';
    }
  }
});
el.ttsProvider.addEventListener('change', () => {
  const v = el.ttsProvider.value;
  if (v === 'openai') {
    if (!el.ttsModel.value) el.ttsModel.value = 'tts-1';
    if (!el.ttsVoice.value) el.ttsVoice.value = 'alloy';
  }
  // MiniMax T2A: preset propio (no OpenAI-compatible). Rellenamos URL, modelo y voz
  // por defecto sin pisar una config custom (solo si está vacía o era un valor de openai).
  // El URL es crítico: si queda el de OpenAI (https://api.openai.com/v1) el proxy mandaría
  // el body de MiniMax a OpenAI → error → silencio.
  if (v === 'minimax') {
    if (!el.ttsUrl.value || el.ttsUrl.value === 'https://api.openai.com/v1') {
      el.ttsUrl.value = 'https://api.minimax.io/v1/t2a_v2';
    }
    if (!el.ttsModel.value || el.ttsModel.value === 'tts-1') el.ttsModel.value = 'speech-2.8-hd';
    if (!el.ttsVoice.value || el.ttsVoice.value === 'alloy') el.ttsVoice.value = 'English_expressive_narrator';
  }
});
// Proveedor de limpieza: MiniMax (chatcompletion_v2, rápido, sin reasoning) u
// OpenAI-compatible (OpenRouter/Groq/Ollama). Rellenamos URL y modelo por defecto
// sin pisar una config custom del usuario (solo si está vacía o era el default del otro).
el.cleanProvider.addEventListener('change', () => {
  const v = el.cleanProvider.value;
  if (v === 'minimax') {
    if (!el.cleanUrl.value || el.cleanUrl.value === 'https://openrouter.ai/api/v1' || el.cleanUrl.value === 'https://openrouter.ai/api/v1/chat/completions') {
      el.cleanUrl.value = 'https://api.minimax.io/v1/text/chatcompletion_v2';
    }
    if (!el.cleanModel.value || el.cleanModel.value.includes('/')) el.cleanModel.value = 'MiniMax-Text-01';
  } else {
    if (!el.cleanUrl.value || el.cleanUrl.value === 'https://api.minimax.io/v1/text/chatcompletion_v2') {
      el.cleanUrl.value = 'https://openrouter.ai/api/v1';
    }
  }
});

function openSettings(): void {
  populateModal();
  overlay.hidden = false;
}
function closeSettings(): void {
  overlay.hidden = true;
}
$('#open-settings').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-cancel').addEventListener('click', closeSettings);
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeSettings(); // clic en el backdrop
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!overlay.hidden) closeSettings();
  else if (!newSectionOverlay.hidden) closeNewSection();
});

$('#settings-save').addEventListener('click', () => {
  const next = readModal();
  // Avisa si se eligió API sin config completa y sin fallback en el server.
  if (next.stt === 'api' && !apiReady(next.sttApi) && !serverVoice.stt) {
    if (!confirm('STT por API sin endpoint/key y sin fallback en .env. ¿Guardar igual?')) return;
  }
  if (next.tts === 'api' && !apiReady(next.ttsApi) && !serverVoice.tts) {
    if (!confirm('TTS por API sin endpoint/key y sin fallback en .env. ¿Guardar igual?')) return;
  }
  stored = next;
  localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  voiceCfg = { ...stored, apiBaseUrl: API_BASE };
  // Recrea el TTS con la nueva config (corta lo que estuviera sonando).
  tts.stop();
  tts = createTts(voiceCfg.tts, voiceCfg);
  wireTtsState(tts);
  closeSettings();
});

/** Consulta la disponibilidad del fallback .env (solo informativo en el modal). */
async function fetchVoiceConfig(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/voice-config`);
    if (!res.ok) throw new Error(`${res.status}`);
    const cfg = (await res.json()) as { stt?: boolean; tts?: boolean; lang?: string; cleanup?: boolean; cleanupPrompt?: string };
    serverVoice = {
      stt: !!cfg.stt,
      tts: !!cfg.tts,
      lang: cfg.lang ?? 'es-ES',
      cleanup: !!cfg.cleanup,
      cleanupPrompt: cfg.cleanupPrompt ?? '',
    };
    // Si el modal ya está abierto y el textarea de prompt está vacío, mostramos
    // el default del server para que el usuario lo vea y pueda editar.
    if (!overlay.hidden && !el.cleanPrompt.value.trim() && serverVoice.cleanupPrompt) {
      el.cleanPrompt.value = serverVoice.cleanupPrompt;
    }
  } catch {
    serverVoice = { stt: false, tts: false, lang: 'es-ES', cleanup: false, cleanupPrompt: '' };
  }
  renderNote();
}
void fetchVoiceConfig();

// ---- Render --------------------------------------------------------------
function render(): void {
  const list = $('#sections');
  list.innerHTML = '';

  if (sections.size === 0) {
    const empty = document.createElement('p');
    empty.className = 'sections-empty';
    empty.textContent = 'Sin secciones. Crea una con ＋.';
    list.appendChild(empty);
  }

  for (const s of sections.values()) {
    const li = document.createElement('li');
    li.className = s.sectionId === activeId ? 'card active' : 'card';
    li.dataset.agent = s.agent; // identidad del agente (hooks/tests); ya no define color

    // Avatar = logo real del agente; mock (sin logo) cae a su inicial.
    const logo = AGENT_LOGO[s.agent];
    let avatar: HTMLElement;
    if (logo) {
      const img = document.createElement('img');
      img.className = 'card-avatar';
      img.src = logo;
      img.alt = s.agent;
      avatar = img;
    } else {
      const span = document.createElement('span');
      span.className = 'card-avatar card-avatar-fallback';
      span.textContent = s.agent.slice(0, 1);
      avatar = span;
    }

    const main = document.createElement('span');
    main.className = 'card-main';
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = s.agent;
    const sub = document.createElement('span');
    sub.className = 'card-sub';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = s.kind === 'pty' ? '⌨ TUI' : '💬 chat';
    sub.append(kind, document.createTextNode(` · ${s.mode}`));
    main.append(title, sub);

    const status = document.createElement('span');
    status.className = s.ready ? 'card-status ready' : 'card-status';
    status.title = s.ready ? 'lista' : 'conectando…';

    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'Cerrar sección';
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeSection(s.sectionId);
    });

    li.addEventListener('click', () => {
      activeId = s.sectionId;
      render();
    });

    li.append(avatar, main, status, x);
    list.appendChild(li);
  }

  const active = activeId ? sections.get(activeId) : undefined;
  const log = $('#log');
  // En modo TUI se escribe en el propio xterm → la barra de texto sobra.
  $('#textbar').hidden = !!(active && active.kind === 'pty');

  // Solo el pane de la sección activa es visible; los demás siguen vivos pero ocultos.
  for (const sec of sections.values()) sec.term?.hide();

  if (active && active.kind === 'pty') {
    // Modo pty: oculta el log de texto, muestra el terminal.
    log.hidden = true;
    termEl.hidden = false;
    mountTerm(active); // crea la TermView si aún no existe; repinta scrollback pendiente
    active.term?.show(); // muestra ESTE pane y reajusta a la geometría visible
    active.term?.focus();
  } else {
    // Modo rpc (o sin sección): muestra el log, oculta el terminal.
    termEl.hidden = true;
    log.hidden = false;
    log.textContent = active
      ? active.entries.map(formatEntry).join('\n') || '—'
      : 'Sin sección activa.';
    log.scrollTop = log.scrollHeight;
  }
}

render();
