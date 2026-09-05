// Módulo git de la PWA — F1: widget; F2: modal en dos columnas; F3: escrituras;
// F4: pestaña PR (ver/crear/fusionar).
//
// F1 cubre §5.1 del plan: header a grid (style.css), widget #git-info de dos
// líneas con punto de estado, selector multi-repo (D2), estados degradados
// D4/D5 y polling adaptativo (D3). F2 cubre §5.2 (lectura): lista agrupada,
// diff coloreado, pestañas Diff/Estado/PR y footer de commit. F3 cubre §5.2
// (acciones por fila) + D8: stage/unstage/discard/ignore por fila, commit
// selectivo con Nivel B (override tras uiConfirm danger), rama protegida y
// stderr real visible en el modal. F4 cubre §5.2 (pestaña PR): la pestaña solo
// se renderiza si el remoto es GitHub; con PR muestra número/título/checks/
// review/mergeable + Merge + Abrir en GitHub; sin PR muestra Crear PR con
// título/cuerpo prellenados de los commits por subir; estados no-gh (D5) y
// sin-auth. F5: ✨ vía /api/git/suggest-message con el router seleccionado,
// badges por sección, resumen por voz y Deshacer (backend F3).
import type {
  GitFileChange,
  GitPrResult,
  GitRepoRef,
  GitStatusResult,
  GitTooling,
} from '../shared/git';

export interface GitDeps {
  apiBase: string;
  getActiveSection: () => { sectionId: string; cwd: string } | undefined;
  uiConfirm: (msg: string, title?: string, danger?: boolean) => Promise<boolean>;
  uiAlert: (msg: string, title?: string, icon?: 'info' | 'error' | 'success') => Promise<void>;
  uiPrompt: (title: string, def?: string, ph?: string) => Promise<string | null>;
  onBadges: (badges: Map<string, { branch: string; dirty: boolean }>) => void;
  /** Router seleccionado en Ajustes (para ✨ suggest-message). */
  getRouterId?: () => string | null;
  /** Lee un texto con la voz de la sección activa (a demanda: no respeta mute,
   *  el clic ya es intención explícita de escuchar; no cambia el mute). */
  speakOnce?: (text: string) => void;
  /** Todas las secciones (badges por card; sin esto solo la activa). */
  getAllSections?: () => Array<{ sectionId: string; cwd: string }>;
}

export interface GitHandle {
  /** Llamar al final de render(): barato si la sección no cambió. */
  syncActiveSection(): void;
  /** Llamar desde `delta` / `term-data`: debounce 1,5 s si es la activa. */
  notifyActivity(sectionId: string): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

interface ReposResponse {
  ok: boolean;
  cwd: string;
  repos: GitRepoRef[];
}

// Anillo de carga propio (mismo trazo que los iconos SVG del modal).
const GIT_LOADING_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
  '<circle cx="12" cy="12" r="9" stroke-opacity="0.25"></circle>' +
  '<path d="M21 12a9 9 0 0 0-9-9"></path></svg>';

// Polling adaptativo (D3).
const MODAL_MS = 4000;
const ACTIVE_MS = 6000;
const IDLE_MS = 20000;
const ACTIVITY_WINDOW_MS = 30000;
const DEBOUNCE_MS = 1500;
const TOOLING_TTL_MS = 60000;

const STORE_KEY = 'bennzen.git-repo-by-section';
const GH_DOWNLOAD_FALLBACK = 'https://cli.github.com';
// Barrido de badges de las secciones no activas (F5): como mucho uno cada 15 s
// y 12 secciones por barrido; el servidor cachea repos 30 s, así que es barato.
const BADGE_SWEEP_MS = 15000;
const BADGE_SWEEP_MAX = 12;

function loadSelection(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch {
    /* json corrupto → sin selección */
  }
  return {};
}

function saveSelection(sel: Record<string, string>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sel));
  } catch {
    /* almacenamiento lleno/bloqueado: el selector sigue funcionando en memoria */
  }
}

/** Limpia la elección de repo de una sección. Llamar desde closeSection. */
export function forgetGitSection(sectionId: string): void {
  try {
    const sel = loadSelection();
    if (sel[sectionId] !== undefined) {
      delete sel[sectionId];
      saveSelection(sel);
    }
  } catch {
    /* noop */
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function reqEl(sel: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`No existe ${sel}`);
  return el;
}

function reqBtn(sel: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(sel);
  if (!el) throw new Error(`No existe ${sel}`);
  return el;
}

export function initGit(deps: GitDeps): GitHandle {
  const gitInfo = reqBtn('#git-info');
  const line1 = reqEl('#git-info-line1');
  const line2 = reqEl('#git-info-line2');
  const selector = reqEl('#git-selector');
  const modal = reqEl('#git-modal');
  const modalTitle = reqEl('#git-modal-title');
  const modalSub = reqEl('#git-modal-sub');
  const modalBody = reqEl('#git-modal-body');
  const foot = reqEl('#git-modal-foot');
  const commitMsg = document.querySelector<HTMLTextAreaElement>('#git-commit-msg');
  const commitBtn = document.querySelector<HTMLButtonElement>('#git-commit-btn');
  const commitPushBtn = document.querySelector<HTMLButtonElement>('#git-commit-push-btn');
  const commitAll = document.querySelector<HTMLInputElement>('#git-commit-all');
  const aiBtn = document.querySelector<HTMLButtonElement>('#git-ai-msg');
  const refreshBtn = reqBtn('#git-modal-refresh');
  const closeBtn = reqBtn('#git-modal-close');
  const speakBtn = reqBtn('#git-modal-speak');
  if (!deps.speakOnce) speakBtn.hidden = true;
  if (!commitMsg || !commitBtn || !commitPushBtn || !commitAll || !aiBtn) {
    throw new Error('Falta el footer del modal git (#git-modal-foot)');
  }
  // Alias no-nulos para usar dentro de callbacks (el narrowing no entra en closures).
  const msgBox: HTMLTextAreaElement = commitMsg;
  const commitAllBox: HTMLInputElement = commitAll;

  interface Snap {
    sectionId: string;
    cwd: string;
    repos: GitRepoRef[];
    root: string | null;
    status: GitStatusResult | null;
    pr: GitPrResult | null;
    netError: boolean;
  }

  let snap: Snap | null = null;
  let tooling: GitTooling | null = null;
  let toolingAt = 0;
  let modalOpen = false;
  let lastActivity = 0;
  let refreshing = false;
  let pendingRefresh = false;
  let timer: number | null = null;
  let debounce: number | null = null;
  const badges = new Map<string, { branch: string; dirty: boolean }>();

  // Estado de vista del modal F2 (persiste entre repintados del polling).
  type GitTab = 'diff' | 'estado' | 'pr';
  let tab: GitTab = 'diff';
  let selPath: string | null = null;
  let selStaged = false;
  let diffKey: string | null = null;
  let diffPatch: string | null = null;
  let diffTruncated = false;
  let diffError: string | null = null;
  let diffLoading = false;
  let viewRoot: string | null = null;

  // Estado del formulario PR F4 (persiste entre repintados del polling para
  // no pisar lo que el usuario está escribiendo; ver syncPrFormFromDom).
  let prTitle = '';
  let prBody = '';
  let prBase = '';
  let prDraft = false;
  let prMergeMethod = 'squash';
  let prDeleteBranch = false;
  // Clave del último prellenado (root+rama+ahead+último commit): solo se
  // rellena de nuevo cuando cambia, nunca sobre lo ya escrito.
  let prPrefillKey: string | null = null;

  interface DiffResponse {
    ok: boolean;
    patch?: string;
    truncated?: boolean;
    message?: string;
  }

  async function jget<T>(path: string): Promise<T | null> {
    try {
      const r = await fetch(deps.apiBase + path);
      if (!r.ok && r.status !== 403) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  }

  function currentRoot(sectionId: string, repos: GitRepoRef[]): string | null {
    const saved = loadSelection()[sectionId];
    if (saved && repos.some((r) => r.root === saved)) return saved;
    return repos.find((r) => r.primary)?.root ?? repos[0]?.root ?? null;
  }

  function setRoot(sectionId: string, root: string): void {
    const sel = loadSelection();
    sel[sectionId] = root;
    saveSelection(sel);
    if (snap && snap.sectionId === sectionId) snap.root = root;
  }

  function schedule(): void {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (document.hidden) return; // pausado; visibilitychange reanuda
    const delay = modalOpen
      ? MODAL_MS
      : Date.now() - lastActivity < ACTIVITY_WINDOW_MS
        ? ACTIVE_MS
        : IDLE_MS;
    timer = window.setTimeout(() => {
      timer = null;
      void refreshNow('poll');
    }, delay);
  }

  async function refreshNow(_reason: string): Promise<void> {
    const cur = deps.getActiveSection();
    if (!cur) {
      snap = null;
      paintNoSection();
      schedule();
      return;
    }
    if (refreshing) {
      pendingRefresh = true;
      return;
    }
    refreshing = true;
    try {
      if (!tooling || Date.now() - toolingAt > TOOLING_TTL_MS) {
        const t = await jget<GitTooling>('/api/git/tooling');
        if (t) {
          tooling = t;
          toolingAt = Date.now();
        }
      }
      const reposRes = await jget<ReposResponse>(
        `/api/git/repos?sectionId=${encodeURIComponent(cur.sectionId)}`,
      );
      // La sección pudo cambiar mientras esperábamos.
      if (deps.getActiveSection()?.sectionId !== cur.sectionId) return;
      const repos = reposRes?.ok ? (reposRes.repos ?? []) : [];
      const cwd = reposRes?.cwd ?? cur.cwd;
      const root = currentRoot(cur.sectionId, repos);
      let status: GitStatusResult | null = null;
      let pr: GitPrResult | null = null;
      if (root) {
        const [st, p] = await Promise.all([
          jget<GitStatusResult>(`/api/git/status?root=${encodeURIComponent(root)}`),
          jget<GitPrResult>(`/api/git/pr?root=${encodeURIComponent(root)}`),
        ]);
        if (deps.getActiveSection()?.sectionId !== cur.sectionId) return;
        status = st;
        pr = p;
      } else {
        status = { ok: false, reason: 'not-a-repo', cwd, candidates: repos };
      }
      snap = {
        sectionId: cur.sectionId,
        cwd,
        repos,
        root,
        status,
        pr,
        netError: !reposRes && !tooling,
      };
      paint();
    } finally {
      refreshing = false;
      if (pendingRefresh) {
        pendingRefresh = false;
        void refreshNow('coalesced');
      } else {
        schedule();
      }
    }
  }

  // ---- Badges del sidebar F5 (§5.3: línea ⎇ rama + punto sucia por card,
  // vía onBadges; se apaga en secciones sin repo; lo alimenta syncActiveSection
  // a través del polling + este barrido de las no activas).
  function pushBadges(): void {
    if (!snap) return;
    if (snap.status && snap.status.ok) {
      const st = snap.status;
      badges.set(snap.sectionId, {
        branch: st.branch ?? st.head,
        dirty: st.files.length > 0,
      });
    } else {
      badges.delete(snap.sectionId);
    }
    deps.onBadges(new Map(badges));
  }

  let badgeSweepAt = 0;

  /** Refresca los badges de las secciones NO activas (round-robin acotado). */
  async function sweepBadges(): Promise<void> {
    const all = deps.getAllSections?.();
    if (!all || all.length < 2 || document.hidden) return;
    if (Date.now() - badgeSweepAt < BADGE_SWEEP_MS) return;
    badgeSweepAt = Date.now();
    const activeId = snap?.sectionId;
    const rest = all.filter((s) => s.sectionId !== activeId).slice(0, BADGE_SWEEP_MAX);
    await Promise.all(rest.map(async (s) => {
      try {
        const reposRes = await jget<ReposResponse>(
          `/api/git/repos?sectionId=${encodeURIComponent(s.sectionId)}`,
        );
        const repos = reposRes?.ok ? (reposRes.repos ?? []) : [];
        const root = currentRoot(s.sectionId, repos);
        if (!root) {
          if (badges.delete(s.sectionId)) deps.onBadges(new Map(badges));
          return;
        }
        const st = await jget<GitStatusResult>(`/api/git/status?root=${encodeURIComponent(root)}`);
        if (st && st.ok) {
          badges.set(s.sectionId, { branch: st.branch ?? st.head, dirty: st.files.length > 0 });
        } else {
          badges.delete(s.sectionId);
        }
      } catch {
        badges.delete(s.sectionId);
      }
    }));
    deps.onBadges(new Map(badges));
  }

  // ---- Widget ----
  type DotKind = 'clean' | 'dirty' | 'conflict' | 'operation' | 'missing';

  function dotHtml(kind: DotKind): string {
    return `<span class="git-dot ${kind}">●</span>`;
  }

  function paintNoSection(): void {
    gitInfo.hidden = true;
    selector.hidden = true;
    if (modalOpen) {
      modalTitle.textContent = 'Git';
      modalBody.innerHTML = '<p class="git-modal-empty">Sin sección activa.</p>';
    }
  }

  function statusDot(): DotKind {
    const st = snap?.status;
    if (!st || !st.ok) return 'missing';
    if (st.operation !== 'none') return 'operation';
    if (st.conflicts > 0) return 'conflict';
    return st.files.length > 0 ? 'dirty' : 'clean';
  }

  function totalsText(): string {
    const st = snap?.status;
    if (!st || !st.ok) return '';
    const added = st.staged.added + st.unstaged.added;
    const deleted = st.staged.deleted + st.unstaged.deleted;
    const files = st.staged.files + st.unstaged.files + st.untracked;
    return files > 0 ? `+${added} −${deleted} · ${files} arch` : 'sin cambios';
  }

  function prSuffix(): string {
    const p = snap?.pr;
    if (!p) return '';
    if (p.ok && p.pr) return ` · PR #${p.pr.number}`;
    if (!p.ok && p.reason === 'gh-unauthenticated') return ' · gh sin autenticar';
    return '';
  }

  function paintWidget(): void {
    const s = snap;
    if (!s) {
      gitInfo.hidden = true;
      return;
    }
    gitInfo.hidden = false;
    const gitMissing = tooling && !tooling.git.ok;
    if (s.netError && !s.status) {
      line1.innerHTML = `${dotHtml('missing')}<span>sin conexión</span>`;
      line2.textContent = 'reintentar';
      gitInfo.title = 'Sin conexión con el orquestador — clic para reintentar';
      return;
    }
    if (gitMissing) {
      line1.innerHTML = `${dotHtml('missing')}<span>git no instalado ↗</span>`;
      line2.textContent = 'clic para descargar git';
      gitInfo.title = 'git no instalado — clic para abrir la descarga oficial';
      return;
    }
    const st = s.status;
    if (!st) {
      line1.innerHTML = `${dotHtml('missing')}<span>cargando…</span>`;
      line2.textContent = '';
      return;
    }
    if (!st.ok) {
      if (st.reason === 'not-a-repo') {
        const n = st.candidates.length;
        if (n === 0) {
          line1.innerHTML = `${dotHtml('missing')}<span>sin repositorio git</span>`;
          line2.textContent = 'clic para ver opciones';
          gitInfo.title = 'Esta sección no está en un repositorio git';
        } else {
          line1.innerHTML =
            `${dotHtml('missing')}<span>${n} repo${n === 1 ? '' : 's'} ` +
            `<span class="git-caret">▾</span></span>`;
          line2.textContent = 'elegir repositorio';
          gitInfo.title = 'Elegir repositorio de la sección';
        }
      } else if (st.reason === 'no-git') {
        line1.innerHTML = `${dotHtml('missing')}<span>git no instalado ↗</span>`;
        line2.textContent = 'clic para descargar git';
        gitInfo.title = 'git no instalado — clic para abrir la descarga oficial';
      } else {
        line1.innerHTML = `${dotHtml('missing')}<span>git no disponible</span>`;
        line2.textContent = st.reason === 'not-allowed' ? 'ruta no permitida' : 'error';
        gitInfo.title = 'No se pudo leer el estado git';
      }
      return;
    }
    // Estado ok.
    const branch = st.detached ? st.head : (st.branch ?? st.head);
    const caret = s.repos.length > 1 ? ' <span class="git-caret">▾</span>' : '';
    const ab = [
      st.upstream && st.ahead > 0 ? `↑${st.ahead}` : '',
      st.upstream && st.behind > 0 ? `↓${st.behind}` : '',
    ].filter(Boolean).join(' ');
    line1.innerHTML =
      `${dotHtml(statusDot())}<span>${esc(st.name)}${caret} · ⎇ ${esc(branch)}` +
      (ab ? ` ${esc(ab)}` : '') + '</span>';
    const author = st.user.name || st.lastCommit?.author || st.remoteHost || '—';
    line2.textContent = `${author} · ${totalsText()}${prSuffix()}`;
    gitInfo.title = `Git · ${s.root ?? ''} — clic para abrir el panel`;
  }

  function paintSelector(): void {
    const s = snap;
    if (!s || s.repos.length < 2) {
      selector.hidden = true;
      selector.innerHTML = '';
      return;
    }
    selector.innerHTML = s.repos.map((r) =>
      `<button class="git-selector-item" data-root="${esc(r.root)}">` +
      `<span class="git-selector-name">${esc(r.name)}${r.primary ? ' (activo)' : ''}</span>` +
      `<span class="git-selector-kind">${esc(r.kind)}</span></button>`,
    ).join('');
    for (const btn of selector.querySelectorAll<HTMLButtonElement>('.git-selector-item')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const root = btn.dataset.root;
        if (!root || !snap) return;
        setRoot(snap.sectionId, root);
        selector.hidden = true;
        void refreshNow('select');
      });
    }
  }

  // ---- Modal (F2: dos columnas de lectura) ----
  function statusLetter(f: GitFileChange): string {
    if (f.untracked) return '?';
    if (f.conflicted) return '!';
    return (f.index + f.worktree).trim() || '·';
  }

  function fileBadges(f: GitFileChange): string {
    let h = `<span class="router-tag-badge">${esc(statusLetter(f))}</span>`;
    if (f.binary) {
      h += ' <span class="router-tag-badge">bin</span>';
    } else {
      if (f.added > 0) h += ` <span class="router-tag-badge st-add">+${f.added}</span>`;
      if (f.deleted > 0) h += ` <span class="router-tag-badge st-del">−${f.deleted}</span>`;
    }
    if (f.sensitive === 'blocked') {
      h += ` <span class="router-tag-badge st-lock" title="Sensible (Nivel A): ${esc(f.sensitiveReason ?? 'excluido')}">🔒</span>`;
    } else if (f.sensitive === 'warn') {
      h += ` <span class="router-tag-badge st-warn" title="Aviso (Nivel C): ${esc(f.sensitiveReason ?? 'revisar')}">⚠</span>`;
    }
    return `<span class="git-badges">${h}</span>`;
  }

  // Acciones por fila F3 (§5.2, visibles al hover, patrón .router-item-del):
  // ▸ preparar · ↩ quitar · ⌫ descartar · 🚫 ignorar (solo Nivel A).
  function fileRow(f: GitFileChange, stagedView: boolean): string {
    const active = selPath === f.path && selStaged === stagedView ? ' active' : '';
    const sub = f.origPath ? `← ${esc(f.origPath)}` : `${esc(f.index)}${esc(f.worktree)}`;
    const locked = f.sensitive === 'blocked';
    const acts: string[] = [];
    if (stagedView) {
      acts.push('<button class="git-act" data-op="unstage" title="Quitar del commit">↩</button>');
    } else if (!locked) {
      acts.push('<button class="git-act" data-op="stage" title="Preparar para el commit">▸</button>');
    }
    acts.push('<button class="git-act danger" data-op="discard" ' +
      'title="Descartar cambios (stash bennzen/discard-* recuperable; con Alt: modo duro, no recuperable)">⌫</button>');
    if (locked) {
      acts.push('<button class="git-act" data-op="ignore" title="Añadir a .gitignore">🚫</button>');
    }
    return `<li class="router-item git-file${active}" data-path="${esc(f.path)}" ` +
      `data-staged="${stagedView ? '1' : '0'}" role="button" tabindex="0">` +
      `<span class="router-item-info"><span class="git-file-path">${esc(f.path)}${fileBadges(f)}</span>` +
      `<span class="git-file-sub">${sub}</span></span>` +
      `<span class="git-row-actions">${acts.join('')}</span></li>`;
  }

  function fileGroup(title: string, files: GitFileChange[], stagedView: boolean): string {
    const rows = files.length > 0
      ? files.map((f) => fileRow(f, stagedView)).join('')
      : '<li class="git-empty-group">—</li>';
    return `<section><h3 class="git-group-head">${esc(title)} · ${files.length}</h3>` +
      `<ul class="git-list">${rows}</ul></section>`;
  }

  function colorDiff(patch: string): string {
    return patch.split('\n').map((line) => {
      const e = esc(line);
      if (line.startsWith('@@') || line.startsWith('diff --git')) return `<span class="hunk">${e}</span>`;
      if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="add">${e}</span>`;
      if (line.startsWith('-') && !line.startsWith('---')) return `<span class="del">${e}</span>`;
      return e;
    }).join('\n');
  }

  function diffHtml(): string {
    if (diffLoading) return esc('Cargando diff…');
    if (diffError) return esc(diffError);
    if (diffPatch === null) return esc('Selecciona un archivo para ver su diff.');
    if (diffPatch === '') {
      return esc('Sin diff disponible (archivo sin seguimiento o sin cambios en esta vista).');
    }
    return colorDiff(diffPatch) + (diffTruncated ? '\n<span class="hunk">…(truncado)</span>' : '');
  }

  function paintDiffPane(): void {
    const pre = modalBody.querySelector('#git-diff-pre');
    if (pre) pre.innerHTML = diffHtml();
  }

  async function loadDiff(root: string, rel: string, staged: boolean): Promise<void> {
    const key = `${root}${staged ? '\n#1\n' : '\n#0\n'}${rel}`;
    if (key === diffKey || diffLoading) return;
    diffLoading = true;
    diffError = null;
    paintDiffPane();
    const data = await jget<DiffResponse>(
      `/api/git/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent(rel)}` +
      `&staged=${staged ? '1' : '0'}`,
    );
    diffLoading = false;
    if (!snap?.root || snap.root !== root) return; // la selección ya cambió
    if (!data) {
      diffError = 'No se pudo cargar el diff (sin conexión).';
    } else if (!data.ok) {
      diffError = data.message ?? 'No se pudo cargar el diff.';
    } else {
      diffKey = key;
      diffPatch = data.patch ?? '';
      diffTruncated = !!data.truncated;
    }
    paintDiffPane();
  }

  interface GitWriteResult {
    ok: boolean;
    message?: string;
    detail?: string;
    blocked?: {
      files: string[];
      findings: Array<{ path: string; line: number; rule: string; excerpt: string }>;
    };
  }

  /**
   * POST de escritura F3. Muestra el stderr real en el modal (tal cual lo
   * devuelve git) y refresca de inmediato; el llamador gestiona `blocked`.
   */
  async function postGit(pathname: string, body: Record<string, unknown>): Promise<GitWriteResult> {
    if (!snap?.root) return { ok: false, message: 'Sin repositorio seleccionado.' };
    try {
      const r = await fetch(`${deps.apiBase}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: snap.root, ...body }),
      });
      const data = (await r.json()) as GitWriteResult;
      if (data.ok) {
        diffKey = null;
      } else if (data.blocked && data.blocked.findings.length > 0) {
        // Nivel B: el llamador (commit) pinta el listado path:line.
      } else if (data.blocked) {
        showModalError(`${data.message ?? 'Acción bloqueada.'} (${data.blocked.files.join(', ')})`);
      } else {
        showModalError(data.message ?? 'La acción no se completó.');
      }
      return data;
    } catch {
      showModalError('Sin conexión con el orquestador.');
      return { ok: false, message: 'Sin conexión con el orquestador.' };
    } finally {
      void refreshNow('action');
    }
  }

  /** Rama protegida (main|master|develop|production): exige confirmación. */
  async function confirmProtected(): Promise<boolean> {
    const st = snap?.status;
    if (st && st.ok && st.protectedBranch) {
      return deps.uiConfirm(
        `Estás en la rama protegida «${st.branch ?? st.head}». ¿Subir igualmente?`,
        'Rama protegida',
        true,
      );
    }
    return true;
  }

  function showBlockedFindings(
    msg: string,
    findings: NonNullable<GitWriteResult['blocked']>['findings'],
  ): void {
    const el = modalBody.querySelector<HTMLElement>('[data-role="error"]');
    if (!el) return;
    el.hidden = false;
    const items = findings.slice(0, 20).map((f) =>
      `<li><strong>${esc(f.path)}:${f.line}</strong> [${esc(f.rule)}] ` +
      `<code>${esc(f.excerpt)}</code></li>`,
    ).join('');
    const more = findings.length > 20 ? `<span>…y ${findings.length - 20} más</span>` : '';
    el.innerHTML = `${esc(msg)}<ul class="git-blocked">${items}</ul>${more}`;
  }

  /** Descartar D6: stash recuperable por defecto; Alt+clic = modo duro. */
  async function doDiscard(rel: string, hard: boolean): Promise<void> {
    if (hard) {
      const ok = await deps.uiConfirm(
        `Eliminar DEFINITIVAMENTE los cambios en ${rel}? No habrá stash recuperable.`,
        'Descartar (modo duro)',
        true,
      );
      if (!ok) return;
      await postGit('/api/git/discard', { paths: [rel], mode: 'hard' });
      return;
    }
    const ok = await deps.uiConfirm(
      `Descartar cambios en ${rel}? Se guardará un stash bennzen/discard-* recuperable.`,
      'Descartar',
      true,
    );
    if (!ok) return;
    await postGit('/api/git/discard', { paths: [rel], mode: 'stash' });
  }

  // ---- Pestaña PR F4 (§5.2) ----
  // Solo se renderiza si el remoto es GitHub (el llamador oculta la pestaña
  // en caso contrario). Con PR: número/título/checks/review/mergeable + Merge
  // + Abrir en GitHub. Sin PR: Crear PR con título/cuerpo prellenados de los
  // commits por subir. Estados no-gh (D5) y sin-auth.

  /** Guarda en el estado lo que el usuario haya escrito antes de repintar. */
  function syncPrFormFromDom(): void {
    const t = modalBody.querySelector<HTMLInputElement>('#git-pr-title');
    if (t) prTitle = t.value;
    const b = modalBody.querySelector<HTMLTextAreaElement>('#git-pr-body');
    if (b) prBody = b.value;
    const base = modalBody.querySelector<HTMLInputElement>('#git-pr-base');
    if (base) prBase = base.value;
    const d = modalBody.querySelector<HTMLInputElement>('#git-pr-draft');
    if (d) prDraft = d.checked;
    const m = modalBody.querySelector<HTMLSelectElement>('#git-pr-method');
    if (m) prMergeMethod = m.value;
    const del = modalBody.querySelector<HTMLInputElement>('#git-pr-delbranch');
    if (del) prDeleteBranch = del.checked;
  }

  /** Prefill de Crear PR desde los commits por subir (solo al cambiar). */
  function ensurePrPrefill(): void {
    const s = snap;
    const st = s?.status;
    if (!s?.root || !st || !st.ok) return;
    if (s.pr && s.pr.ok && s.pr.pr) return; // con PR no hay formulario
    const branch = st.detached ? st.head : (st.branch ?? st.head);
    const key = `${s.root}\n${branch}\n${st.ahead}\n${st.lastCommit?.hash ?? ''}`;
    if (key === prPrefillKey) return;
    prPrefillKey = key;
    prTitle = st.lastCommit?.subject ?? branch;
    prBody = st.ahead > 0
      ? `${st.ahead} commit(s) por subir desde ${branch}` +
        (st.lastCommit ? ` (último: ${st.lastCommit.hash} “${st.lastCommit.subject}”).` : '.')
      : `Cambios de ${branch}` +
        (st.lastCommit ? ` (último: ${st.lastCommit.hash} “${st.lastCommit.subject}”).` : '.');
  }

  function prBlock(): string {
    const p = snap?.pr;
    if (!p) return '<p class="git-pr-line">Cargando PR…</p>';
    if (!p.ok) {
      if (p.reason === 'no-gh') {
        return '<p class="git-pr-line">gh no instalado: necesario para los pull requests.</p>' +
          '<div class="git-modal-actions">' +
          '<button class="ghost" data-act="gh-download">Descargar gh</button></div>';
      }
      if (p.reason === 'gh-unauthenticated') {
        return `<p class="git-pr-line">${esc(p.hint)}</p>` +
          '<div class="git-modal-actions">' +
          '<button class="ghost" data-act="gh-copy">Copiar: gh auth login</button></div>';
      }
      if (p.reason === 'not-github') {
        return '<p class="git-pr-line">El remoto no es GitHub.</p>';
      }
      return `<p class="git-pr-line">${esc(p.message)}</p>`;
    }
    if (p.pr) {
      const pr = p.pr;
      const c = pr.checks;
      const checks = c.total > 0
        ? `${c.passed} ✓ · ${c.failed} ✗ · ${c.pending} … (de ${c.total})`
        : 'sin checks';
      const review = pr.reviewDecision === 'APPROVED'
        ? 'aprobado'
        : pr.reviewDecision === 'CHANGES_REQUESTED'
          ? 'cambios pedidos'
          : pr.reviewDecision === 'REVIEW_REQUIRED'
            ? 'revisión pendiente'
            : 'sin revisión';
      const mergeable = pr.mergeable === 'MERGEABLE'
        ? 'fusionable'
        : pr.mergeable === 'CONFLICTING'
          ? 'con conflictos'
          : 'estado desconocido';
      const methodOpts = (['squash', 'merge', 'rebase'] as const).map((m) =>
        `<option value="${m}"${prMergeMethod === m ? ' selected' : ''}>${m}</option>`,
      ).join('');
      return `<div class="git-pr-head"><strong>PR #${pr.number}</strong> · ${esc(pr.title)}` +
        (pr.isDraft ? ' <span class="router-tag-badge">draft</span>' : '') + '</div>' +
        '<div class="git-kv">' +
        `<div><strong>Estado:</strong> ${esc(pr.state)} · ${esc(pr.baseRefName)} ← ${esc(pr.headRefName)}</div>` +
        `<div><strong>Checks:</strong> ${esc(checks)}</div>` +
        `<div><strong>Revisión:</strong> ${esc(review)}</div>` +
        `<div><strong>Merge:</strong> ${esc(mergeable)}</div>` +
        `<div><strong>Autor:</strong> ${esc(pr.author || '—')}</div>` +
        '</div>' +
        '<div class="git-pr-merge">' +
        `<label class="git-check">método <select id="git-pr-method">${methodOpts}</select></label>` +
        `<label class="git-check"><input id="git-pr-delbranch" type="checkbox"${prDeleteBranch ? ' checked' : ''} /> borrar rama</label>` +
        '<button class="primary-btn" data-act="pr-merge" type="button">Merge</button>' +
        '<button class="ghost" data-act="pr-open" type="button">Abrir en GitHub</button>' +
        '</div>';
    }
    return '<div class="git-pr-head"><strong>Sin pull request</strong> para esta rama.</div>' +
      `<label class="git-pr-label">Título<input id="git-pr-title" value="${esc(prTitle)}" placeholder="Título del PR" /></label>` +
      `<label class="git-pr-label">Cuerpo<textarea id="git-pr-body" rows="3" placeholder="Descripción del PR…">${esc(prBody)}</textarea></label>` +
      '<div class="git-pr-merge">' +
      `<label class="git-check">base <input id="git-pr-base" value="${esc(prBase)}" placeholder="por defecto" /></label>` +
      `<label class="git-check"><input id="git-pr-draft" type="checkbox"${prDraft ? ' checked' : ''} /> draft</label>` +
      '<button class="primary-btn" data-act="pr-create" type="button">Crear PR</button>' +
      '</div>';
  }

  /** POST /api/git/pr — crea el PR con lo que el usuario haya escrito. */
  async function doPrCreate(): Promise<void> {
    syncPrFormFromDom();
    if (!snap?.root) return;
    if (prTitle.trim() === '') {
      showModalError('Escribe un título para el PR primero.');
      return;
    }
    try {
      const r = await fetch(`${deps.apiBase}/api/git/pr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          root: snap.root,
          title: prTitle.trim(),
          body: prBody,
          ...(prBase.trim() !== '' ? { base: prBase.trim() } : {}),
          ...(prDraft ? { draft: true } : {}),
        }),
      });
      const data = (await r.json()) as GitPrResult;
      if (data.ok && data.pr) {
        prTitle = '';
        prBody = '';
        prBase = '';
        prDraft = false;
        prPrefillKey = null; // el siguiente repintado ya muestra el PR
      } else if (!data.ok && (data.reason === 'no-gh' || data.reason === 'gh-unauthenticated' || data.reason === 'not-github')) {
        // Los estados degradados ya se pintan en el panel al refrescar.
      } else if (!data.ok) {
        showModalError(data.reason === 'error' ? data.message : 'No se pudo crear el PR.');
      }
    } catch {
      showModalError('Sin conexión con el orquestador.');
    } finally {
      void refreshNow('pr-create');
    }
  }

  /** POST /api/git/pr/merge — fusiona el PR visible con el método elegido. */
  async function doPrMerge(): Promise<void> {
    syncPrFormFromDom();
    const p = snap?.pr;
    if (!snap?.root || !p || !p.ok || !p.pr) return;
    const ok = await deps.uiConfirm(
      `Fusionar el PR #${p.pr.number} con método ${prMergeMethod}?`,
      'Merge PR',
      true,
    );
    if (!ok) return;
    try {
      const r = await fetch(`${deps.apiBase}/api/git/pr/merge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          root: snap.root,
          number: p.pr.number,
          method: prMergeMethod,
          deleteBranch: prDeleteBranch,
        }),
      });
      const data = (await r.json()) as GitWriteResult;
      if (!data.ok) showModalError(data.message ?? 'No se pudo fusionar el PR.');
    } catch {
      showModalError('Sin conexión con el orquestador.');
    } finally {
      void refreshNow('pr-merge');
    }
  }

  function wirePrPane(): void {
    modalBody.querySelector('[data-act="pr-create"]')?.addEventListener('click', () => {
      void doPrCreate();
    });
    modalBody.querySelector('[data-act="pr-merge"]')?.addEventListener('click', () => {
      void doPrMerge();
    });
  }

  /** Estado vacío/degradado: título neutro, sin sub ni footer (D4). */
  function paintModalEmpty(title: string, bodyHtml: string): void {
    modalTitle.textContent = title;
    modalSub.hidden = true;
    modalSub.textContent = '';
    foot.hidden = true;
    modalBody.innerHTML = bodyHtml;
  }

  function paintModal(): void {
    if (!modalOpen) return;
    const s = snap;
    if (!s) {
      paintModalEmpty('Git', '<p class="git-modal-empty">Sin sección activa.</p>');
      return;
    }
    const gitMissing = tooling && !tooling.git.ok;
    if (gitMissing || (s.status && !s.status.ok && s.status.reason === 'no-git')) {
      const url = tooling && !tooling.git.ok
        ? tooling.git.downloadUrl
        : (s.status && !s.status.ok && s.status.reason === 'no-git' ? s.status.downloadUrl : '');
      paintModalEmpty('Git',
        '<p class="git-modal-empty">git no está instalado en el servidor.</p>' +
        `<div class="git-modal-actions"><button class="git-modal-link" data-act="git-download">` +
        `Abrir ${esc(url || 'https://git-scm.com/downloads')}</button></div>`);
      wireModalLinks(url || 'https://git-scm.com/downloads');
      return;
    }
    const st = s.status;
    if (!st) {
      paintModalEmpty('Git', '<p class="git-modal-empty">Cargando…</p>');
      return;
    }
    if (!st.ok) {
      if (st.reason === 'not-a-repo') {
        const list = st.candidates.length > 0
          ? '<div class="git-modal-actions">' + st.candidates.map((r) =>
            `<button class="ghost" data-root="${esc(r.root)}">${esc(r.name)} · ${esc(r.kind)}</button>`,
          ).join('') + '</div>'
          : `<div class="git-modal-actions"><button class="ghost" data-act="init">git init aquí</button></div>`;
        paintModalEmpty('Git',
          '<p class="git-modal-empty">Sin repositorio git en esta sección.</p>' + list +
          '<p class="git-modal-error git-modal-empty" data-role="error" hidden></p>');
        for (const btn of modalBody.querySelectorAll<HTMLButtonElement>('[data-root]')) {
          btn.addEventListener('click', () => {
            const root = btn.dataset.root;
            if (!root || !snap) return;
            setRoot(snap.sectionId, root);
            void refreshNow('select');
          });
        }
        modalBody.querySelector('[data-act="init"]')?.addEventListener('click', () => {
          void doInit();
        });
      } else {
        const msg = st.reason === 'not-allowed'
          ? 'Ruta no permitida por el servidor.'
          : esc(st.message);
        paintModalEmpty('Git', `<p class="git-modal-empty">${msg}</p>`);
      }
      return;
    }
    // Estado ok → dos columnas (§5.2).
    if (s.root !== viewRoot) {
      viewRoot = s.root;
      selPath = null;
      diffKey = null;
      diffPatch = null;
      diffTruncated = false;
      diffError = null;
      prPrefillKey = null;
    }
    // El repintado del polling no debe pisar el formulario PR: se guarda lo
    // escrito y solo se prefill al cambiar de root/rama/commits por subir.
    syncPrFormFromDom();
    ensurePrPrefill();
    // La pestaña PR solo se renderiza si el remoto es GitHub (§5.2).
    const showPr = st.remoteHost === 'github';
    if (!showPr && tab === 'pr') tab = 'diff';
    const branch = st.detached ? `${st.head} (detached)` : (st.branch ?? st.head);
    const ab = [
      st.upstream && st.ahead > 0 ? `↑${st.ahead}` : '',
      st.upstream && st.behind > 0 ? `↓${st.behind}` : '',
    ].filter(Boolean).join(' ');
    modalTitle.textContent = `Git · ${st.name}`;
    modalSub.hidden = false;
    modalSub.textContent =
      `⎇ ${branch}${st.upstream ? ` → ${st.upstream}` : ''}${ab ? ` ${ab}` : ''}` +
      ` · ${st.user.name || st.lastCommit?.author || '—'}`;
    foot.hidden = false;
    const unstaged = st.files.filter((f) => f.unstaged || f.untracked);
    const staged = st.files.filter((f) => f.staged);
    let sel = selPath ? (st.files.find((f) => f.path === selPath) ?? null) : null;
    if (!sel) {
      sel = unstaged[0] ?? staged[0] ?? null;
      selPath = sel?.path ?? null;
      selStaged = sel ? (!sel.unstaged && !sel.untracked && sel.staged) : false;
    }
    const prLabel = s.pr && s.pr.ok && s.pr.pr ? `PR #${s.pr.pr.number}` : 'PR';
    // Pestaña Estado: detalle de lectura del status.
    const estadoHtml =
      `<div class="git-kv">` +
      `<div><strong>Rama:</strong> ${esc(branch)}` +
      (st.upstream ? ` → ${esc(st.upstream)}${ab ? ` (${esc(ab)})` : ''}` : ' (sin upstream)') + '</div>' +
      `<div><strong>Autor:</strong> ${esc(st.user.name || '—')}` +
      (st.user.email ? ` &lt;${esc(st.user.email)}&gt;` : '') + '</div>' +
      `<div><strong>Remoto:</strong> ${st.remoteUrl ? esc(st.remoteUrl) : 'sin remoto'}</div>` +
      `<div><strong>Sin preparar:</strong> ${st.unstaged.files} fich · +${st.unstaged.added} −${st.unstaged.deleted}</div>` +
      `<div><strong>Preparado:</strong> ${st.staged.files} fich · +${st.staged.added} −${st.staged.deleted}</div>` +
      `<div><strong>Sin seguimiento:</strong> ${st.untracked}</div>` +
      (st.operation !== 'none' ? `<div><strong>Operación:</strong> ${esc(st.operation)} en curso</div>` : '') +
      (st.protectedBranch ? '<div><strong>Rama protegida</strong> (confirmar antes de subir)</div>' : '') +
      '</div>';
    modalBody.innerHTML =
      '<div class="git-body"><div class="git-left">' +
      fileGroup('Sin preparar', unstaged, false) +
      fileGroup('Preparado', staged, true) +
      '</div><div class="git-right">' +
      `<div class="git-tabs" role="tablist">` +
      `<button class="git-tab-btn${tab === 'diff' ? ' active' : ''}" data-tab="diff">Diff</button>` +
      `<button class="git-tab-btn${tab === 'estado' ? ' active' : ''}" data-tab="estado">Estado</button>` +
      (showPr
        ? `<button class="git-tab-btn${tab === 'pr' ? ' active' : ''}" data-tab="pr">${esc(prLabel)}</button>`
        : '') +
      '</div>' +
      `<div class="git-pane" data-pane="diff"${tab === 'diff' ? '' : ' hidden'}>` +
      `<pre id="git-diff-pre" class="git-diff">${diffHtml()}</pre></div>` +
      `<div class="git-pane" data-pane="estado"${tab === 'estado' ? '' : ' hidden'}>${estadoHtml}</div>` +
      (showPr
        ? `<div class="git-pane" data-pane="pr"${tab === 'pr' ? '' : ' hidden'}>${prBlock()}</div>`
        : '') +
      `<p class="git-meta">` +
      (st.lastCommit
        ? `último: <strong>${esc(st.lastCommit.hash)}</strong> “${esc(st.lastCommit.subject)}” · ` +
          `${esc(st.lastCommit.author)} · ${esc(st.lastCommit.relDate)}<br />`
        : '') +
      `stashes: <strong>${st.stashes}</strong> · ` +
      (st.conflicts > 0 ? `⚠ <strong>${st.conflicts} conflicto(s)</strong>` : 'sin conflictos') +
      '</p>' +
      '<div class="git-actions">' +
      '<button class="ghost" data-act="fetch">Fetch</button>' +
      `<button class="ghost" data-act="pull">Pull${st.behind > 0 ? ` ↓${st.behind}` : ''}</button>` +
      `<button class="ghost" data-act="push">Push${st.ahead > 0 ? ` ↑${st.ahead}` : ''}</button>` +
      '<button class="ghost" data-act="undo" ' +
      'title="Deshacer el último commit local (mantiene los cambios)">Deshacer</button>' +
      '</div>' +
      '<p class="git-modal-error git-modal-empty" data-role="error" hidden></p>' +
      '</div></div>';
    wireModalLinks(null);
    wireTwoColumns();
    if (showPr) wirePrPane();
    if (sel && s.root) {
      const key = `${s.root}${selStaged ? '\n#1\n' : '\n#0\n'}${sel.path}`;
      if (key !== diffKey && !diffLoading) void loadDiff(s.root, sel.path, selStaged);
    }
  }

  function wireTwoColumns(): void {
    for (const btn of modalBody.querySelectorAll<HTMLButtonElement>('.git-tab-btn')) {
      btn.addEventListener('click', () => {
        const t = btn.dataset.tab;
        if (t === 'diff' || t === 'estado' || t === 'pr') {
          tab = t;
          paintModal();
        }
      });
    }
    const pick = (li: HTMLElement): void => {
      const p = li.dataset.path;
      if (!p) return;
      selPath = p;
      selStaged = li.dataset.staged === '1';
      tab = 'diff';
      paintModal();
    };
    for (const li of modalBody.querySelectorAll<HTMLElement>('.git-file')) {
      li.addEventListener('click', () => pick(li));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick(li);
        }
      });
    }
    for (const btn of modalBody.querySelectorAll<HTMLButtonElement>('.git-row-actions [data-op]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const li = btn.closest('.git-file');
        const rel = li?.getAttribute('data-path');
        if (!rel) return;
        const op = btn.dataset.op;
        if (op === 'stage') void postGit('/api/git/stage', { paths: [rel] });
        else if (op === 'unstage') void postGit('/api/git/unstage', { paths: [rel] });
        else if (op === 'ignore') void postGit('/api/git/ignore', { paths: [rel] });
        else if (op === 'discard') void doDiscard(rel, (e as MouseEvent).altKey === true);
      });
    }
    for (const btn of modalBody.querySelectorAll<HTMLButtonElement>('.git-actions [data-act]')) {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'fetch') void postGit('/api/git/fetch', {});
        else if (act === 'pull') void postGit('/api/git/pull', {});
        else if (act === 'push') {
          void (async () => {
            if (await confirmProtected()) await postGit('/api/git/push', {});
          })();
        } else if (act === 'undo') void postGit('/api/git/undo-commit', {});
      });
    }
  }

  function wireModalLinks(gitUrl: string | null): void {
    if (gitUrl) {
      modalBody.querySelector('[data-act="git-download"]')?.addEventListener('click', () => {
        window.open(gitUrl, '_blank', 'noopener');
      });
    }
    modalBody.querySelector('[data-act="gh-download"]')?.addEventListener('click', () => {
      const url = (snap?.pr && !snap.pr.ok && snap.pr.reason === 'no-gh')
        ? snap.pr.downloadUrl
        : GH_DOWNLOAD_FALLBACK;
      window.open(url, '_blank', 'noopener');
    });
    const copyBtn = modalBody.querySelector<HTMLButtonElement>('[data-act="gh-copy"]');
    copyBtn?.addEventListener('click', () => {
      void copyText('gh auth login').then((ok) => {
        copyBtn.textContent = ok ? '¡Copiado!' : 'gh auth login';
      });
    });
    const pr = snap?.pr;
    if (pr && pr.ok && pr.pr) {
      modalBody.querySelector('[data-act="pr-open"]')?.addEventListener('click', () => {
        if (pr.pr) window.open(pr.pr.url, '_blank', 'noopener');
      });
    }
  }

  async function copyText(t: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch {
      /* fallback */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function showModalError(msg: string): void {
    const el = modalBody.querySelector<HTMLElement>('[data-role="error"]');
    if (el) {
      el.hidden = false;
      el.textContent = msg;
    }
  }

  async function doInit(): Promise<void> {
    if (!snap) return;
    try {
      const r = await fetch(`${deps.apiBase}/api/git/init`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: snap.cwd }),
      });
      const data = (await r.json()) as { ok: boolean; message?: string };
      if (data.ok) {
        void refreshNow('init');
      } else {
        showModalError(data.message ?? 'No se pudo inicializar el repositorio.');
      }
    } catch {
      showModalError('Sin conexión con el orquestador.');
    }
  }

  function paint(): void {
    paintWidget();
    paintSelector();
    paintModal();
    pushBadges();
    void sweepBadges();
  }

  // ---- Interacción ----
  gitInfo.addEventListener('click', (e) => {
    const s = snap;
    if (!s) return;
    if ((e.target as HTMLElement).closest('.git-caret')) {
      if (s.repos.length > 1) selector.hidden = !selector.hidden;
      return;
    }
    const gitMissing = tooling && !tooling.git.ok;
    const noGitStatus = s.status && !s.status.ok && s.status.reason === 'no-git';
    if (gitMissing || noGitStatus) {
      let url = 'https://git-scm.com/downloads';
      if (tooling && !tooling.git.ok && tooling.git.downloadUrl) url = tooling.git.downloadUrl;
      else if (s.status && !s.status.ok && s.status.reason === 'no-git') url = s.status.downloadUrl;
      window.open(url, '_blank', 'noopener');
      return;
    }
    if (s.netError && !s.status) {
      void refreshNow('retry');
      return;
    }
    if (s.status && !s.status.ok && s.status.reason === 'not-a-repo' && s.status.candidates.length > 0) {
      selector.hidden = !selector.hidden;
      return;
    }
    open();
  });

  gitInfo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('#git-center')) selector.hidden = true;
  });

  refreshBtn.addEventListener('click', () => {
    diffKey = null; // fuerza recarga del diff visible
    void refreshNow('manual');
  });
  // Resumen de estado por voz: el backend lo redacta con el router de
  // Ajustes → Routers (fallback a frase local) y se lee con la voz de la
  // sección (config de voz de bennzen). Spinner propio, sin iconos default.
  const speakIdleIcon = speakBtn.innerHTML;
  speakBtn.addEventListener('click', () => {
    void (async () => {
      if (!snap?.root || speakBtn.disabled) return;
      speakBtn.disabled = true;
      speakBtn.classList.add('loading');
      speakBtn.innerHTML = GIT_LOADING_ICON;
      try {
        const routerId = deps.getRouterId?.() ?? null;
        const r = await fetch(`${deps.apiBase}/api/git/speak-summary`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root: snap.root, ...(routerId ? { routerId } : {}) }),
        });
        const data = (await r.json()) as { ok: boolean; message?: string };
        if (!data.ok || !data.message) {
          showModalError(data.message ?? 'No se pudo generar el resumen de voz.');
          return;
        }
        deps.speakOnce?.(data.message);
      } catch {
        showModalError('Sin conexión con el orquestador.');
      } finally {
        speakBtn.disabled = false;
        speakBtn.classList.remove('loading');
        speakBtn.innerHTML = speakIdleIcon;
      }
    })();
  });
  closeBtn.addEventListener('click', () => {
    close();
  });
  // Footer de commit F3: selectivo (staged | todo), Nivel B con override tras
  // uiConfirm danger, Nivel A sin override, rama protegida con confirmación.
  async function doCommit(push: boolean): Promise<void> {
    const msg = msgBox.value.trim();
    if (!msg) {
      showModalError('Escribe un mensaje de commit primero.');
      msgBox.focus();
      return;
    }
    if (push && !(await confirmProtected())) return;
    const payload: Record<string, unknown> = {
      message: msg,
      scope: commitAllBox.checked ? 'all' : 'staged',
      push,
    };
    const res = await postGit('/api/git/commit', payload);
    if (!res.ok && res.blocked && res.blocked.findings.length > 0) {
      showBlockedFindings(
        res.message ?? 'Posibles secretos detectados en el contenido.',
        res.blocked.findings,
      );
      const force = await deps.uiConfirm(
        `Se detectaron ${res.blocked.findings.length} posible(s) secreto(s) en el patch ` +
        '(ver listado). ¿Forzar el commit igualmente?',
        'Secretos detectados',
        true,
      );
      if (!force) return;
      const retry = await postGit('/api/git/commit', { ...payload, overrideSecrets: true });
      if (retry.ok) {
        if (modalOpen) msgBox.value = '';
      } else if (retry.blocked && retry.blocked.findings.length > 0) {
        showBlockedFindings(retry.message ?? 'Posibles secretos detectados.', retry.blocked.findings);
      }
      return;
    }
    if (res.ok && modalOpen) msgBox.value = '';
  }
  commitBtn.addEventListener('click', () => {
    void doCommit(false);
  });
  commitPushBtn.addEventListener('click', () => {
    void doCommit(true);
  });
  // F5 (D7): ✨ genera un Conventional Commit vía POST /api/git/suggest-message
  // con el router seleccionado en Ajustes. Scope según «todo»: preparado o
  // todos los cambios (lo mismo que va a commitear). Spinner propio.
  const aiIdleIcon = aiBtn.innerHTML;
  aiBtn.addEventListener('click', () => {
    void (async () => {
      if (!snap?.root || aiBtn.disabled) return;
      aiBtn.disabled = true;
      aiBtn.classList.add('loading');
      aiBtn.innerHTML = GIT_LOADING_ICON;
      try {
        const routerId = deps.getRouterId?.() ?? null;
        const r = await fetch(`${deps.apiBase}/api/git/suggest-message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            root: snap.root,
            scope: commitAllBox.checked ? 'all' : 'staged',
            ...(routerId ? { routerId } : {}),
          }),
        });
        const data = (await r.json()) as { ok: boolean; message?: string };
        if (data.ok && data.message) {
          msgBox.value = data.message;
          msgBox.focus();
        } else showModalError(data.message ?? 'No se pudo sugerir un mensaje.');
      } catch {
        showModalError('Sin conexión con el orquestador.');
      } finally {
        aiBtn.disabled = false;
        aiBtn.classList.remove('loading');
        aiBtn.innerHTML = aiIdleIcon;
      }
    })();
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshNow('visible');
    else schedule();
  });

  function syncActiveSection(): void {
    const cur = deps.getActiveSection();
    if (!cur) {
      if (snap !== null) {
        snap = null;
        paintNoSection();
      }
      schedule();
      return;
    }
    if (!snap || snap.sectionId !== cur.sectionId) {
      snap = null;
      paintNoSection();
      void refreshNow('section');
      return;
    }
    schedule(); // misma sección: solo garantiza el temporizador
  }

  function notifyActivity(sectionId: string): void {
    const cur = deps.getActiveSection();
    if (!cur || cur.sectionId !== sectionId) return;
    lastActivity = Date.now();
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = null;
      void refreshNow('activity');
    }, DEBOUNCE_MS);
    schedule();
  }

  function open(): void {
    modalOpen = true;
    selector.hidden = true;
    modal.hidden = false;
    void refreshNow('open');
  }

  function close(): void {
    modalOpen = false;
    modal.hidden = true;
    selector.hidden = true;
    schedule();
  }

  schedule();

  return {
    syncActiveSection,
    notifyActivity,
    open,
    close,
    isOpen: () => modalOpen,
  };
}
