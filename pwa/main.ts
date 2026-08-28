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
import antigravityLogo from './assets/agents/antigravity-logo.png';

// Logo real por agente (mock no tiene → cae a la inicial). Vite los empaqueta.
const AGENT_LOGO: Partial<Record<AgentKind, string>> = {
  claude: claudeLogo,
  codex: codexLogo,
  opencode: opencodeLogo,
  agy: antigravityLogo,
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
    ttsClean: { enabled: false, format: 'minimax', url: '', key: '', model: '', prompt: '', settleMs: 1000, maxMs: 3000 },
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

// ---- Gestión de voz por sección ------------------------------------------
interface SectionVoice {
  tts: Tts;
  speaking: boolean;
  muted: boolean;
  level: number;
}
const sectionVoices = new Map<string, SectionVoice>();
const MUTE_STORAGE_KEY = 'bennzen.section-mute';

function loadMutedSections(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(MUTE_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveSectionMute(sectionId: string, isMuted: boolean): void {
  const map = loadMutedSections();
  if (isMuted) map[sectionId] = true;
  else delete map[sectionId];
  localStorage.setItem(MUTE_STORAGE_KEY, JSON.stringify(map));
}

function getSectionVoice(sectionId: string): SectionVoice {
  let v = sectionVoices.get(sectionId);
  if (!v) {
    const sTts = createTts(voiceCfg.tts, voiceCfg);
    const mutedMap = loadMutedSections();
    v = {
      tts: sTts,
      speaking: false,
      muted: !!mutedMap[sectionId],
      level: 0,
    };
    wireSectionTts(sectionId, v);
    sectionVoices.set(sectionId, v);
  }
  return v;
}

const orb = $('#orb');
new OrbParticles(orb); // halo de partículas reactivo a la voz (lee clase/--level del orbe)
const vhint = $('#vhint');
const talkBtn = $<HTMLButtonElement>('#talk');
const muteBtn = $<HTMLButtonElement>('#mute');
const readBtn = $<HTMLButtonElement>('#read-text-btn');
const textInput = $<HTMLInputElement>('#text');
const overlay = $('#settings');
const readTextModal = $('#read-text-modal');
const readTextarea = $<HTMLTextAreaElement>('#read-textarea');
const readStatsEl = $('#read-stats');
const readCloseBtn = $<HTMLButtonElement>('#read-close');
const readCancelBtn = $<HTMLButtonElement>('#read-cancel');
const readSubmitBtn = $<HTMLButtonElement>('#read-submit');
const readPasteBtn = $<HTMLButtonElement>('#read-paste-btn');
const readClearBtn = $<HTMLButtonElement>('#read-clear-btn');
const meter = new MicMeter((lvl) => orb.style.setProperty('--level', String(lvl)));

// ---- Toggle de barras laterales ------------------------------------------
const sidebarLeft = $('#sidebar-left');
const colVoice = $('#col-voice');
const toggleSidebarBtn = $<HTMLButtonElement>('#toggle-sidebar');
const toggleVoiceBtn = $<HTMLButtonElement>('#toggle-voice');

if (localStorage.getItem('bennzen.sidebar-left-collapsed') === '1') {
  sidebarLeft.classList.add('collapsed');
  toggleSidebarBtn.classList.add('active');
}

if (localStorage.getItem('bennzen.voice-minimized') === '1') {
  colVoice.classList.add('minimized');
  toggleVoiceBtn.classList.add('active');
}

toggleSidebarBtn.addEventListener('click', () => {
  const isCollapsed = sidebarLeft.classList.toggle('collapsed');
  toggleSidebarBtn.classList.toggle('active', isCollapsed);
  localStorage.setItem('bennzen.sidebar-left-collapsed', isCollapsed ? '1' : '0');
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 230);
});

toggleVoiceBtn.addEventListener('click', () => {
  const isMinimized = colVoice.classList.toggle('minimized');
  toggleVoiceBtn.classList.toggle('active', isMinimized);
  localStorage.setItem('bennzen.voice-minimized', isMinimized ? '1' : '0');
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 230);
});

// ---- Estado del orbe -----------------------------------------------------
type OrbState = 'idle' | 'listening' | 'speaking' | 'cleaning';
let listening = false;

function setOrb(state: OrbState): void {
  orb.className = `orb ${state}`;
  if (state !== 'listening') orb.style.setProperty('--level', '0');
}

function updateCardVoiceState(sectionId: string, v: SectionVoice): void {
  const card = document.querySelector<HTMLElement>(`#sections .card[data-section-id="${sectionId}"]`);
  if (!card) return;
  const isSpeaking = v.speaking && !v.muted;
  card.classList.toggle('speaking', isSpeaking);
  card.classList.toggle('muted', v.muted);
  const flameEl = card.querySelector<HTMLElement>('.card-flame');
  if (flameEl) {
    flameEl.classList.toggle('visible', isSpeaking);
  }
  const muteBtnEl = card.querySelector<HTMLButtonElement>('.card-mute-btn');
  if (muteBtnEl) {
    muteBtnEl.textContent = v.muted ? '🔇' : '🔊';
    muteBtnEl.title = v.muted ? 'Activar voz en esta sección' : 'Silenciar voz en esta sección';
    muteBtnEl.classList.toggle('active', v.muted);
  }
}

function updateCardVoiceLevel(sectionId: string, lvl: number): void {
  const card = document.querySelector<HTMLElement>(`#sections .card[data-section-id="${sectionId}"]`);
  if (card) {
    card.style.setProperty('--voice-level', String(lvl));
  }
}

function updateMainMuteBtn(): void {
  if (!activeId) {
    muteBtn.textContent = '🔊';
    muteBtn.classList.remove('active');
    muteBtn.title = 'Silenciar voz';
    return;
  }
  const v = getSectionVoice(activeId);
  muteBtn.textContent = v.muted ? '🔇' : '🔊';
  muteBtn.classList.toggle('active', v.muted);
  muteBtn.title = v.muted ? 'Activar voz en la sección activa' : 'Silenciar voz en la sección activa';
}

function toggleSectionMute(sectionId: string): void {
  const v = getSectionVoice(sectionId);
  v.muted = !v.muted;
  saveSectionMute(sectionId, v.muted);
  if (v.muted) {
    v.tts.stop();
    v.speaking = false;
  }
  const sec = sections.get(sectionId);
  if (sec) {
    sec.muted = v.muted;
    sec.speaking = v.speaking && !v.muted;
  }
  updateCardVoiceState(sectionId, v);
  updateMainMuteBtn();
  if (sectionId === activeId && !listening) {
    setOrb(v.speaking && !v.muted ? 'speaking' : 'idle');
    if (v.muted) orb.style.setProperty('--level', '0');
  }
}

function wireSectionTts(sectionId: string, v: SectionVoice): void {
  v.tts.onStateChange = (speaking) => {
    v.speaking = speaking;
    const sec = sections.get(sectionId);
    if (sec) sec.speaking = speaking && !v.muted;
    updateCardVoiceState(sectionId, v);
    if ((sectionId === activeId || !activeId) && !listening) {
      setOrb(speaking && !v.muted ? 'speaking' : 'idle');
      if (!speaking && vhint.textContent?.startsWith('📖')) {
        vhint.textContent = HINT;
      }
    }
  };

  v.tts.onLevel = (lvl) => {
    v.level = lvl;
    updateCardVoiceLevel(sectionId, lvl);
    if ((sectionId === activeId || !activeId) && !listening) {
      orb.style.setProperty('--level', String(lvl));
    }
  };

  v.tts.onCleaning = (state, info) => {
    if (sectionId === activeId || !activeId) {
      if (listening) return;
      if (state === 'start') {
        setOrb('cleaning');
        vhint.textContent = '🧹 Limpiando texto…';
      } else {
        setOrb('speaking');
        if (info && info.before > 0) {
          const pct = Math.round((1 - info.after / info.before) * 100);
          const sign = pct >= 0 ? '−' : '+';
          vhint.textContent = `🧹 ${info.before}→${info.after} ${sign}${Math.abs(pct)}%`;
          const shown = vhint.textContent;
          setTimeout(() => { if (vhint.textContent === shown) vhint.textContent = HINT; }, 3500);
        } else {
          vhint.textContent = '🧹 Texto limpiado';
          const shown = vhint.textContent;
          setTimeout(() => { if (vhint.textContent === shown) vhint.textContent = HINT; }, 2000);
        }
      }
    }
  };
}

/** Habla un texto para una sección específica si la voz de esa sección no está silenciada. */
function speak(sectionId: string, text: string, andFlush = false): void {
  const v = getSectionVoice(sectionId);
  if (v.muted) return;
  v.tts.push(text);
  if (andFlush) v.tts.flush();
}

// ---- Conexión ------------------------------------------------------------
const statusEl = $('#status');
bridge.onStatus((connected) => {
  // Estado REAL del socket: si el orquestador se reinicia (tsx watch), el
  // Bridge reconecta solo y esto vuelve a ✓ sin recargar la página.
  statusEl.textContent = connected ? '● conectado' : '○ reconectando…';
  statusEl.className = connected ? 'ok' : 'off';
});

// ---- Persistencia local de títulos y orden de secciones ------------------
const TITLE_STORAGE_KEY = 'bennzen.section-titles';
const ORDER_STORAGE_KEY = 'bennzen.section-order';

function loadCustomTitles(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(TITLE_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveCustomTitle(sectionId: string, title: string): void {
  const titles = loadCustomTitles();
  if (title.trim()) {
    titles[sectionId] = title.trim();
  } else {
    delete titles[sectionId];
  }
  localStorage.setItem(TITLE_STORAGE_KEY, JSON.stringify(titles));
}

function loadSectionOrder(): string[] {
  try {
    return JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveSectionOrder(order: string[]): void {
  localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
}

function getOrderedSections(): UiSection[] {
  const order = loadSectionOrder();
  const list = [...sections.values()];
  list.sort((a, b) => {
    const idxA = order.indexOf(a.sectionId);
    const idxB = order.indexOf(b.sectionId);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return 0;
  });
  return list;
}

function formatShortPath(rawCwd: string): string {
  if (!rawCwd || rawCwd === '.') return '.';
  const clean = rawCwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  if (parts.length === 1) return parts[0];
  return parts.slice(-2).join('/');
}

let draggedSectionId: string | null = null;
let editingTitleSectionId: string | null = null;

// ---- Mensajes del orquestador -------------------------------------------
bridge.on((m) => {
  if (m.t === 'snapshot') {
    // Estado COMPLETO del orquestador → restaura todas las sesiones (tras refresh).
    const incoming = new Set(m.sessions.map((s) => s.sectionId));
    const customTitles = loadCustomTitles();
    const mutedMap = loadMutedSections();
    for (const info of m.sessions) {
      const isMuted = !!mutedMap[info.sectionId];
      const ex = sections.get(info.sectionId);
      if (ex) {
        ex.ready = info.ready;
        ex.muted = isMuted;
        if (customTitles[info.sectionId]) ex.customTitle = customTitles[info.sectionId];
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
          muted: isMuted,
          customTitle: customTitles[info.sectionId],
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
        const v = sectionVoices.get(id);
        if (v) {
          v.tts.stop();
          sectionVoices.delete(id);
        }
      }
    }
    if (!activeId || !sections.has(activeId)) {
      activeId = sections.keys().next().value ?? null;
    }
    updateMainMuteBtn();
    render();
  } else if (m.t === 'created') {
    const s = sections.get(m.sectionId);
    if (s) s.ready = true;
    render();
  } else if (m.t === 'delta') {
    const s = sections.get(m.sectionId);
    if (!s) return;
    applyDelta(s.entries, m.delta);
    const v = getSectionVoice(m.sectionId);
    if (!v.muted) {
      if (m.delta.type === 'text') v.tts.push(m.delta.text);
      // 'done' de rpc = fin de turno real → flush inmediato (salta el debounce).
      else if (m.delta.type === 'done') v.tts.flush(true);
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
    const s = sections.get(m.sectionId);
    if (!s) return;
    const v = getSectionVoice(m.sectionId);
    if (!v.muted) {
      v.tts.push(m.text);
      v.tts.flush(true);
    }
  } else if (m.t === 'image-saved') {
    // La imagen ya está en disco: `path` es la ruta a inyectar en el prompt.
    const s = sections.get(m.sectionId);
    if (!s) return;
    if (s.kind === 'pty') {
      // pty: escribe la ruta en el terminal SIN Enter (el usuario sigue escribiendo).
      bridge.termInput(m.sectionId, m.path + ' ');
      if (m.sectionId === activeId) vhint.textContent = `🖼 ${m.name}`;
    } else {
      // rpc: marca el chip como listo y guarda la ruta para el próximo submit.
      const att = attachments.get(m.sectionId)?.find((a) => a.id === m.id);
      if (att) {
        att.path = m.path;
        att.status = 'ready';
      }
      if (m.sectionId === activeId) renderAttachments();
    }
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
    // Captura total del extractor si la limpieza TTS está activa (el proxy la
    // traduce a lenguaje natural). Con limpieza OFF, filtrado normal.
    bridge.setCapture(sectionId, voiceCfg.ttsClean.enabled);
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
  saveCustomTitle(sectionId, '');
  const v = sectionVoices.get(sectionId);
  if (v) {
    v.tts.stop();
    sectionVoices.delete(sectionId);
  }
  saveSectionMute(sectionId, false);
  const order = loadSectionOrder().filter((id) => id !== sectionId);
  saveSectionOrder(order);
  if (activeId === sectionId) {
    activeId = sections.keys().next().value ?? null;
  }
  updateMainMuteBtn();
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
  if (!overlay.hidden || !newSectionOverlay.hidden || !readTextModal.hidden) return; // un modal abierto → no capturar voz
  if (!activeId) {
    alert('Crea o elige una sección primero.');
    return;
  }
  listening = true;
  if (activeId) {
    const v = getSectionVoice(activeId);
    v.tts.stop(); // barge-in: corta al agente si estaba hablando
  }
  setOrb('listening');
  talkBtn.classList.add('active');
  // Browser STT abre su propio micro (Web Speech, opaco) → el medidor abre el suyo.
  // API STT abre UN micro y lo comparte con el medidor vía onStream (Fase 7.1): una
  // sola apertura por gesto, menos latencia y un solo permiso.
  if (voiceCfg.stt === 'browser') {
    void meter.start().catch(() => {
      /* micro denegado: seguimos sin halo reactivo */
    });
  }

  try {
    stt = startStt(voiceCfg.stt, voiceCfg, {
      onInterim: (t) => (vhint.textContent = `🎙 ${t}`),
      onFinal: (t) => submit(t),
      onStream: (s) => {
        // Reutiliza el micro del STT para el halo reactivo (sin 2º getUserMedia).
        void meter.start(s).catch(() => {});
      },
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
  if (e.key !== 'Enter') return;
  const input = e.target as HTMLInputElement;
  const val = input.value.trim();
  const hasAttachments = !!activeId && (attachments.get(activeId)?.length ?? 0) > 0;
  if (!val && !hasAttachments) {
    input.value = '';
    return;
  }
  // Solo limpiamos el input si el envío se concretó: si hay subidas en curso,
  // submit() aborta y devuelve false → conservamos el texto para reintentar.
  if (submit(val)) input.value = '';
});

/**
 * Enruta el texto dictado/escrito según el tipo de la sección activa.
 * Devuelve true si envió (para limpiar el input); false si abortó o no hizo nada.
 */
function submit(text: string): boolean {
  if (!activeId) return false;
  const s = sections.get(activeId);
  if (!s) return false;
  if (s.kind === 'pty') {
    // La TUI eco-eará el texto en el terminal; mostramos confirmación en la voz.
    vhint.textContent = `↵ enviado: ${text}`;
    // Texto y Enter en escrituras SEPARADAS: muchas TUIs (codex) detectan "paste"
    // por temporización y un \r pegado al texto se inserta como salto de línea en
    // vez de enviar. Mandar el \r aparte = Enter discreto → la TUI sí envía.
    bridge.termInput(s.sectionId, text);
    setTimeout(() => bridge.termInput(s.sectionId, '\r'), 50);
    return true;
  }

  // rpc con adjuntos: inyecta las rutas en el prompt (estrategia "ruta-en-prompt").
  const list = attachments.get(activeId) ?? [];
  if (list.length > 0) {
    if (list.some((a) => a.status === 'uploading')) {
      // Aún subiendo: avisa y NO envía. El usuario reintenta al terminar.
      vhint.textContent = '⬆ Subiendo imagen… espera un momento';
      return false;
    }
    const paths = list.filter((a) => a.status === 'ready' && a.path).map((a) => a.path as string);
    // Al agente va la versión con rutas; al historial, un texto amable.
    const finalText = text
      ? [text, ...paths].join('\n')
      : 'Analiza la imagen adjunta:\n' + paths.join('\n');
    const displayText = (text || '(imagen)') + ' 🖼×' + paths.length;
    pushUser(s.entries, displayText);
    bridge.say(activeId, finalText);
    attachments.set(activeId, []); // limpia adjuntos y chips
    renderAttachments();
    render();
    return true;
  }

  // rpc sin adjuntos: comportamiento idéntico al de siempre.
  pushUser(s.entries, text);
  bridge.say(activeId, text);
  render();
  return true;
}

// ---- Mute (silenciar voz del agente activo) -----------------------------
muteBtn.addEventListener('click', () => {
  if (!activeId) return;
  toggleSectionMute(activeId);
});

// ---- Adjuntos de imagen (arrastrar / pegar / botón 📎) -------------------
// Estrategia "ruta-en-prompt": la imagen se sube al orquestador (upload-image),
// que la guarda en un temp y responde con su ruta (image-saved). Esa ruta se
// INYECTA en el prompt del agente — en rpc va con el texto (say), en pty se
// escribe en el terminal para que el usuario la complete y envíe.
interface Attachment {
  id: string;
  name: string;
  mime: string;
  thumbUrl: string; // data URL para la miniatura <img>
  path: string | null; // ruta que devuelve el server (null hasta image-saved)
  status: 'uploading' | 'ready';
}

// Adjuntos pendientes por sección (clave = sectionId). Solo el compositor rpc
// muestra chips; en pty la ruta se inyecta directa en el terminal (sin estado).
const attachments = new Map<string, Attachment[]>();
function attachmentsOf(sectionId: string): Attachment[] {
  let list = attachments.get(sectionId);
  if (!list) attachments.set(sectionId, (list = []));
  return list;
}

const ATTACH_MAX = 10 * 1024 * 1024; // 10 MB
const ATTACH_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const uploadId = (): string =>
  crypto.randomUUID?.() ?? 'img-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

const attachmentsEl = $('#attachments');
const attachBtn = $<HTMLButtonElement>('#attach-btn');
const attachInput = $<HTMLInputElement>('#attach-input');
const colOut = $('.col-out');

/** Pinta los chips de adjuntos de la sección activa (solo rpc). */
function renderAttachments(): void {
  attachmentsEl.innerHTML = '';
  const active = activeId ? sections.get(activeId) : undefined;
  const list = activeId ? attachments.get(activeId) : undefined;
  if (!active || active.kind === 'pty' || !list || list.length === 0) {
    attachmentsEl.hidden = true;
    return;
  }
  attachmentsEl.hidden = false;
  const sid = active.sectionId;
  for (const att of list) {
    const chip = document.createElement('div');
    chip.className = `attachment ${att.status}`;
    chip.title = att.status === 'uploading' ? `Subiendo ${att.name}…` : att.name;

    const img = document.createElement('img');
    img.className = 'attachment-thumb';
    img.src = att.thumbUrl;
    img.alt = att.name;

    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = att.name;

    const del = document.createElement('button');
    del.className = 'attachment-del';
    del.textContent = '×';
    del.title = 'Quitar';
    del.addEventListener('click', () => {
      attachments.set(sid, (attachments.get(sid) ?? []).filter((a) => a.id !== att.id));
      renderAttachments();
    });

    chip.append(img, name, del);
    attachmentsEl.appendChild(chip);
  }
}

/** Valida, lee y sube cada imagen; enruta según el modo de la sección activa. */
function addImages(files: FileList | File[]): void {
  if (!activeId) {
    vhint.textContent = '⚠️ Crea o elige una sección primero.';
    return;
  }
  const s = sections.get(activeId);
  if (!s) return;
  const sid = s.sectionId;

  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue;
    if (!ATTACH_MIME.includes(file.type)) {
      vhint.textContent = `⚠️ Formato no soportado: ${file.name}`;
      continue;
    }
    if (file.size > ATTACH_MAX) {
      vhint.textContent = `⚠️ Imagen muy grande (>10 MB): ${file.name}`;
      continue;
    }

    const id = uploadId();
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1); // quita "data:...;base64,"
      if (!base64) return;
      if (s.kind === 'pty') {
        // pty: sin chips; la ruta se inyecta en el terminal al llegar image-saved.
        vhint.textContent = `⬆ Subiendo ${file.name}…`;
      } else {
        // rpc: chip con miniatura mientras sube.
        attachmentsOf(sid).push({
          id,
          name: file.name,
          mime: file.type,
          thumbUrl: dataUrl,
          path: null,
          status: 'uploading',
        });
        if (activeId === sid) renderAttachments();
      }
      bridge.uploadImage(sid, id, file.name, file.type, base64);
    };
    reader.onerror = () => {
      vhint.textContent = `⚠️ No se pudo leer ${file.name}`;
    };
    reader.readAsDataURL(file);
  }
}

// Botón 📎 → dispara el input de archivo oculto.
attachBtn.addEventListener('click', () => attachInput.click());
attachInput.addEventListener('change', () => {
  if (attachInput.files) addImages(attachInput.files);
  attachInput.value = ''; // permite re-seleccionar el mismo archivo
});

// Pegar (Ctrl/Cmd+V): saca imágenes del portapapeles. El texto normal no se toca.
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imgs: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) imgs.push(f);
    }
  }
  if (imgs.length === 0) return; // pegar texto → comportamiento normal
  e.preventDefault();
  addImages(imgs);
});

// Arrastrar y soltar sobre la columna de salida (log rpc o terminal pty).
const setDragging = (on: boolean): void => {
  colOut.classList.toggle('dragging', on);
};
colOut.addEventListener('dragenter', (e) => {
  e.preventDefault();
  setDragging(true);
});
colOut.addEventListener('dragover', (e) => {
  e.preventDefault(); // imprescindible para permitir el drop
  setDragging(true);
});
colOut.addEventListener('dragleave', () => setDragging(false));
colOut.addEventListener('drop', (e) => {
  e.preventDefault();
  setDragging(false);
  const files = e.dataTransfer?.files;
  if (files && files.length) addImages(files);
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
  cleanSettle: $<HTMLInputElement>('#clean-settle'),
  cleanMax: $<HTMLInputElement>('#clean-max'),
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
  el.cleanSettle.value = String(stored.ttsClean.settleMs ?? 1000);
  el.cleanMax.value = String(stored.ttsClean.maxMs ?? 3000);
  toggleApiFields();
  renderNote();
}

/** Lee los campos del modal a un objeto de config. */
function readSettingsModal(): StoredVoice {
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
      settleMs: clampInt(el.cleanSettle.value, 200, 5000, 1000),
      maxMs: clampInt(el.cleanMax.value, 500, 10000, 3000),
    },
  };
}

/** Entero dentro de [min,max]; `fallback` si no es un número válido. */
function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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
  if (!readTextModal.hidden) closeReadModal();
  else if (!overlay.hidden) closeSettings();
  else if (!newSectionOverlay.hidden) closeNewSection();
});

// ---- Modal de lectura de texto (sin límite de caracteres) ----------------
let readingTargetSectionId: string | null = null;

function openReadModal(): void {
  if (!activeId) {
    alert('Crea o selecciona una sección primero.');
    return;
  }
  readingTargetSectionId = activeId;
  const s = sections.get(activeId);
  const title = s?.customTitle || s?.agent || 'sección activa';
  $<HTMLElement>('#read-title').textContent = `📖 Leer texto (${title})`;
  readTextModal.hidden = false;
  updateReadStats();
  setTimeout(() => readTextarea.focus(), 60);
}

function closeReadModal(): void {
  readTextModal.hidden = true;
}

function updateReadStats(): void {
  const val = readTextarea.value;
  const chars = val.length;
  const words = val.trim() ? val.trim().split(/\s+/).length : 0;
  readStatsEl.textContent = `${chars.toLocaleString()} caracteres · ${words.toLocaleString()} palabras`;
}

function readTextAloud(sectionId: string, text: string): void {
  const cleanText = text.trim();
  if (!cleanText) return;
  const v = getSectionVoice(sectionId);
  if (v.muted) {
    toggleSectionMute(sectionId);
  }
  // Barge-in en esa sección
  v.tts.stop();
  if (sectionId === activeId) {
    vhint.textContent = '📖 Leyendo texto…';
    setOrb('speaking');
  }

  // Dejamos un tick para que el motor de audio asiente la cancelación previa
  setTimeout(() => {
    v.tts.push(cleanText);
    v.tts.flush(true);
  }, 40);
}

function submitReadText(): void {
  const text = readTextarea.value.trim();
  if (!text) {
    readTextarea.focus();
    return;
  }
  const targetId = readingTargetSectionId || activeId;
  if (!targetId) {
    alert('No hay una sección seleccionada.');
    return;
  }
  closeReadModal();
  readTextAloud(targetId, text);
}

readBtn.addEventListener('click', openReadModal);
readCloseBtn.addEventListener('click', closeReadModal);
readCancelBtn.addEventListener('click', closeReadModal);
readTextModal.addEventListener('click', (e) => {
  if (e.target === readTextModal) closeReadModal();
});
readTextarea.addEventListener('input', updateReadStats);
readTextarea.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    submitReadText();
  }
});
readSubmitBtn.addEventListener('click', submitReadText);

readPasteBtn.addEventListener('click', async () => {
  try {
    const clip = await navigator.clipboard.readText();
    if (clip) {
      readTextarea.value = clip;
      updateReadStats();
      readTextarea.focus();
    }
  } catch (err) {
    console.warn('No se pudo acceder al portapapeles:', err);
    readTextarea.focus();
  }
});

readClearBtn.addEventListener('click', () => {
  readTextarea.value = '';
  updateReadStats();
  readTextarea.focus();
});

$('#settings-save').addEventListener('click', () => {
  const next = readSettingsModal();
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
  // Propaga el nuevo modo de captura a cada sección pty viva: con limpieza ON
  // el extractor del orquestador captura TODO (tablas, código, comandos,
  // resultados de herramientas); con OFF vuelve al filtrado normal.
  for (const s of sections.values()) {
    if (s.kind === 'pty') bridge.setCapture(s.sectionId, next.ttsClean.enabled);
  }
  // Recrea los TTS de todas las secciones con la nueva config (corta lo que estuviera sonando).
  for (const [sid, v] of sectionVoices.entries()) {
    v.tts.stop();
    v.tts = createTts(voiceCfg.tts, voiceCfg);
    wireSectionTts(sid, v);
  }
  updateMainMuteBtn();
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

  const orderedSections = getOrderedSections();

  if (orderedSections.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sections-empty';
    empty.textContent = 'Sin secciones. Crea una con ＋.';
    list.appendChild(empty);
  }

  for (const s of orderedSections) {
    const v = getSectionVoice(s.sectionId);
    const isSpeaking = v.speaking && !v.muted;
    s.muted = v.muted;
    s.speaking = isSpeaking;

    const li = document.createElement('li');
    let cardClass = 'card';
    if (s.sectionId === activeId) cardClass += ' active';
    if (isSpeaking) cardClass += ' speaking';
    if (v.muted) cardClass += ' muted';
    li.className = cardClass;
    li.dataset.agent = s.agent; // identidad del agente (hooks/tests); ya no define color
    li.dataset.sectionId = s.sectionId;
    li.draggable = true;
    if (v.level > 0) {
      li.style.setProperty('--voice-level', String(v.level));
    }

    // 1. Señita de dragueable (handle)
    const dragHandle = document.createElement('span');
    dragHandle.className = 'card-drag-handle';
    dragHandle.textContent = '⋮⋮';
    dragHandle.title = 'Arrastrar para reordenar';

    // 2. Avatar / Logo (20x20)
    const logo = AGENT_LOGO[s.agent];
    const displayTitle = s.customTitle || s.agent;
    let avatar: HTMLElement;
    if (logo) {
      // Logo personalizado (claude, codex, opencode) siempre se mantiene
      const img = document.createElement('img');
      img.className = 'card-avatar';
      img.src = logo;
      img.alt = s.agent;
      avatar = img;
    } else {
      // Fallback: inicial del nombre (si se renombró, inicial del nuevo nombre)
      const span = document.createElement('span');
      span.className = 'card-avatar card-avatar-fallback';
      span.textContent = displayTitle.trim().slice(0, 1).toUpperCase();
      avatar = span;
    }

    // 3. Contenido principal (Título + Subtítulo con modo y ruta reducida)
    const main = document.createElement('span');
    main.className = 'card-main';

    const titleRow = document.createElement('div');
    titleRow.className = 'card-title-row';

    if (editingTitleSectionId === s.sectionId) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'card-title-input';
      input.value = displayTitle;
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('mousedown', (e) => e.stopPropagation());

      const commit = (newVal: string) => {
        if (editingTitleSectionId !== s.sectionId) return;
        editingTitleSectionId = null;
        const val = newVal.trim();
        s.customTitle = val && val !== s.agent ? val : undefined;
        saveCustomTitle(s.sectionId, s.customTitle || '');
        render();
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(input.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          editingTitleSectionId = null;
          render();
        }
      });
      input.addEventListener('blur', () => commit(input.value));
      titleRow.appendChild(input);
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    } else {
      const title = document.createElement('span');
      title.className = 'card-title';
      title.textContent = displayTitle;
      title.title = 'Doble clic o ✏ para renombrar';
      title.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        editingTitleSectionId = s.sectionId;
        render();
      });

      const renameBtn = document.createElement('button');
      renameBtn.className = 'card-rename-btn';
      renameBtn.textContent = '✏';
      renameBtn.title = 'Renombrar sesión';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        editingTitleSectionId = s.sectionId;
        render();
      });

      titleRow.append(title, renameBtn);
    }

    const sub = document.createElement('span');
    sub.className = 'card-sub';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = s.kind === 'pty' ? '⌨ TUI' : '💬 chat';
    sub.append(kind, document.createTextNode(` · ${s.mode}`));

    const pathEl = document.createElement('span');
    pathEl.className = 'card-path';
    pathEl.title = `Directorio: ${s.cwd}`;
    const shortCwd = formatShortPath(s.cwd);
    pathEl.textContent = shortCwd;

    main.append(titleRow, sub, pathEl);

    // 4. Estado de conexión
    const status = document.createElement('span');
    status.className = s.ready ? 'card-status ready' : 'card-status';
    status.title = s.ready ? 'lista' : 'conectando…';

    // 6. Botón Mute por sección (🔊 / 🔇)
    const muteBtnCard = document.createElement('button');
    muteBtnCard.className = v.muted ? 'card-mute-btn active' : 'card-mute-btn';
    muteBtnCard.textContent = v.muted ? '🔇' : '🔊';
    muteBtnCard.title = v.muted ? 'Activar voz en esta sección' : 'Silenciar voz en esta sección';
    muteBtnCard.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleSectionMute(s.sectionId);
    });

    // 7. Botón cerrar
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'Cerrar sección';
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeSection(s.sectionId);
    });

    // Activar sección al hacer clic
    li.addEventListener('click', () => {
      if (editingTitleSectionId === s.sectionId) return;
      activeId = s.sectionId;
      const curV = getSectionVoice(s.sectionId);
      updateMainMuteBtn();
      if (!listening) {
        setOrb(curV.speaking && !curV.muted ? 'speaking' : 'idle');
        orb.style.setProperty('--level', curV.speaking && !curV.muted ? String(curV.level) : '0');
        if (curV.speaking && !curV.muted) {
          vhint.textContent = '📖 Leyendo texto…';
        } else {
          vhint.textContent = HINT;
        }
      }
      render();
    });

    // Drag & Drop
    li.addEventListener('dragstart', (e) => {
      draggedSectionId = s.sectionId;
      li.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', s.sectionId);
        e.dataTransfer.effectAllowed = 'move';
      }
    });

    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!draggedSectionId || draggedSectionId === s.sectionId) return;
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

      const rect = li.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) {
        li.classList.add('drag-over-top');
        li.classList.remove('drag-over-bottom');
      } else {
        li.classList.add('drag-over-bottom');
        li.classList.remove('drag-over-top');
      }
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromId = draggedSectionId || e.dataTransfer?.getData('text/plain');
      const toId = s.sectionId;
      li.classList.remove('drag-over-top', 'drag-over-bottom');

      if (fromId && fromId !== toId) {
        const insertAfter = e.clientY >= li.getBoundingClientRect().top + li.getBoundingClientRect().height / 2;
        const currentOrder = getOrderedSections().map((sec) => sec.sectionId);
        const fromIdx = currentOrder.indexOf(fromId);
        if (fromIdx !== -1) currentOrder.splice(fromIdx, 1);

        let toIdx = currentOrder.indexOf(toId);
        if (toIdx !== -1) {
          if (insertAfter) toIdx++;
          currentOrder.splice(toIdx, 0, fromId);
        } else {
          currentOrder.push(fromId);
        }
        saveSectionOrder(currentOrder);
        render();
      }
    });

    li.addEventListener('dragend', () => {
      draggedSectionId = null;
      document.querySelectorAll('#sections .card').forEach((el) => {
        el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
      });
    });

    li.append(dragHandle, avatar, main, status, muteBtnCard, x);
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

  // Chips de adjuntos de la sección activa (solo rpc; se oculta solo si no aplica).
  renderAttachments();

  // Sincroniza el botón de mute principal con la sección activa
  updateMainMuteBtn();
}

render();

