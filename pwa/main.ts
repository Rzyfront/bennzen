import { Bridge, newSectionId, type UiSection } from './sections';
import {
  ACTIVE_SPACE_KEY,
  ALL_VIEW,
  SECTION_CONFIG_KEY,
  SECTION_ORDER_V1_KEY,
  SECTION_SPACE_KEY,
  SPACE_ACTIVE_KEY,
  SPACE_PALETTE,
  SPACES_KEY,
  UNASSIGNED_BUCKET,
  getOrderBucket,
  getRestorableIds,
  getSpaceActive,
  loadActiveSpace,
  loadSectionConfigs,
  loadSectionSpace,
  loadSpaceOrders,
  loadSpaces,
  purgeSectionData,
  resolveSpaceColor,
  saveActiveSpace,
  saveOrderBucket,
  saveSectionConfig,
  saveSectionSpace,
  saveSpaceOrders,
  saveSpaces,
  setSpaceActive,
  setSpaceOf,
} from './spaces';
import { toast } from './toast';
import { initGit, forgetGitSection } from './git';
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
import type { AgentKind, PermMode, SectionKind, RouterConfig, RouterTestResult, ProjectConfig } from '../shared/protocol';
import claudeLogo from './assets/agents/claude.png';
import codexLogo from './assets/agents/codex.webp';
import opencodeLogo from './assets/agents/opencode.png';
import antigravityLogo from './assets/agents/antigravity-logo.png';
import museLogo from './assets/agents/spark.png';

// Plantillas SVG vectoriales para estados de audio y edición (cero emojis por defecto)
const SVG_SPEAKER_ON = `<svg class="icon-speaker" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`;
const SVG_SPEAKER_MUTED = `<svg class="icon-speaker-muted" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;
const SVG_EDIT = `<svg class="icon-edit" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path></svg>`;
const SVG_X = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

function updateMuteButton(el: HTMLElement, isMuted: boolean): void {
  el.innerHTML = isMuted ? SVG_SPEAKER_MUTED : SVG_SPEAKER_ON;
  el.classList.toggle('muted', isMuted);
  el.classList.toggle('active', isMuted);
  el.title = isMuted ? 'Activar voz' : 'Silenciar voz';
}

// Logo real por agente (mock no tiene → cae a la inicial). Vite los empaqueta.
const AGENT_LOGO: Partial<Record<AgentKind, string>> = {
  claude: claudeLogo,
  codex: codexLogo,
  opencode: opencodeLogo,
  agy: antigravityLogo,
  muse: museLogo,
};

const WS_URL = `ws://${location.hostname}:4319`;
const API_BASE = `http://${location.hostname}:4319`;
const HINT = 'Mantén espacio para hablar';

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`No existe ${sel}`);
  return el;
};

// ---- Sistema de Diálogos Personalizados (Prompt / Alert / Confirm) --------
interface DialogOptions {
  title?: string;
  message?: string;
  icon?: 'prompt' | 'alert' | 'confirm' | 'danger' | 'success' | 'error' | 'info';
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface PromptOptions extends DialogOptions {
  defaultValue?: string;
  placeholder?: string;
}

const dialogOverlay = $('#ui-dialog-overlay');
const dialogTitleText = $('#ui-dialog-title-text');
const dialogIcon = $('#ui-dialog-icon');
const dialogMessage = $('#ui-dialog-message');
const dialogInputContainer = $('#ui-dialog-input-container');
const dialogInput = $<HTMLInputElement>('#ui-dialog-input');
const dialogCancelBtn = $<HTMLButtonElement>('#ui-dialog-cancel');
const dialogConfirmBtn = $<HTMLButtonElement>('#ui-dialog-confirm');
const dialogCloseBtn = $<HTMLButtonElement>('#ui-dialog-close');

let currentDialogResolve: ((val: any) => void) | null = null;

function closeUiDialog(resolvedValue: any): void {
  dialogOverlay.hidden = true;
  if (currentDialogResolve) {
    const resolve = currentDialogResolve;
    currentDialogResolve = null;
    resolve(resolvedValue);
  }
}

dialogCloseBtn.addEventListener('click', () => closeUiDialog(null));
dialogCancelBtn.addEventListener('click', () => closeUiDialog(null));
dialogOverlay.addEventListener('click', (e) => {
  if (e.target === dialogOverlay) closeUiDialog(null);
});

function showCustomDialog(type: 'prompt' | 'alert' | 'confirm', opts: PromptOptions): Promise<any> {
  return new Promise((resolve) => {
    currentDialogResolve = resolve;

    dialogTitleText.textContent = opts.title || (type === 'prompt' ? 'Ingresar nombre' : type === 'alert' ? 'Aviso' : 'Confirmación');
    
    if (opts.icon === 'error' || opts.danger) {
      dialogIcon.innerHTML = `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>`;
      dialogIcon.style.color = '#f87171';
    } else if (opts.icon === 'success') {
      dialogIcon.innerHTML = `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>`;
      dialogIcon.style.color = '#4ade80';
    } else if (type === 'prompt') {
      dialogIcon.innerHTML = `<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline>`;
      dialogIcon.style.color = 'var(--accent)';
    } else {
      dialogIcon.innerHTML = `<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>`;
      dialogIcon.style.color = 'var(--accent)';
    }

    if (opts.message) {
      dialogMessage.textContent = opts.message;
      dialogMessage.hidden = false;
    } else {
      dialogMessage.hidden = true;
    }

    if (type === 'prompt') {
      dialogInputContainer.hidden = false;
      dialogInput.value = opts.defaultValue || '';
      dialogInput.placeholder = opts.placeholder || '';
    } else {
      dialogInputContainer.hidden = true;
    }

    dialogConfirmBtn.textContent = opts.confirmText || (type === 'prompt' ? 'Guardar' : 'Aceptar');
    dialogCancelBtn.textContent = opts.cancelText || 'Cancelar';
    dialogCancelBtn.hidden = type === 'alert';

    if (opts.danger) {
      dialogConfirmBtn.style.background = 'var(--rec)';
      dialogConfirmBtn.style.color = '#fff';
    } else {
      dialogConfirmBtn.style.background = '';
      dialogConfirmBtn.style.color = '';
    }

    dialogConfirmBtn.onclick = () => {
      if (type === 'prompt') {
        const val = dialogInput.value.trim();
        closeUiDialog(val || null);
      } else if (type === 'confirm') {
        closeUiDialog(true);
      } else {
        closeUiDialog(true);
      }
    };

    dialogInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        dialogConfirmBtn.click();
      }
    };

    dialogOverlay.hidden = false;
    if (type === 'prompt') {
      setTimeout(() => {
        dialogInput.focus();
        dialogInput.select();
      }, 50);
    } else {
      setTimeout(() => dialogConfirmBtn.focus(), 50);
    }
  });
}

function uiPrompt(title: string, defaultValue: string = '', placeholder: string = ''): Promise<string | null> {
  return showCustomDialog('prompt', { title, defaultValue, placeholder });
}

function uiAlert(message: string, title: string = 'Aviso', icon?: 'info' | 'error' | 'success'): Promise<void> {
  return showCustomDialog('alert', { title, message, icon: icon || 'info' });
}

function uiConfirm(message: string, title: string = 'Confirmar acción', danger: boolean = false): Promise<boolean> {
  return showCustomDialog('confirm', { title, message, danger, icon: danger ? 'danger' : 'confirm' });
}

const sections = new Map<string, UiSection>();
let activeId: string | null = null;

const bridge = new Bridge(WS_URL);

// ---- Panel git (F1: widget del header en solo lectura) --------------------
const gitBadges = new Map<string, { branch: string; dirty: boolean }>();

/** Parche in-place de los badges (sin render() para no realimentar syncActiveSection). */
function applyGitBadges(badges: Map<string, { branch: string; dirty: boolean }>): void {
  gitBadges.clear();
  for (const [k, v] of badges) gitBadges.set(k, v);
  for (const li of document.querySelectorAll('#sections .card')) {
    const id = (li as HTMLElement).dataset.sectionId;
    if (!id) continue;
    const main = li.querySelector('.card-main');
    if (!main) continue;
    // Sin línea de rama en la card: el estado git vive en el punto del botón cerrar.
    main.querySelector('.card-git')?.remove();
    const gb = gitBadges.get(id);
    if (gb) {
      (li as HTMLElement).dataset.git = gb.dirty ? 'dirty' : 'clean';
    } else {
      delete (li as HTMLElement).dataset.git;
    }
  }
  // Espacios (Fase 2): refresca los dots agregados del rail (la actividad git
  // de secciones ocultas debe seguir siendo perceptible).
  renderSpacesRail();
}

const git = initGit({
  apiBase: API_BASE,
  getActiveSection: () => {
    if (!activeId) return undefined;
    const s = sections.get(activeId);
    if (!s) return undefined;
    return { sectionId: s.sectionId, cwd: s.cwd };
  },
  uiConfirm,
  uiAlert,
  uiPrompt,
  onBadges: applyGitBadges,
  getRouterId: () => selectedRouterId,
  speakOnce: (text: string) => {
    // A demanda (clic en 🔊): suena aunque la sección esté muteada —el mute
    // frena la voz ambiental del agente, no una petición explícita— y no
    // cambia el estado de mute.
    if (!activeId) return;
    const v = getSectionVoice(activeId);
    v.tts.push(text);
    v.tts.flush();
  },
  // INVARIANTE (espacios Fase 2): el barrido de badges ve TODAS las secciones;
  // el filtro por espacio solo afecta a la lista visible, nunca a este getter.
  getAllSections: () => [...sections.values()].map((s) => ({ sectionId: s.sectionId, cwd: s.cwd })),
});

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
// Marca de la migración al default "silenciada": antes la ausencia de entrada
// significaba "con voz"; ahora significa "sin voz".
const MUTE_MIGRATED_KEY = 'bennzen.section-mute.default-off';

function loadMutedSections(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(MUTE_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

/**
 * Estado de silencio de una sección. Toda sección NUEVA nace silenciada: sin
 * entrada explícita en el mapa se considera muteada, y es el usuario quien
 * abre la voz con el botón del altavoz.
 */
function isSectionMuted(sectionId: string, map = loadMutedSections()): boolean {
  return map[sectionId] !== false;
}

function saveSectionMute(sectionId: string, isMuted: boolean): void {
  const map = loadMutedSections();
  map[sectionId] = isMuted; // explícito en ambos sentidos (el default es muteada)
  localStorage.setItem(MUTE_STORAGE_KEY, JSON.stringify(map));
}

/** Olvida el estado de una sección (al cerrarla) para no acumular basura. */
function clearSectionMute(sectionId: string): void {
  const map = loadMutedSections();
  delete map[sectionId];
  localStorage.setItem(MUTE_STORAGE_KEY, JSON.stringify(map));
}

/**
 * Migración única: con la semántica anterior, las secciones ya existentes sin
 * entrada tenían voz. Se les escribe `false` explícito para que el nuevo default
 * (silencio) solo afecte a las secciones creadas de aquí en adelante.
 */
function migrateMuteDefaults(existingIds: string[]): void {
  if (localStorage.getItem(MUTE_MIGRATED_KEY)) return;
  const map = loadMutedSections();
  for (const id of existingIds) if (map[id] === undefined) map[id] = false;
  localStorage.setItem(MUTE_STORAGE_KEY, JSON.stringify(map));
  localStorage.setItem(MUTE_MIGRATED_KEY, '1');
}

function getSectionVoice(sectionId: string): SectionVoice {
  let v = sectionVoices.get(sectionId);
  if (!v) {
    const sTts = createTts(voiceCfg.tts, voiceCfg);
    const mutedMap = loadMutedSections();
    v = {
      tts: sTts,
      speaking: false,
      muted: isSectionMuted(sectionId, mutedMap),
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
    updateMuteButton(muteBtnEl, v.muted);
    muteBtnEl.title = v.muted ? 'Activar voz en esta sección' : 'Silenciar voz en esta sección';
  }
  // Espacios (Fase 2): el dot de voz del rail refleja si alguien habla en un
  // espacio no visible (se llama en cambios de estado, no en niveles).
  renderSpacesRail();
}

function updateCardVoiceLevel(sectionId: string, lvl: number): void {
  const card = document.querySelector<HTMLElement>(`#sections .card[data-section-id="${sectionId}"]`);
  if (card) {
    card.style.setProperty('--voice-level', String(lvl));
  }
}

function updateMainMuteBtn(): void {
  if (!activeId) {
    updateMuteButton(muteBtn, false);
    muteBtn.title = 'Silenciar voz';
    return;
  }
  const v = getSectionVoice(activeId);
  updateMuteButton(muteBtn, v.muted);
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
    const val = JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY) || '[]');
    return Array.isArray(val) ? val.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

// ---- Espacios: orden por bucket (Fase 3) -----------------------------------
// Cada vista tiene su bucket en `bennzen.section-order.v1`: el id del espacio
// o 'all'. La clave legacy (`bennzen.section-order`) solo se lee como
// fallback de la vista «Todas» hasta el primer reorden; NUNCA se escribe
// (downgrade seguro: la app vieja la sigue usando).

/** Bucket de orden de la vista visible (`'all'` o id de espacio). */
function visibleOrderBucket(): string {
  const view = getActiveView();
  return view === ALL_VIEW ? ALL_VIEW : view;
}

/**
 * Orden efectivo de la vista «Todas»: bucket v1 si ya existe; si no, el orden
 * global legacy (solo lectura). Así se conserva la disposición anterior hasta
 * que el usuario reordena por primera vez en la nueva versión.
 */
function effectiveAllOrder(): string[] {
  const stored = getOrderBucket(ALL_VIEW);
  if (stored.length > 0) return stored;
  return loadSectionOrder();
}

/** Ordena una lista según un bucket; los IDs ausentes conservan su orden relativo al final. */
function sortByOrder(list: UiSection[], order: string[]): UiSection[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  list.sort((a, b) => {
    const rankA = rank.get(a.sectionId);
    const rankB = rank.get(b.sectionId);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return 0;
  });
  return list;
}

function orderInBucket(bucket: string): string[] {
  return bucket === ALL_VIEW ? effectiveAllOrder() : getOrderBucket(bucket);
}

function getOrderedSections(): UiSection[] {
  return sortByOrder([...sections.values()], orderInBucket(visibleOrderBucket()));
}

/** Saca una sección de todos los buckets salvo `'all'` (se va de su espacio). */
function removeFromSpaceBuckets(orders: Record<string, string[]>, sectionId: string): void {
  for (const [bucket, ids] of Object.entries(orders)) {
    if (bucket === ALL_VIEW) continue;
    const idx = ids.indexOf(sectionId);
    if (idx !== -1) ids.splice(idx, 1);
  }
}

/**
 * Mueve una sección a otro espacio (`ALL_VIEW` = desasignar, queda sin
 * espacio). Persiste membresía + orden y repinta. No toca `activeId`: el panel
 * sigue mostrando la sección aunque salga de la vista visible.
 */
function moveSectionToSpace(sectionId: string, dest: string): void {
  const moved = sections.get(sectionId);
  if (!moved) return;
  const to = dest === ALL_VIEW ? null : dest;
  if (to && !loadSpaces().some((s) => s.id === to)) return;
  const membership = loadSectionSpace();
  if ((membership[sectionId] ?? null) === to) return;
  if (to) membership[sectionId] = to;
  else delete membership[sectionId];
  saveSectionSpace(membership);
  const orders = loadSpaceOrders();
  removeFromSpaceBuckets(orders, sectionId);
  const destBucket = to ?? UNASSIGNED_BUCKET;
  orders[destBucket] = [...(orders[destBucket] ?? []).filter((id) => id !== sectionId), sectionId];
  if (orders[ALL_VIEW]?.length && !orders[ALL_VIEW].includes(sectionId)) {
    orders[ALL_VIEW].push(sectionId);
  }
  saveSpaceOrders(orders);
  render();
  const title = moved.customTitle || moved.agent;
  const destName = to ? (loadSpaces().find((sp) => sp.id === to)?.name ?? 'el espacio') : 'Todas';
  toast(`Sección «${title}» movida a «${destName}».`);
}

// ---- Espacios: vista activa + filtrado + rail (Fase 2) ---------------------

/** Vista activa (`'all'` o id de espacio existente; lo desconocido cae a `'all'`). */
function getActiveView(): string {
  const stored = loadActiveSpace();
  if (stored === ALL_VIEW) return ALL_VIEW;
  return loadSpaces().some((s) => s.id === stored) ? stored : ALL_VIEW;
}

/** Normaliza la vista persistida (p. ej. el espacio se eliminó en otra pestaña). */
function ensureValidActiveView(): string {
  const view = getActiveView();
  if (loadActiveSpace() !== view) saveActiveSpace(view);
  return view;
}

/**
 * Secciones visibles en la vista activa, sobre `getOrderedSections()` + membresía.
 * Las secciones sin espacio solo aparecen en «Todas». El filtro solo afecta a
 * la lista visible: `getAllSections()` (barrido git) sigue viendo TODAS.
 */
function getVisibleSections(): UiSection[] {
  const view = getActiveView();
  const ordered = getOrderedSections();
  if (view === ALL_VIEW) return ordered;
  const membership = loadSectionSpace();
  return ordered.filter((s) => membership[s.sectionId] === view);
}

/** Dots agregados de un conjunto de secciones: voz hablando y git con cambios. */
function spaceDots(memberIds: string[]): { speaking: boolean; gitDirty: boolean } {
  let speaking = false;
  let gitDirty = false;
  for (const id of memberIds) {
    if (!speaking) {
      const v = sectionVoices.get(id);
      if (v && v.speaking && !v.muted) speaking = true;
    }
    if (!gitDirty && gitBadges.get(id)?.dirty) gitDirty = true;
    if (speaking && gitDirty) break;
  }
  return { speaking, gitDirty };
}

function makeRailItem(opts: {
  id: string;
  short: string;
  full?: string;
  all?: boolean;
  tip: string;
  active: boolean;
  hue?: number;
  dots?: { speaking: boolean; gitDirty: boolean };
}): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = `rail-item${opts.all ? ' rail-item-all' : ''}${opts.active ? ' active' : ''}`;
  btn.dataset.spaceId = opts.id;
  btn.title = opts.tip;
  btn.setAttribute('aria-label', opts.tip);
  if (opts.active) btn.setAttribute('aria-current', 'true');
  if (opts.hue !== undefined) btn.style.setProperty('--space-hue', String(opts.hue));
  const short = document.createElement('span');
  short.className = 'rail-short';
  short.textContent = opts.short;
  btn.append(short);
  if (opts.full) {
    const full = document.createElement('span');
    full.className = 'rail-full';
    full.textContent = opts.full;
    btn.append(full);
  }
  if (opts.dots && (opts.dots.speaking || opts.dots.gitDirty)) {
    const dots = document.createElement('span');
    dots.className = 'rail-dots';
    if (opts.dots.speaking) {
      const d = document.createElement('span');
      d.className = 'dot dot-speaking';
      d.title = 'Alguien hablando en este espacio';
      dots.appendChild(d);
    }
    if (opts.dots.gitDirty) {
      const d = document.createElement('span');
      d.className = 'dot dot-git';
      d.title = 'Cambios git sin commitear en este espacio';
      dots.appendChild(d);
    }
    btn.appendChild(dots);
  }
  return btn;
}

/**
 * Hace un item del rail destino de arrastre: soltar una card la mueve a ese
 * espacio (o la desasigna si es «Todas»). Resalta con `drag-over` mientras el
 * arrastre está encima. Ignora arrastres externos (archivos, texto).
 */
function attachRailDrop(btn: HTMLButtonElement, destSpaceId: string): void {
  btn.addEventListener('dragover', (e) => {
    if (!draggedSectionId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    btn.classList.add('drag-over');
  });
  btn.addEventListener('dragleave', (e) => {
    if (!btn.contains(e.relatedTarget as Node | null)) btn.classList.remove('drag-over');
  });
  btn.addEventListener('drop', (e) => {
    e.preventDefault();
    btn.classList.remove('drag-over');
    const id = draggedSectionId || e.dataTransfer?.getData('text/plain');
    if (!id) return;
    moveSectionToSpace(id, destSpaceId);
  });
}

/** Pinta el rail: «Todas» + espacios + «+», con conteos y dots agregados. */
function renderSpacesRail(): void {
  const rail = document.querySelector<HTMLElement>('#spaces-rail');
  if (!rail) return;
  const view = getActiveView();
  const spaces = loadSpaces();
  const membership = loadSectionSpace();
  const allIds = [...sections.keys()];
  rail.innerHTML = '';

  const allBtn = makeRailItem({
    id: ALL_VIEW,
    short: '✦',
    all: true,
    tip: `Todas las secciones (${allIds.length}). Atajo: Alt+1.`,
    active: view === ALL_VIEW,
  });
  allBtn.addEventListener('click', () => switchSpaceView(ALL_VIEW));
  attachRailDrop(allBtn, ALL_VIEW);
  rail.appendChild(allBtn);

  for (let i = 0; i < spaces.length; i++) {
    const space = spaces[i];
    const memberIds = allIds.filter((id) => membership[id] === space.id);
    const shortcut = i + 2 <= 9 ? ` Atajo: Alt+${i + 2}.` : '';
    const tip =
      `${space.name} — ${memberIds.length} ${memberIds.length === 1 ? 'sección' : 'secciones'}. ` +
      `Doble clic para renombrar, clic derecho para eliminar.${shortcut}`;
    const btn = makeRailItem({
      id: space.id,
      short: space.name.trim().slice(0, 1).toUpperCase() || '·',
      full: space.name,
      tip,
      active: view === space.id,
      hue: resolveSpaceColor(space, spaces),
      dots: spaceDots(memberIds),
    });
    btn.addEventListener('click', () => switchSpaceView(space.id));
    btn.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      void renameSpace(space.id);
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void deleteSpace(space.id);
    });
    attachRailDrop(btn, space.id);
    rail.appendChild(btn);
  }

  const add = document.createElement('button');
  add.className = 'rail-item rail-add';
  add.title = 'Crear espacio';
  add.setAttribute('aria-label', 'Crear espacio');
  const plus = document.createElement('span');
  plus.className = 'rail-short';
  plus.textContent = '+';
  add.appendChild(plus);
  add.addEventListener('click', () => void createSpace());
  rail.appendChild(add);
}

/** Cambia de vista recordando la última sección activa de cada una. */
function switchSpaceView(view: string): void {
  const prev = getActiveView();
  if (view === prev) return;
  if (activeId && sections.has(activeId)) setSpaceActive(prev, activeId);
  saveActiveSpace(view);
  const visible = getVisibleSections();
  const ids = new Set(visible.map((s) => s.sectionId));
  const remembered = getSpaceActive(view);
  if (remembered && ids.has(remembered)) {
    activeId = remembered;
  } else if (!activeId || !ids.has(activeId)) {
    activeId = visible[0]?.sectionId ?? null;
  }
  if (activeId) setSpaceActive(view, activeId);
  render();
}

function newSpaceId(): string {
  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Paleta pastel para el color del espacio. Devuelve el tono elegido o null
 * si se omite (Omitir / backdrop / Escape): al crear se usa la sugerencia,
 * al renombrar se conserva el color actual.
 */
function pickSpaceColor(preselect: number): Promise<number | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'space-color-overlay';
    const pop = document.createElement('div');
    pop.className = 'space-color-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Elegir color del espacio');
    const title = document.createElement('p');
    title.className = 'space-color-title';
    title.textContent = 'Color del espacio';
    const grid = document.createElement('div');
    grid.className = 'space-color-grid';
    let selected = SPACE_PALETTE.includes(preselect) ? preselect : SPACE_PALETTE[0];
    const swatches: HTMLButtonElement[] = [];
    for (const hue of SPACE_PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'space-swatch';
      b.style.setProperty('--space-hue', String(hue));
      b.setAttribute('aria-label', `Tono ${hue}`);
      b.addEventListener('click', () => {
        selected = hue;
        paint();
      });
      swatches.push(b);
      grid.appendChild(b);
    }
    const paint = (): void => {
      swatches.forEach((b, i) => b.classList.toggle('selected', SPACE_PALETTE[i] === selected));
    };
    paint();
    const row = document.createElement('div');
    row.className = 'space-color-actions';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'ghost mini';
    skip.textContent = 'Omitir';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary-btn mini';
    ok.textContent = 'Elegir';
    const done = (v: number | null): void => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    ok.addEventListener('click', () => done(selected));
    skip.addEventListener('click', () => done(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(null);
    });
    document.addEventListener('keydown', onKey, true);
    row.append(skip, ok);
    pop.append(title, grid, row);
    overlay.appendChild(pop);
    document.body.appendChild(overlay);
    ok.focus();
  });
}

async function createSpace(): Promise<void> {
  const name = await uiPrompt('Crear espacio', '', 'Nombre del espacio');
  const trimmed = (name ?? '').trim();
  if (!trimmed) return;
  const spaces = loadSpaces();
  const id = newSpaceId();
  const suggestion = resolveSpaceColor({ id, name: trimmed, createdAt: Date.now() }, spaces);
  const color = (await pickSpaceColor(suggestion)) ?? suggestion;
  spaces.push({ id, name: trimmed, createdAt: Date.now(), color });
  saveSpaces(spaces);
  switchSpaceView(id);
  toast(`Espacio «${trimmed}» creado.`);
}

async function renameSpace(spaceId: string): Promise<void> {
  const spaces = loadSpaces();
  const space = spaces.find((s) => s.id === spaceId);
  if (!space) return;
  const name = await uiPrompt('Renombrar espacio', space.name, 'Nombre del espacio');
  const trimmed = (name ?? '').trim();
  if (!trimmed) return;
  const color = await pickSpaceColor(resolveSpaceColor(space, spaces));
  let changed = false;
  if (trimmed !== space.name) {
    space.name = trimmed;
    changed = true;
  }
  if (color !== null && color !== space.color) {
    space.color = color;
    changed = true;
  }
  if (!changed) return;
  saveSpaces(spaces);
  render();
  toast(`Espacio «${space.name}» actualizado.`);
}

async function deleteSpace(spaceId: string): Promise<void> {
  const spaces = loadSpaces();
  const space = spaces.find((s) => s.id === spaceId);
  if (!space) return;
  const membership = loadSectionSpace();
  const liveMembers = [...sections.keys()].filter((id) => membership[id] === spaceId).length;
  // Las restaurables (guardadas pero no vivas) también pierden su espacio.
  const restorableMembers = getRestorableIds(sections.keys()).filter((id) => membership[id] === spaceId).length;
  const affected = liveMembers + restorableMembers;
  const detail =
    affected === 0
      ? `El espacio «${space.name}» se eliminará.`
      : affected === 1
        ? `El espacio «${space.name}» se eliminará. Su sección pasará a «Todas» (no se cierra).`
        : `El espacio «${space.name}» se eliminará. Sus ${affected} secciones pasarán a «Todas» (no se cierran).`;
  const ok = await uiConfirm(detail, 'Eliminar espacio', true);
  if (!ok) return;
  saveSpaces(spaces.filter((s) => s.id !== spaceId));
  // Los miembros (vivos o guardados para restaurar) quedan sin espacio;
  // nunca se cierran secciones al eliminar un espacio.
  const next = loadSectionSpace();
  for (const [id, sid] of Object.entries(next)) {
    if (sid === spaceId) delete next[id];
  }
  saveSectionSpace(next);
  // Limpia el bucket de orden del espacio eliminado (sus IDs siguen en 'all').
  const orders = loadSpaceOrders();
  if (orders[spaceId] !== undefined) {
    delete orders[spaceId];
    saveSpaceOrders(orders);
  }
  if (getActiveView() === spaceId) saveActiveSpace(ALL_VIEW);
  if (activeId && !sections.has(activeId)) {
    const visible = getVisibleSections();
    activeId = visible[0]?.sectionId ?? [...sections.keys()][0] ?? null;
  }
  render();
  toast(
    affected === 0
      ? `Espacio «${space.name}» eliminado.`
      : affected === 1
        ? `Espacio «${space.name}» eliminado — su sección pasó a «Todas».`
        : `Espacio «${space.name}» eliminado — sus ${affected} secciones pasaron a «Todas».`,
  );
}

// Multi-pestaña: re-render cuando otra pestaña toca los espacios (evento storage).
window.addEventListener('storage', (e) => {
  if (
    e.key === SPACES_KEY ||
    e.key === ACTIVE_SPACE_KEY ||
    e.key === SECTION_SPACE_KEY ||
    e.key === SPACE_ACTIVE_KEY ||
    e.key === SECTION_ORDER_V1_KEY ||
    e.key === SECTION_CONFIG_KEY
  ) {
    render();
  }
});

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
    // Antes de leer el mapa: preserva el estado de las secciones que ya existían
    // (el default "silenciada" solo aplica a las nuevas).
    migrateMuteDefaults(m.sessions.map((s) => s.sectionId));
    const mutedMap = loadMutedSections();
    for (const info of m.sessions) {
      // Restauración (Fase 4): el servidor conoce este ID → ya está vivo.
      pendingRestore.delete(info.sectionId);
      const isMuted = isSectionMuted(info.sectionId, mutedMap);
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
              void ex.term.writeSilent(info.scrollback);
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
      // Espacios (Fase 1): refresca la config restaurable con los datos del
      // servidor (incl. geometría cols/rows en pty). No purga nada: la
      // restauración se basa en estas claves y solo closeSection() las purga.
      saveSectionConfig(info.sectionId, {
        agent: info.agent,
        mode: info.mode,
        kind: info.kind,
        cwd: info.cwd,
        cols: info.cols,
        rows: info.rows,
      });
    }
    // INVARIANTE (espacios Fase 1): este prune solo retira de la UI las
    // secciones ausentes del snapshot (p. ej. tras reiniciar el orquestador).
    // NO purga `section-config` ni membresías: esas claves son la base de la
    // restauración y solo closeSection() (cierre explícito con ✕) las purga.
    for (const id of [...sections.keys()]) {
      // Restauración en curso: no podar sus optimistas (el servidor aún no
      // los conoce; un rechazo los retira vía dropRestoredZombie).
      if (!incoming.has(id) && !(restoreProgress && pendingRestore.has(id))) {
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
      // Espacios (Fase 2): prefiere una sección visible en la vista activa.
      const visible = getVisibleSections();
      activeId = visible[0]?.sectionId ?? sections.keys().next().value ?? null;
    }
    updateMainMuteBtn();
    render();
  } else if (m.t === 'created') {
    pendingRestore.delete(m.sectionId); // Restauración (Fase 4): confirmada por el servidor
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
    git.notifyActivity(m.sectionId);
    render();
  } else if (m.t === 'term-data') {
    const s = sections.get(m.sectionId);
    if (!s) return;
    git.notifyActivity(m.sectionId);
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
    // Restauración (Fase 4): el servidor rechazó un create restaurado (p. ej.
    // cwd inválido). Se retira la sección local optimista SIN purgar storage
    // (sigue restaurable) y se comunica el fallo sin abortar el resto.
    if (m.sectionId && pendingRestore.has(m.sectionId)) {
      dropRestoredZombie(m.sectionId, m.message);
      render();
      return;
    }
    const s = m.sectionId ? sections.get(m.sectionId) : undefined;
    if (s) s.entries.push({ role: 'error', text: m.message });
    else vhint.textContent = `⚠️ ${m.message}`;
    render();
  }
});

// ---- Routers & Agentes Claude Code (CRUD + Test + Sincronización) --------
let availableRouters: RouterConfig[] = [];
let selectedRouterId: string | null = null;

const routersListEl = $('#routers-list');
const routerNewBtn = $('#router-btn-new');
const routerSaveBtn = $('#router-btn-save');
const routerTestBtn = $<HTMLButtonElement>('#router-btn-test');
const routerDelBtn = $('#router-btn-delete');
const routerFeedback = $('#router-test-feedback');

const routerInputs = {
  id: $<HTMLInputElement>('#router-id'),
  name: $<HTMLInputElement>('#router-name'),
  slug: $<HTMLInputElement>('#router-slug'),
  baseUrl: $<HTMLInputElement>('#router-base-url'),
  apiKey: $<HTMLInputElement>('#router-api-key'),
  opus: $<HTMLInputElement>('#router-model-opus'),
  sonnet: $<HTMLInputElement>('#router-model-sonnet'),
  haiku: $<HTMLInputElement>('#router-model-haiku'),
  autoCompact: $<HTMLInputElement>('#router-auto-compact'),
};

function updateAgentSelect(): void {
  const agentSelect = $<HTMLSelectElement>('#agent');
  const currentVal = agentSelect.value;
  agentSelect.innerHTML = `
    <optgroup label="Agentes Nativos">
      <option value="mock">mock (eco)</option>
      <option value="opencode">opencode</option>
      <option value="claude">claude</option>
      <option value="codex">codex</option>
      <option value="mini">mini (MiniMax M3)</option>
      <option value="qwen">qwen (Bailian Qwen)</option>
      <option value="agy">agy (Antigravity)</option>
      <option value="muse">muse</option>
    </optgroup>
  `;
  if (availableRouters.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Routers Personalizados';
    for (const r of availableRouters) {
      const opt = document.createElement('option');
      opt.value = r.id;
      const host = r.baseUrl.replace(/^https?:\/\//, '').split('/')[0];
      opt.textContent = `${r.name} (${host})`;
      group.appendChild(opt);
    }
    agentSelect.appendChild(group);
  }
  if (currentVal && [...agentSelect.options].some((o) => o.value === currentVal)) {
    agentSelect.value = currentVal;
  }
}

async function fetchRouters(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/routers`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    availableRouters = (await res.json()) as RouterConfig[];
    updateAgentSelect();
    renderRoutersList();
  } catch (err) {
    console.warn('[routers] No se pudieron cargar los routers:', err);
  }
}
void fetchRouters();

function renderRoutersList(): void {
  routersListEl.innerHTML = '';
  if (availableRouters.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'routers-empty';
    empty.textContent = 'Sin routers creados. Pulsa ＋ Nuevo.';
    routersListEl.appendChild(empty);
    return;
  }
  for (const r of availableRouters) {
    const li = document.createElement('li');
    li.className = `router-item${selectedRouterId === r.id ? ' active' : ''}`;

    const info = document.createElement('div');
    info.className = 'router-item-info';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'router-item-name';
    nameSpan.textContent = r.name;

    const host = r.baseUrl.replace(/^https?:\/\//, '').split('/')[0];
    const subSpan = document.createElement('span');
    subSpan.className = 'router-item-sub';
    subSpan.textContent = `${r.id} · ${host}`;

    info.append(nameSpan, subSpan);

    const del = document.createElement('button');
    del.className = 'router-item-del';
    del.type = 'button';
    del.title = 'Eliminar router';
    del.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h18"></path>
        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
      </svg>
    `;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteCurrentRouter(r.id);
    });

    li.append(info, del);
    li.addEventListener('click', () => selectRouter(r.id));
    routersListEl.appendChild(li);
  }
}

function selectRouter(id: string | null): void {
  selectedRouterId = id;
  routerFeedback.hidden = true;
  routerFeedback.className = 'router-feedback';
  routerFeedback.textContent = '';

  if (!id) {
    routerInputs.id.value = '';
    routerInputs.name.value = '';
    routerInputs.slug.value = '';
    routerInputs.baseUrl.value = '';
    routerInputs.apiKey.value = '';
    routerInputs.opus.value = '';
    routerInputs.sonnet.value = '';
    routerInputs.haiku.value = '';
    routerInputs.autoCompact.value = '500000';
    routerDelBtn.hidden = true;
  } else {
    const r = availableRouters.find((item) => item.id === id);
    if (r) {
      routerInputs.id.value = r.id;
      routerInputs.name.value = r.name;
      routerInputs.slug.value = r.id;
      routerInputs.baseUrl.value = r.baseUrl;
      routerInputs.apiKey.value = r.apiKey;
      routerInputs.opus.value = r.opusModel || '';
      routerInputs.sonnet.value = r.sonnetModel || '';
      routerInputs.haiku.value = r.haikuModel || '';
      routerInputs.autoCompact.value = r.autoCompactWindow || '500000';
      routerDelBtn.hidden = false;
    }
  }
  renderRoutersList();
}

routerNewBtn.addEventListener('click', () => selectRouter(null));

async function testCurrentRouter(): Promise<void> {
  const baseUrl = routerInputs.baseUrl.value.trim();
  const apiKey = routerInputs.apiKey.value.trim();
  if (!baseUrl || !apiKey) {
    routerFeedback.className = 'router-feedback error';
    routerFeedback.textContent = '⚠️ Se requieren Base URL y API Key para probar la conexión.';
    routerFeedback.hidden = false;
    return;
  }

  routerFeedback.className = 'router-feedback testing';
  routerFeedback.textContent = '⏳ Probando conexión con el proveedor…';
  routerFeedback.hidden = false;
  routerTestBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/routers/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl,
        apiKey,
        opusModel: routerInputs.opus.value.trim() || undefined,
        sonnetModel: routerInputs.sonnet.value.trim() || undefined,
        haikuModel: routerInputs.haiku.value.trim() || undefined,
      }),
    });
    const result = (await res.json()) as RouterTestResult;
    if (result.ok) {
      routerFeedback.className = 'router-feedback success';
      routerFeedback.textContent = `✓ Conexión exitosa con el proveedor (${result.latencyMs ?? 0} ms)`;
    } else {
      routerFeedback.className = 'router-feedback error';
      routerFeedback.textContent = `⚠️ Fallo: ${result.error || 'Error desconocido'}`;
    }
  } catch (err) {
    routerFeedback.className = 'router-feedback error';
    routerFeedback.textContent = `⚠️ Error de red al probar conexión: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    routerTestBtn.disabled = false;
    routerFeedback.hidden = false;
  }
}

async function saveCurrentRouter(): Promise<void> {
  const name = routerInputs.name.value.trim();
  const slug = routerInputs.slug.value.trim();
  const baseUrl = routerInputs.baseUrl.value.trim();
  const apiKey = routerInputs.apiKey.value.trim();

  if (!name || !baseUrl || !apiKey) {
    routerFeedback.className = 'router-feedback error';
    routerFeedback.textContent = '⚠️ Por favor completa Nombre, Base URL y API Key.';
    routerFeedback.hidden = false;
    return;
  }

  const payload: Partial<RouterConfig> & { name: string; baseUrl: string; apiKey: string } = {
    id: slug || undefined,
    name,
    baseUrl,
    apiKey,
    opusModel: routerInputs.opus.value.trim() || undefined,
    sonnetModel: routerInputs.sonnet.value.trim() || undefined,
    haikuModel: routerInputs.haiku.value.trim() || undefined,
    autoCompactWindow: routerInputs.autoCompact.value.trim() || '500000',
  };

  try {
    const res = await fetch(`${API_BASE}/api/routers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error((errJson as { error?: string }).error || `HTTP ${res.status}`);
    }
    const saved = (await res.json()) as RouterConfig;
    await fetchRouters();
    selectRouter(saved.id);
    routerFeedback.className = 'router-feedback success';
    routerFeedback.textContent = `✓ Router '${saved.name}' guardado correctamente. Ya está disponible en la lista de agentes.`;
    routerFeedback.hidden = false;
    render();
  } catch (err) {
    routerFeedback.className = 'router-feedback error';
    routerFeedback.textContent = `⚠️ Error al guardar: ${err instanceof Error ? err.message : String(err)}`;
    routerFeedback.hidden = false;
  }
}

async function deleteCurrentRouter(routerId?: string): Promise<void> {
  const targetId = routerId || selectedRouterId;
  if (!targetId) return;
  const r = availableRouters.find((item) => item.id === targetId);
  const name = r?.name || targetId;
  const ok = await uiConfirm(`¿Eliminar el router '${name}'?`, 'Eliminar Router', true);
  if (!ok) return;

  try {
    const res = await fetch(`${API_BASE}/api/routers/${encodeURIComponent(targetId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchRouters();
    if (selectedRouterId === targetId) {
      selectRouter(availableRouters.length > 0 ? availableRouters[0].id : null);
    } else {
      renderRoutersList();
    }
    render();
  } catch (err) {
    await uiAlert(`Error al eliminar router: ${err instanceof Error ? err.message : String(err)}`, 'Error', 'error');
  }
}

routerTestBtn.addEventListener('click', () => void testCurrentRouter());
routerSaveBtn.addEventListener('click', () => void saveCurrentRouter());
routerDelBtn.addEventListener('click', () => void deleteCurrentRouter());

// ---- Proyectos & Carpetas (CRUD + Exploración) ---------------------------
let availableProjects: ProjectConfig[] = [];
let selectedProjectId: string | null = null;

const projectsListEl = $('#projects-list');
const projectNewBtn = $('#project-btn-new');
const projectSaveBtn = $('#project-btn-save');
const projectDelBtn = $('#project-btn-delete');
const projectBrowseBtn = $('#project-btn-browse');
const projectDirChips = $('#project-dir-chips');
const projectFeedback = $('#project-feedback');

const projectInputs = {
  id: $<HTMLInputElement>('#project-id'),
  name: $<HTMLInputElement>('#project-name'),
  path: $<HTMLInputElement>('#project-path'),
  tag: $<HTMLInputElement>('#project-tag'),
};

const nsProjectSelect = $<HTMLSelectElement>('#ns-project');
const nsBtnQuickProject = $<HTMLButtonElement>('#ns-btn-quick-project');
const nsQuickProjectBox = $('#ns-quick-project-box');
const nsQuickName = $<HTMLInputElement>('#ns-quick-name');
const nsQuickPath = $<HTMLInputElement>('#ns-quick-path');
const nsQuickSave = $<HTMLButtonElement>('#ns-quick-save');
const nsQuickCancel = $<HTMLButtonElement>('#ns-quick-cancel');

function getSelectedProjectCwd(): { path: string; project?: ProjectConfig } {
  const val = nsProjectSelect.value;
  const p = availableProjects.find((item) => item.id === val);
  return {
    path: p ? p.path : '.',
    project: p,
  };
}

function updateProjectSelect(): void {
  const currentVal = nsProjectSelect.value;
  nsProjectSelect.innerHTML = '';

  if (availableProjects.length > 0) {
    for (const p of availableProjects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      const tagSuffix = p.tag ? ` [${p.tag}]` : '';
      opt.textContent = `${p.name}${tagSuffix} — ${formatShortPath(p.path)}`;
      nsProjectSelect.appendChild(opt);
    }
  } else {
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '(Sin proyectos guardados — Vincula uno arriba)';
    nsProjectSelect.appendChild(emptyOpt);
  }

  if (currentVal && [...nsProjectSelect.options].some((o) => o.value === currentVal)) {
    nsProjectSelect.value = currentVal;
  } else if (availableProjects.length > 0) {
    nsProjectSelect.value = availableProjects[0].id;
  }
}

async function fetchProjects(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/projects`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    availableProjects = (await res.json()) as ProjectConfig[];
    updateProjectSelect();
    renderProjectsList();
  } catch (err) {
    console.warn('[projects] No se pudieron cargar los proyectos:', err);
  }
}
void fetchProjects();

function renderProjectsList(): void {
  projectsListEl.innerHTML = '';
  if (availableProjects.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'routers-empty';
    empty.textContent = 'Sin proyectos registrados. Pulsa ＋ Nuevo.';
    projectsListEl.appendChild(empty);
    return;
  }
  for (const p of availableProjects) {
    const li = document.createElement('li');
    li.className = `router-item${selectedProjectId === p.id ? ' active' : ''}`;

    const info = document.createElement('div');
    info.className = 'router-item-info';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'router-item-name';
    nameSpan.textContent = p.name;
    if (p.tag) {
      const tagBadge = document.createElement('span');
      tagBadge.className = 'router-tag-badge';
      tagBadge.textContent = p.tag;
      nameSpan.appendChild(tagBadge);
    }

    const subSpan = document.createElement('span');
    subSpan.className = 'router-item-sub';
    subSpan.textContent = p.path;

    info.append(nameSpan, subSpan);

    const del = document.createElement('button');
    del.className = 'router-item-del';
    del.type = 'button';
    del.title = 'Eliminar proyecto';
    del.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h18"></path>
        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
      </svg>
    `;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteCurrentProject(p.id);
    });

    li.append(info, del);
    li.addEventListener('click', () => selectProject(p.id));
    projectsListEl.appendChild(li);
  }
}

function selectProject(id: string | null): void {
  selectedProjectId = id;
  projectFeedback.hidden = true;
  projectFeedback.className = 'router-feedback';
  projectFeedback.textContent = '';
  projectDirChips.hidden = true;

  if (!id) {
    projectInputs.id.value = '';
    projectInputs.name.value = '';
    projectInputs.path.value = '';
    projectInputs.tag.value = '';
    projectDelBtn.hidden = true;
  } else {
    const p = availableProjects.find((item) => item.id === id);
    if (p) {
      projectInputs.id.value = p.id;
      projectInputs.name.value = p.name;
      projectInputs.path.value = p.path;
      projectInputs.tag.value = p.tag || '';
      projectDelBtn.hidden = false;
    }
  }
  renderProjectsList();
}

projectNewBtn.addEventListener('click', () => selectProject(null));

async function saveCurrentProject(): Promise<void> {
  const name = projectInputs.name.value.trim();
  const pathVal = projectInputs.path.value.trim();
  if (!name || !pathVal) {
    projectFeedback.className = 'router-feedback error';
    projectFeedback.textContent = '⚠️ Nombre y Ruta de directorio son requeridos.';
    projectFeedback.hidden = false;
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectInputs.id.value.trim() || undefined,
        name,
        path: pathVal,
        tag: projectInputs.tag.value.trim() || undefined,
      }),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error((errJson as { error?: string }).error || `HTTP ${res.status}`);
    }
    const saved = (await res.json()) as ProjectConfig;
    await fetchProjects();
    selectProject(saved.id);
    projectFeedback.className = 'router-feedback success';
    projectFeedback.textContent = `✓ Proyecto '${saved.name}' guardado correctamente.`;
    projectFeedback.hidden = false;
  } catch (err) {
    projectFeedback.className = 'router-feedback error';
    projectFeedback.textContent = `⚠️ Error al guardar: ${err instanceof Error ? err.message : String(err)}`;
    projectFeedback.hidden = false;
  }
}

async function deleteCurrentProject(projectId?: string): Promise<void> {
  const targetId = projectId || selectedProjectId;
  if (!targetId) return;
  const p = availableProjects.find((item) => item.id === targetId);
  const name = p?.name || targetId;
  const ok = await uiConfirm(`¿Eliminar el proyecto '${name}'?`, 'Eliminar Proyecto', true);
  if (!ok) return;

  try {
    const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(targetId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchProjects();
    if (selectedProjectId === targetId) {
      selectProject(availableProjects.length > 0 ? availableProjects[0].id : null);
    } else {
      renderProjectsList();
    }
  } catch (err) {
    await uiAlert(`Error al eliminar proyecto: ${err instanceof Error ? err.message : String(err)}`, 'Error al eliminar', 'error');
  }
}

async function exploreDirectories(targetDir?: string): Promise<void> {
  try {
    const q = targetDir ? `?dir=${encodeURIComponent(targetDir)}` : '';
    const res = await fetch(`${API_BASE}/api/fs/directories${q}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { current: string; parent: string | null; exists: boolean; dirs: string[] };

    projectDirChips.innerHTML = '';
    if (!data.exists) {
      const chip = document.createElement('span');
      chip.className = 'dir-chip';
      chip.textContent = '⚠️ Directorio no encontrado';
      projectDirChips.appendChild(chip);
      projectDirChips.hidden = false;
      return;
    }

    if (data.parent) {
      const parentChip = document.createElement('button');
      parentChip.className = 'dir-chip';
      parentChip.type = 'button';
      parentChip.textContent = '📁 .. (Subir nivel)';
      parentChip.addEventListener('click', () => {
        projectInputs.path.value = data.parent!;
        void exploreDirectories(data.parent!);
      });
      projectDirChips.appendChild(parentChip);
    }

    for (const d of data.dirs.slice(0, 30)) {
      const chip = document.createElement('button');
      chip.className = 'dir-chip';
      chip.type = 'button';
      chip.textContent = `📁 ${d}`;
      chip.addEventListener('click', () => {
        const next = data.current.endsWith('/') ? `${data.current}${d}` : `${data.current}/${d}`;
        projectInputs.path.value = next;
        void exploreDirectories(next);
      });
      projectDirChips.appendChild(chip);
    }

    projectDirChips.hidden = false;
  } catch (err) {
    console.warn('[fs] Error al explorar directorios:', err);
  }
}

const projectPickerBtn = $<HTMLButtonElement>('#project-btn-picker');
projectPickerBtn.addEventListener('click', async () => {
  projectPickerBtn.disabled = true;
  const originalHtml = projectPickerBtn.innerHTML;
  projectPickerBtn.innerHTML = '<span>Abriendo…</span>';
  try {
    const res = await fetch(`${API_BASE}/api/fs/pick-directory`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { path: string | null; name?: string; cancelled: boolean; error?: string };
    if (!data.cancelled && data.path) {
      projectInputs.path.value = data.path;
      if (!projectInputs.name.value.trim() && data.name) {
        projectInputs.name.value = data.name;
      }
      projectFeedback.className = 'router-feedback success';
      projectFeedback.textContent = `✓ Carpeta seleccionada: ${data.path}`;
      projectFeedback.hidden = false;
    } else if (data.error) {
      projectFeedback.className = 'router-feedback error';
      projectFeedback.textContent = `⚠️ ${data.error}`;
      projectFeedback.hidden = false;
    }
  } catch (err) {
    projectFeedback.className = 'router-feedback error';
    projectFeedback.textContent = `⚠️ Error al abrir explorador: ${err instanceof Error ? err.message : String(err)}`;
    projectFeedback.hidden = false;
  } finally {
    projectPickerBtn.disabled = false;
    projectPickerBtn.innerHTML = originalHtml;
  }
});

projectBrowseBtn.addEventListener('click', () => {
  const current = projectInputs.path.value.trim() || undefined;
  void exploreDirectories(current);
});
projectSaveBtn.addEventListener('click', () => void saveCurrentProject());
projectDelBtn.addEventListener('click', () => void deleteCurrentProject());

// Vinculación rápida de proyectos dentro de Nueva Sección
const nsQuickPickerBtn = $<HTMLButtonElement>('#ns-quick-picker');
nsQuickPickerBtn.addEventListener('click', async () => {
  nsQuickPickerBtn.disabled = true;
  const originalHtml = nsQuickPickerBtn.innerHTML;
  nsQuickPickerBtn.innerHTML = '<span>Abriendo…</span>';
  try {
    const res = await fetch(`${API_BASE}/api/fs/pick-directory`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { path: string | null; name?: string; cancelled: boolean; error?: string };
    if (!data.cancelled && data.path) {
      nsQuickPath.value = data.path;
      if (!nsQuickName.value.trim() && data.name) {
        nsQuickName.value = data.name;
      }
    } else if (data.error) {
      await uiAlert(`Error al abrir explorador: ${data.error}`, 'Explorador de Archivos', 'error');
    }
  } catch (err) {
    await uiAlert(`Error al abrir explorador: ${err instanceof Error ? err.message : String(err)}`, 'Explorador de Archivos', 'error');
  } finally {
    nsQuickPickerBtn.disabled = false;
    nsQuickPickerBtn.innerHTML = originalHtml;
  }
});

nsBtnQuickProject.addEventListener('click', () => {
  nsQuickProjectBox.hidden = !nsQuickProjectBox.hidden;
  if (!nsQuickProjectBox.hidden) {
    const current = getSelectedProjectCwd();
    nsQuickPath.value = current.path !== '.' ? current.path : '';
    nsQuickName.focus();
  }
});
nsQuickCancel.addEventListener('click', () => {
  nsQuickProjectBox.hidden = true;
});
nsQuickSave.addEventListener('click', async () => {
  const name = nsQuickName.value.trim();
  const pathVal = nsQuickPath.value.trim() || '.';
  if (!name) {
    await uiAlert('Por favor ingresa un nombre para el proyecto.', 'Nombre requerido');
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path: pathVal }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const saved = (await res.json()) as ProjectConfig;
    await fetchProjects();
    nsProjectSelect.value = saved.id;
    nsQuickProjectBox.hidden = true;
    nsQuickName.value = '';
    nsQuickPath.value = '';
  } catch (err) {
    await uiAlert(`Error al vincular proyecto: ${err instanceof Error ? err.message : String(err)}`, 'Error al vincular', 'error');
  }
});

// ---- Crear / cerrar sección ---------------------------------------------
// El formulario vive en un modal; el sidebar solo lista las secciones.
const newSectionOverlay = $('#new-section-modal');
function openNewSection(): void {
  updateAgentSelect();
  updateProjectSelect();
  updateSpaceSelect(); // default = vista activa
  renderProfiles(); // refresca la lista de perfiles guardados cada vez que se abre
  newSectionOverlay.hidden = false;
  // Foco inicial en el destino (Fase 5): elegir espacio antes de crear.
  setTimeout(() => $<HTMLSelectElement>('#ns-space').focus(), 60);
}

/** Llena el select «Espacio destino» del modal (default = vista activa). */
function updateSpaceSelect(): void {
  const sel = $<HTMLSelectElement>('#ns-space');
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Sin espacio (solo en Todas)';
  sel.appendChild(none);
  for (const space of loadSpaces()) {
    const opt = document.createElement('option');
    opt.value = space.id;
    opt.textContent = space.name;
    sel.appendChild(opt);
  }
  const view = getActiveView();
  sel.value = view === ALL_VIEW ? '' : view;
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

/**
 * Crea una sección (desde el form manual o desde un perfil) y la activa.
 * `spaceId`: destino explícito (`null`/'' = sin espacio); si se omite hereda
 * la vista activa (los perfiles rápidos usan este camino).
 */
function createSection(agent: AgentKind, mode: PermMode, kind: SectionKind, cwd: string, spaceId?: string | null): void {
  const sectionId = newSectionId();
  const view = getActiveView();
  let dest = spaceId === undefined ? (view === ALL_VIEW ? null : view) : spaceId || null;
  if (dest && !loadSpaces().some((s) => s.id === dest)) dest = null;
  // Nace SILENCIADA: nada de TTS hasta que el usuario active el altavoz.
  const s: UiSection = { sectionId, agent, mode, cwd, ready: false, kind, entries: [], muted: true };
  sections.set(sectionId, s);
  if (dest) setSpaceOf(sectionId, dest);
  // Orden: añade al bucket destino y al de «Todas» (materializándolo con el
  // orden efectivo actual si aún usaba el fallback legacy).
  const orders = loadSpaceOrders();
  const destBucket = dest ?? UNASSIGNED_BUCKET;
  orders[destBucket] = [...(orders[destBucket] ?? []).filter((id) => id !== sectionId), sectionId];
  if (!orders[ALL_VIEW]?.length) {
    orders[ALL_VIEW] = sortByOrder([...sections.values()], effectiveAllOrder()).map((sec) => sec.sectionId);
  } else if (!orders[ALL_VIEW].includes(sectionId)) {
    orders[ALL_VIEW].push(sectionId);
  }
  saveSpaceOrders(orders);
  saveSectionMute(sectionId, true);
  getSectionVoice(sectionId); // materializa el estado de voz ya muteado
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
  // Espacios (Fase 1): guarda la config restaurable (en pty incluye la
  // geometría recién medida por mountTerm).
  saveSectionConfig(sectionId, { agent, mode, kind, cwd, cols: s.cols, rows: s.rows });
}

$('#ns-create').addEventListener('click', () => {
  const agent = $<HTMLSelectElement>('#agent').value as AgentKind;
  const mode = $<HTMLSelectElement>('#mode').value as PermMode;
  const kind = $<HTMLSelectElement>('#kind').value as SectionKind;
  const { path: cwd } = getSelectedProjectCwd();
  const dest = $<HTMLSelectElement>('#ns-space').value || null;

  createSection(agent, mode, kind, cwd, dest);
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

    const logo = AGENT_LOGO[p.agent as keyof typeof AGENT_LOGO];
    const routerMeta = availableRouters.find((r) => r.id === p.agent);
    const agentDisplayName = routerMeta ? routerMeta.name : p.agent;

    if (logo) {
      const img = document.createElement('img');
      img.className = 'profile-avatar';
      img.src = logo;
      img.alt = p.agent;
      li.appendChild(img);
    } else {
      const sp = document.createElement('span');
      sp.className = 'profile-avatar profile-avatar-fallback';
      sp.textContent = agentDisplayName.slice(0, 1).toUpperCase();
      li.appendChild(sp);
    }

    const info = document.createElement('span');
    info.className = 'profile-main';
    const name = document.createElement('span');
    name.className = 'profile-name';
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'profile-meta';
    meta.textContent = `${agentDisplayName} · ${p.kind === 'pty' ? 'TUI' : 'chat'} · ${p.mode}`;
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
$('#ns-save-profile').addEventListener('click', async () => {
  const agent = $<HTMLSelectElement>('#agent').value as AgentKind;
  const mode = $<HTMLSelectElement>('#mode').value as PermMode;
  const kind = $<HTMLSelectElement>('#kind').value as SectionKind;
  const { path: cwd, project: projectObj } = getSelectedProjectCwd();
  const projLabel = projectObj ? ` (${projectObj.name})` : '';
  const routerMeta = availableRouters.find((r) => r.id === agent);
  const agentDisplayName = routerMeta ? routerMeta.name : agent;

  const defaultName = `${agentDisplayName} ${kind === 'pty' ? 'TUI' : 'Chat'}${projLabel}`;
  const name = await uiPrompt('Guardar como Perfil', defaultName, 'Nombre del perfil preconfigurado');
  if (!name || !name.trim()) return;
  profiles.push({ id: newSectionId(), name: name.trim(), agent, mode, kind, cwd });
  persistProfiles();
  renderProfiles();
});

function closeSection(sectionId: string): void {
  bridge.close(sectionId); // backend hace teardown del agente (sin huérfanos)
  forgetGitSection(sectionId); // limpia bennzen.git-repo-by-section
  gitBadges.delete(sectionId);
  const s = sections.get(sectionId);
  s?.term?.dispose();
  sections.delete(sectionId);
  saveCustomTitle(sectionId, '');
  purgeSectionData(sectionId); // Espacios (Fase 1): purga config + membresía (cierre explícito con ✕)
  const v = sectionVoices.get(sectionId);
  if (v) {
    v.tts.stop();
    sectionVoices.delete(sectionId);
  }
  clearSectionMute(sectionId);
  // Espacios (Fase 3): purga el ID de todos los buckets de orden v1.
  const orders = loadSpaceOrders();
  let touched = false;
  for (const ids of Object.values(orders)) {
    const idx = ids.indexOf(sectionId);
    if (idx !== -1) {
      ids.splice(idx, 1);
      touched = true;
    }
  }
  if (touched) saveSpaceOrders(orders);
  if (activeId === sectionId) {
    // Espacios (Fase 2): prefiere una sección visible en la vista activa.
    const visible = getVisibleSections();
    activeId = visible[0]?.sectionId ?? sections.keys().next().value ?? null;
  }
  updateMainMuteBtn();
  render();
}

// ---- Terminal (modo pty) -------------------------------------------------
const termEl = $('#term');

// Última sección pty con nudge de repintado enviado (evita resize en cada render).
let shownTermId: string | null = null;

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
  // Replay silencioso: evita inyectar respuestas del terminal al stdin.
  if (s.pendingScrollback) {
    void term.writeSilent(s.pendingScrollback);
    s.pendingScrollback = undefined;
  }
  if (s.pendingTermData) {
    void term.writeSilent(s.pendingTermData);
    s.pendingTermData = undefined;
  }
  term.focus();
}

// ---- Hablar (push-to-talk) ----------------------------------------------
let stt: SttSession | null = null;

async function startTalk(): Promise<void> {
  if (listening) return;
  if (!overlay.hidden || !newSectionOverlay.hidden || !readTextModal.hidden || git.isOpen()) return; // un modal abierto → no capturar voz
  if (!activeId) {
    await uiAlert('Crea o elige una sección primero.', 'Iniciar Conversación');
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
    await uiAlert(e instanceof Error ? e.message : String(e), 'Error de Voz', 'error');
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

type SettingsTab = 'routers' | 'projects' | 'voice';
let activeSettingsTab: SettingsTab = 'routers';

const tabBtnRouters = $<HTMLButtonElement>('#tab-btn-routers');
const tabBtnProjects = $<HTMLButtonElement>('#tab-btn-projects');
const tabBtnVoice = $<HTMLButtonElement>('#tab-btn-voice');
const tabPaneRouters = $('#tab-pane-routers');
const tabPaneProjects = $('#tab-pane-projects');
const tabPaneVoice = $('#tab-pane-voice');
const footRouters = $('#footer-routers');
const footProjects = $('#footer-projects');
const footVoice = $('#footer-voice');

function switchSettingsTab(tab: SettingsTab): void {
  activeSettingsTab = tab;
  tabBtnRouters.classList.toggle('active', tab === 'routers');
  tabBtnProjects.classList.toggle('active', tab === 'projects');
  tabBtnVoice.classList.toggle('active', tab === 'voice');
  tabPaneRouters.hidden = tab !== 'routers';
  tabPaneProjects.hidden = tab !== 'projects';
  tabPaneVoice.hidden = tab !== 'voice';
  footRouters.hidden = tab !== 'routers';
  footProjects.hidden = tab !== 'projects';
  footVoice.hidden = tab !== 'voice';

  if (tab === 'projects') {
    if (availableProjects.length > 0 && !selectedProjectId) {
      selectProject(availableProjects[0].id);
    } else if (availableProjects.length === 0) {
      selectProject(null);
    }
  }
}

tabBtnRouters.addEventListener('click', () => switchSettingsTab('routers'));
tabBtnProjects.addEventListener('click', () => switchSettingsTab('projects'));
tabBtnVoice.addEventListener('click', () => switchSettingsTab('voice'));

function openSettings(defaultTab: SettingsTab = activeSettingsTab): void {
  populateModal();
  switchSettingsTab(defaultTab);
  if (defaultTab === 'routers') {
    if (availableRouters.length > 0 && !selectedRouterId) {
      selectRouter(availableRouters[0].id);
    } else if (availableRouters.length === 0) {
      selectRouter(null);
    }
  } else if (defaultTab === 'projects') {
    if (availableProjects.length > 0 && !selectedProjectId) {
      selectProject(availableProjects[0].id);
    } else if (availableProjects.length === 0) {
      selectProject(null);
    }
  }
  overlay.hidden = false;
}
function closeSettings(): void {
  overlay.hidden = true;
}
$('#open-settings').addEventListener('click', () => openSettings());
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-cancel').addEventListener('click', closeSettings);
$('#settings-cancel-routers').addEventListener('click', closeSettings);
$('#settings-cancel-projects').addEventListener('click', closeSettings);
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeSettings(); // clic en el backdrop
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!dialogOverlay.hidden) closeUiDialog(null);
  else if (!readTextModal.hidden) closeReadModal();
  else if (git.isOpen()) git.close();
  else if (!overlay.hidden) closeSettings();
  else if (!newSectionOverlay.hidden) closeNewSection();
});

// Espacios (Fase 5): Alt+1..9 cambia de vista (Todas + espacios por orden).
// No actúa escribiendo texto (respeta Option+tecla en macOS y el terminal) ni
// con modales abiertos.
document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.key < '1' || e.key > '9') return;
  if (isTyping()) return;
  if (!dialogOverlay.hidden || !newSectionOverlay.hidden || !overlay.hidden || !readTextModal.hidden || git.isOpen()) {
    return;
  }
  const views = [ALL_VIEW, ...loadSpaces().map((s) => s.id)];
  const target = views[Number(e.key) - 1];
  if (!target) return;
  e.preventDefault();
  switchSpaceView(target);
});

// ---- Modal de lectura de texto (sin límite de caracteres) ----------------
let readingTargetSectionId: string | null = null;

async function openReadModal(): Promise<void> {
  if (!activeId) {
    await uiAlert('Crea o selecciona una sección primero.', 'Lectura de texto');
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

async function submitReadText(): Promise<void> {
  const text = readTextarea.value.trim();
  if (!text) {
    readTextarea.focus();
    return;
  }
  const targetId = readingTargetSectionId || activeId;
  if (!targetId) {
    await uiAlert('No hay una sección seleccionada.', 'Lectura de texto');
    return;
  }
  closeReadModal();
  readTextAloud(targetId, text);
}

readBtn.addEventListener('click', () => void openReadModal());
readCloseBtn.addEventListener('click', closeReadModal);
readCancelBtn.addEventListener('click', closeReadModal);
readTextModal.addEventListener('click', (e) => {
  if (e.target === readTextModal) closeReadModal();
});
readTextarea.addEventListener('input', updateReadStats);
readTextarea.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    void submitReadText();
  }
});
readSubmitBtn.addEventListener('click', () => void submitReadText());

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

$('#settings-save').addEventListener('click', async () => {
  const next = readSettingsModal();
  // Avisa si se eligió API sin config completa y sin fallback en el server.
  if (next.stt === 'api' && !apiReady(next.sttApi) && !serverVoice.stt) {
    const ok = await uiConfirm('STT por API sin endpoint/key y sin fallback en .env. ¿Guardar igual?', 'Configuración de Voz');
    if (!ok) return;
  }
  if (next.tts === 'api' && !apiReady(next.ttsApi) && !serverVoice.tts) {
    const ok = await uiConfirm('TTS por API sin endpoint/key y sin fallback en .env. ¿Guardar igual?', 'Configuración de Voz');
    if (!ok) return;
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

// ---- Restauración post-cierre (Fase 4) --------------------------------------
// Tras reiniciar el orquestador, las configs de `section-config` (que el prune
// por snapshot NO purga) permiten recrear sesiones frescas con el MISMO
// sectionId. Banner manual sobre la lista + recreación secuencial con pausa.
let restoreProgress: { done: number; total: number } | null = null;
/** IDs restaurados pendientes de confirmación (`created`/snapshot) del servidor. */
const pendingRestore = new Set<string>();
interface RestoreFailure {
  id: string;
  title: string;
  reason: string;
}
let restoreFailures: RestoreFailure[] = [];
let restoreFailTimer: ReturnType<typeof setTimeout> | null = null;

/** Pinta el banner sobre la lista: botón, nota de sesiones frescas o progreso. */
function renderRestoreBanner(): void {
  const banner = document.querySelector<HTMLElement>('#restore-banner');
  if (!banner) return;
  if (restoreProgress) {
    banner.hidden = false;
    banner.innerHTML = '';
    const prog = document.createElement('span');
    prog.className = 'restore-progress';
    const current = Math.min(restoreProgress.done + 1, restoreProgress.total);
    prog.textContent = `Restaurando ${current}/${restoreProgress.total}…`;
    banner.appendChild(prog);
    return;
  }
  const restorable = getRestorableIds(sections.keys());
  if (restorable.length === 0) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML = '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'restore-btn';
  btn.textContent =
    restorable.length === 1 ? 'Restaurar 1 sesión' : `Restaurar ${restorable.length} sesiones`;
  btn.addEventListener('click', () => void restoreSessions());
  const note = document.createElement('span');
  note.className = 'restore-note';
  note.textContent = 'Se recrean frescas, sin historial.';
  banner.append(btn, note);
}

/** Elige la sección que quedará activa tras restaurar (se restaura primero). */
function pickRestoreActive(ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  const remembered = getSpaceActive(getActiveView());
  if (remembered && ids.includes(remembered)) return remembered;
  const view = getActiveView();
  if (view === ALL_VIEW) return ids[0];
  const membership = loadSectionSpace();
  return ids.find((id) => membership[id] === view) ?? ids[0];
}

/**
 * Recrea secuencialmente las sesiones restaurables con su MISMO sectionId.
 * Reutiliza título/mute/espacio desde storage; rpc directo, pty con la
 * geometría guardada + setCapture según ttsClean. La TermView solo se monta
 * para la que quede activa (vía render()); el resto usa pendingScrollback.
 * Un fallo individual se comunica al final sin abortar el resto.
 */
async function restoreSessions(): Promise<void> {
  if (restoreProgress) return; // ya hay una restauración en curso
  const ids = getRestorableIds(sections.keys());
  if (ids.length === 0) return;
  const configs = loadSectionConfigs();
  const titles = loadCustomTitles();
  const mutedMap = loadMutedSections();
  const membership = loadSectionSpace();
  const orders = loadSpaceOrders();

  if (restoreFailTimer !== null) {
    clearTimeout(restoreFailTimer);
    restoreFailTimer = null;
  }
  restoreFailures = [];
  restoreProgress = { done: 0, total: ids.length };
  // La futura activa se elige y restaura primero: los renders intermedios
  // (snapshots del servidor por cada create) montan la TermView solo para ella.
  const targetActive = pickRestoreActive(ids);
  const ordered = targetActive ? [targetActive, ...ids.filter((id) => id !== targetActive)] : ids;
  if (targetActive && (!activeId || !sections.has(activeId))) {
    activeId = targetActive;
    setSpaceActive(getActiveView(), targetActive);
  }
  renderRestoreBanner();

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  for (const id of ordered) {
    const cfg = configs[id];
    if (!cfg) {
      restoreFailures.push({ id, title: titles[id] ?? id, reason: 'sin datos guardados' });
    } else {
      try {
        const s: UiSection = {
          sectionId: id,
          agent: cfg.agent,
          mode: cfg.mode,
          cwd: cfg.cwd,
          ready: false,
          kind: cfg.kind,
          muted: isSectionMuted(id, mutedMap),
          customTitle: titles[id] || undefined,
          entries: [],
          cols: cfg.cols,
          rows: cfg.rows,
        };
        sections.set(id, s);
        getSectionVoice(id); // materializa la voz (respeta el mute guardado)
        // La membresía y el orden ya están en storage; solo re-asegura el ID
        // en su bucket por si otra pestaña lo movió a mitad del corte.
        const destBucket = membership[id] ?? UNASSIGNED_BUCKET;
        if (!orders[destBucket]?.includes(id)) {
          orders[destBucket] = [...(orders[destBucket] ?? []), id];
        }
        if (orders[ALL_VIEW]?.length && !orders[ALL_VIEW].includes(id)) {
          orders[ALL_VIEW].push(id);
        }
        pendingRestore.add(id);
        if (cfg.kind === 'pty') {
          bridge.create(id, cfg.agent, cfg.mode, cfg.cwd, cfg.kind, cfg.cols ?? 80, cfg.rows ?? 24);
          bridge.setCapture(id, voiceCfg.ttsClean.enabled);
        } else {
          bridge.create(id, cfg.agent, cfg.mode, cfg.cwd, cfg.kind);
        }
      } catch (e) {
        sections.delete(id);
        pendingRestore.delete(id);
        restoreFailures.push({
          id,
          title: titles[id] ?? id,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    restoreProgress.done += 1;
    renderRestoreBanner();
    await sleep(150); // pausa entre spawns (evita tormentas de pty)
  }
  saveSpaceOrders(orders);
  restoreProgress = null;
  // Si nada restaurado quedó visible en la vista actual, salta a «Todas»
  // para que el usuario vea el resultado (y la activa no quede oculta).
  const nowVisible = new Set(getVisibleSections().map((s) => s.sectionId));
  if (!ordered.some((id) => nowVisible.has(id))) switchSpaceView(ALL_VIEW);
  if (!activeId || !sections.has(activeId)) {
    const visible = getVisibleSections();
    activeId = visible[0]?.sectionId ?? sections.keys().next().value ?? null;
    if (activeId) setSpaceActive(getActiveView(), activeId);
  }
  if (restoreFailures.length > 0) scheduleRestoreFailuresFlush();
  const restoredOk = ordered.length - restoreFailures.length;
  if (restoredOk > 0) {
    toast(
      restoredOk === ordered.length
        ? restoredOk === 1
          ? '1 sesión restaurada.'
          : `${restoredOk} sesiones restauradas.`
        : `${restoredOk} de ${ordered.length} sesiones restauradas.`,
    );
  }
  render();
}

/**
 * Retira una restauración rechazada por el servidor. NO purga storage (config,
 * título, mute, membresía, orden): la sección sigue restaurable y el banner
 * la vuelve a ofrecer como reintento manual.
 */
function dropRestoredZombie(sectionId: string, reason: string): void {
  pendingRestore.delete(sectionId);
  const s = sections.get(sectionId);
  s?.term?.dispose();
  sections.delete(sectionId);
  gitBadges.delete(sectionId);
  const v = sectionVoices.get(sectionId);
  if (v) {
    v.tts.stop();
    sectionVoices.delete(sectionId);
  }
  const titles = loadCustomTitles();
  restoreFailures.push({ id: sectionId, title: titles[sectionId] ?? sectionId, reason });
  if (activeId === sectionId) {
    const visible = getVisibleSections();
    activeId = visible[0]?.sectionId ?? sections.keys().next().value ?? null;
  }
  scheduleRestoreFailuresFlush();
}

/** Comunica los fallos de restauración en un único aviso agrupado. */
function scheduleRestoreFailuresFlush(): void {
  if (restoreFailTimer !== null) return; // ya hay un aviso programado
  restoreFailTimer = setTimeout(() => {
    restoreFailTimer = null;
    if (restoreFailures.length === 0) return;
    const failures = restoreFailures;
    restoreFailures = [];
    const detail = failures.map((f) => `«${f.title}»: ${f.reason}`).join(' · ');
    const head =
      failures.length === 1
        ? 'No se pudo restaurar 1 sesión'
        : `No se pudieron restaurar ${failures.length} sesiones`;
    void uiAlert(
      `${head} (${detail}). El resto sigue activo y puedes reintentarlo desde el banner.`,
      'Restauración incompleta',
      'error',
    );
  }, 900);
}

// Espacios (Fase 5): pista one-time para agrupar cuando ya hay >3 secciones
// y aún no se ha creado ningún espacio. Sin modales: un toast descartable.
const SPACES_HINT_KEY = 'bennzen.spaces-hint-dismissed';
let spacesHintShown = false;
function maybeShowSpacesHint(): void {
  if (spacesHintShown) return;
  try {
    if (localStorage.getItem(SPACES_HINT_KEY) !== null) {
      spacesHintShown = true;
      return;
    }
  } catch {
    spacesHintShown = true;
    return;
  }
  if (sections.size <= 3 || loadSpaces().length > 0) return;
  spacesHintShown = true;
  try {
    localStorage.setItem(SPACES_HINT_KEY, '1');
  } catch {
    /* storage no disponible: la pista se muestra igual, una vez por carga */
  }
  toast('¿Muchas secciones? Pulsa ＋ en el rail para agruparlas en espacios.', { duration: 9000 });
}

// ---- Render --------------------------------------------------------------
function render(): void {
  // Espacios (Fase 2): normaliza la vista y pinta el rail antes que la lista.
  ensureValidActiveView();
  renderSpacesRail();
  renderRestoreBanner(); // Espacios (Fase 4): banner sobre la lista si hay restaurables
  maybeShowSpacesHint(); // Espacios (Fase 5): pista one-time si >3 secciones

  const list = $('#sections');
  list.innerHTML = '';

  const visibleSections = getVisibleSections();

  if (visibleSections.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sections-empty';
    if (sections.size === 0) {
      empty.textContent = 'Sin secciones. Crea una con ＋.';
    } else {
      const space = loadSpaces().find((s) => s.id === getActiveView());
      empty.textContent = space
        ? `El espacio «${space.name}» está vacío — arrastra secciones aquí o crea una nueva.`
        : 'Sin secciones en esta vista.';
      // Zona de drop: soltar una card la trae a la vista activa.
      empty.addEventListener('dragover', (e) => {
        if (!draggedSectionId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        empty.classList.add('drop-over');
      });
      empty.addEventListener('dragleave', () => empty.classList.remove('drop-over'));
      empty.addEventListener('drop', (e) => {
        e.preventDefault();
        empty.classList.remove('drop-over');
        const id = draggedSectionId || e.dataTransfer?.getData('text/plain');
        if (!id) return;
        moveSectionToSpace(id, getActiveView());
      });
    }
    list.appendChild(empty);
  }

  for (const s of visibleSections) {
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
    const logo = AGENT_LOGO[s.agent as keyof typeof AGENT_LOGO];
    const routerMeta = availableRouters.find((r) => r.id === s.agent);
    const agentDisplayName = routerMeta ? routerMeta.name : s.agent;
    const displayTitle = s.customTitle || agentDisplayName;
    let avatar: HTMLElement;
    if (logo) {
      // Logo personalizado (claude, codex, opencode) siempre se mantiene
      const img = document.createElement('img');
      img.className = 'card-avatar';
      img.src = logo;
      img.alt = s.agent;
      avatar = img;
    } else {
      // Fallback: inicial del nombre (si se renombró o es router, inicial del nombre)
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
      renameBtn.innerHTML = SVG_EDIT;
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

    // Estado git + conexión: vive en el punto del botón de cerrar (sin línea
    // de rama ni punto suelto en la card).
    const gb = gitBadges.get(s.sectionId);
    if (gb) li.dataset.git = gb.dirty ? 'dirty' : 'clean';
    else delete li.dataset.git;
    li.dataset.ready = s.ready ? '1' : '0';

    // 6. Botón Mute por sección (SVG vector)
    const muteBtnCard = document.createElement('button');
    muteBtnCard.className = 'card-mute-btn';
    updateMuteButton(muteBtnCard, v.muted);
    muteBtnCard.title = v.muted ? 'Activar voz en esta sección' : 'Silenciar voz en esta sección';
    muteBtnCard.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleSectionMute(s.sectionId);
    });

    // 7. Botón cerrar: punto de estado por defecto; en hover de la card el
    // punto hace halo fuerte y se convierte en la X de cerrar.
    const x = document.createElement('button');
    x.className = 'x card-close';
    x.title = 'Cerrar sección';
    x.setAttribute('aria-label', 'Cerrar sección');
    x.innerHTML = `<span class="card-close-dot" aria-hidden="true"></span><span class="card-close-x" aria-hidden="true">${SVG_X}</span>`;
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeSection(s.sectionId);
    });

    // Activar sección al hacer clic
    li.addEventListener('click', () => {
      if (editingTitleSectionId === s.sectionId) return;
      activeId = s.sectionId;
      setSpaceActive(getActiveView(), s.sectionId); // Espacios (Fase 2): recuerda por vista
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
        // Espacios (Fase 3): el reorden persiste en el bucket del espacio
        // visible; los demás buckets no se tocan.
        const currentOrder = getVisibleSections().map((sec) => sec.sectionId);
        const fromIdx = currentOrder.indexOf(fromId);
        if (fromIdx !== -1) currentOrder.splice(fromIdx, 1);

        let toIdx = currentOrder.indexOf(toId);
        if (toIdx !== -1) {
          if (insertAfter) toIdx++;
          currentOrder.splice(toIdx, 0, fromId);
        } else {
          currentOrder.push(fromId);
        }
        saveOrderBucket(visibleOrderBucket(), currentOrder);
        render();
      }
    });

    li.addEventListener('dragend', () => {
      draggedSectionId = null;
      document.querySelectorAll('#sections .card').forEach((el) => {
        el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
      });
      document.querySelectorAll('#spaces-rail .rail-item.drag-over').forEach((el) => {
        el.classList.remove('drag-over');
      });
    });

    li.append(dragHandle, avatar, main, muteBtnCard, x);
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
    // Al cambiar de sección pty visible, SIGWINCH obliga a la TUI a repintar su alt-buffer.
    if (shownTermId !== active.sectionId) {
      shownTermId = active.sectionId;
      if (active.ready && active.cols && active.rows) bridge.termResize(active.sectionId, active.cols, active.rows);
    }
    active.term?.focus();
  } else {
    shownTermId = null;
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

  // Widget git: sigue a la sección activa (barato si no cambió).
  git.syncActiveSection();
}

render();

