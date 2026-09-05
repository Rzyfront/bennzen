// Backend git de bennzen — F0: contrato + núcleo de lectura; F3: escrituras + D8;
// F4: pull requests con `gh` (GET/POST /api/git/pr, POST /api/git/pr/merge);
// F5: sugerencia de mensaje (POST /api/git/suggest-message) vía routers.
// Runner seguro (execFile, sin shell), allowlist exacta, mutex de escritura,
// cachés con TTL, descubrimiento multi-repo y GET /api/git/tooling|repos|status|diff.
// F3 añade POST /api/git/stage|unstage|discard|commit|push|pull|fetch|undo-commit|ignore|init,
// la guardia de secretos D8 (A/B/C) y el reintento único ante index.lock.
// Nunca `git push --force` ni `git reset --hard`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type {
  GitActionResult,
  GitFileChange,
  GitPr,
  GitPrResult,
  GitRepoRef,
  GitStatus,
  GitStatusResult,
  GitTooling,
} from '../shared/git';
import type { RouterConfig } from '../shared/protocol';
import { getRouter, loadRouters } from './routers';

const execFileAsync = promisify(execFile);

export const BASE_ENV: Record<string, string | undefined> = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0', // jamás bloquear pidiendo credenciales
  GIT_OPTIONAL_LOCKS: '0', // lecturas sin tocar el index.lock del agente
  LC_ALL: 'C',
};

// git siempre con: ['-c', 'core.quotepath=false', ...args]
const QUOTEPATH_ARGS = ['-c', 'core.quotepath=false'] as const;

// Timeouts: lectura 5 s, escritura local 20 s, red 60 s.
export const READ_TIMEOUT_MS = 5_000;
export const WRITE_TIMEOUT_MS = 20_000;
export const NET_TIMEOUT_MS = 60_000;

const MAX_BUFFER = 16 * 1024 * 1024; // 16 MB

// Diffs truncados a 200 KB con marca.
export const DIFF_MAX_BYTES = 200 * 1024;
export const DIFF_TRUNCATED_MARK = '…(truncado)';

export const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';
export const GH_DOWNLOAD_URL = 'https://cli.github.com';

// ---- Inyección sectionId → cwd (mismo patrón que PtyHooks, pty.ts) ---------
// server.ts la conecta a registry + ptyRegistry tras crearlos.
export interface GitHooks {
  resolveCwd: (sectionId?: string, cwd?: string) => string | undefined;
  listLiveCwds: () => string[];
}

let hooks: GitHooks | undefined;
export function setGitHooks(h: GitHooks): void {
  hooks = h;
}

// ---- Mutex por root: solo las escrituras lo toman; las lecturas, no. --------
const writeMutex = new Map<string, Promise<void>>();

export function withGitWriteLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeMutex.get(root) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeMutex.set(root, prev.then(() => slot));
  return prev.then(fn).finally(() => {
    release();
    if (writeMutex.get(root) === slot) writeMutex.delete(root);
  });
}

// ---- Cachés ----------------------------------------------------------------
const TOOLING_TTL_MS = 5 * 60 * 1000; // 5 min
const REPOS_TTL_MS = 30_000; // 30 s
const STATUS_TTL_MS = 800; // 800 ms
const PR_TTL_MS = 60_000; // 60 s

let toolingCache: { at: number; value: GitTooling } | null = null;
const reposCache = new Map<string, { at: number; value: GitRepoRef[] }>();
const statusCache = new Map<string, { at: number; value: GitStatusResult }>();
const prCache = new Map<string, { at: number; value: GitPrResult }>();

function cacheFresh(at: number, ttl: number): boolean {
  return Date.now() - at < ttl;
}

/** Cualquier escritura sobre ese root invalida su status y su PR. */
export function invalidateGitRoot(root: string): void {
  const key = cacheKey(root);
  statusCache.delete(key);
  prCache.delete(key);
}

function cacheKey(root: string): string {
  return safeReal(root) ?? path.resolve(root);
}

// ---- Runner ----------------------------------------------------------------
interface RunOk {
  stdout: string;
  stderr: string;
}

async function runGit(root: string, args: string[], timeout: number): Promise<RunOk> {
  const { stdout, stderr } = await execFileAsync('git', [...QUOTEPATH_ARGS, ...args], {
    cwd: root,
    env: BASE_ENV,
    timeout,
    maxBuffer: MAX_BUFFER,
  });
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
}

async function runGh(args: string[], timeout: number, cwd: string): Promise<RunOk> {
  const { stdout, stderr } = await execFileAsync('gh', args, {
    cwd,
    env: BASE_ENV,
    timeout,
    maxBuffer: MAX_BUFFER,
  });
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
}

/** Ejecuta git y devuelve stdout recortado, o null si falla. Solo lectura. */
async function tryGit(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await runGit(root, args, READ_TIMEOUT_MS);
    return stdout.trim();
  } catch {
    return null;
  }
}

// ---- Allowlist de rutas (obligatorio) --------------------------------------
const PROJECTS_FILE = path.resolve(process.cwd(), '.projects.json');

function safeReal(p: string): string | null {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return null;
  }
}

/** Directorios base: (a) los `path` de .projects.json + (b) cwd de sesiones vivas. */
function discoverBaseDirs(): string[] {
  const bases: string[] = [];
  const add = (p: string | undefined | null): void => {
    if (!p) return;
    const r = safeReal(p);
    if (r && !bases.includes(r)) bases.push(r);
  };
  try {
    const raw = fs.readFileSync(PROJECTS_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const p of parsed) {
        if (typeof p === 'object' && p !== null && 'path' in p) {
          const v = (p as { path: unknown }).path;
          if (typeof v === 'string') add(v);
        }
      }
    }
  } catch {
    // .projects.json ausente o corrupto → solo sesiones vivas.
  }
  try {
    for (const cwd of hooks?.listLiveCwds() ?? []) add(cwd);
  } catch {
    // resolver aún no inyectado → solo proyectos.
  }
  return bases;
}

/** Hijos con repo hasta profundidad 2. Tope de 50 candidatos. */
function scanChildRepos(bases: string[]): string[] {
  const found: string[] = [];
  const skipped = (name: string): boolean => {
    if (name === 'node_modules' || name === '.git') return true;
    if (name.charAt(0) === '.') return true;
    if (name === 'dist' || name.slice(0, 5) === 'dist-') return true;
    return false;
  };
  const consider = (dir: string): void => {
    if (found.length >= 50) return;
    let gitEntry: string | null = null;
    try {
      const st = fs.statSync(path.join(dir, '.git'), { throwIfNoEntry: false });
      if (st) gitEntry = path.join(dir, '.git');
    } catch {
      return;
    }
    if (!gitEntry) return;
    const r = safeReal(dir);
    if (r && !found.includes(r)) found.push(r);
  };
  const children = (dir: string): string[] => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || skipped(e.name)) continue;
      out.push(path.join(dir, e.name));
    }
    return out;
  };
  for (const base of bases) {
    if (found.length >= 50) break;
    for (const l1 of children(base)) {
      if (found.length >= 50) break;
      consider(l1);
      for (const l2 of children(l1)) {
        if (found.length >= 50) break;
        consider(l2);
      }
    }
  }
  return found;
}

/**
 * Conjunto de roots aceptados. Comparación por igualdad exacta de string
 * resuelto (realpath); un root manipulado con ../ jamás coincide.
 */
async function buildAllowlist(): Promise<Set<string>> {
  const allowed = new Set<string>();
  const bases = discoverBaseDirs();
  for (const b of bases) allowed.add(b);
  for (const child of scanChildRepos(bases)) allowed.add(child);
  // El toplevel que contiene a cada base también es un root válido.
  for (const b of bases) {
    const top = await tryGit(b, ['rev-parse', '--show-toplevel']);
    if (top) {
      const r = safeReal(top);
      if (r) allowed.add(r);
    }
  }
  return allowed;
}

/** null = aceptado; GitStatusResult not-allowed = rechazado (HTTP 403). */
async function checkAllowed(root: string): Promise<{ real: string } | { denied: true }> {
  const real = safeReal(root);
  if (!real) return { denied: true };
  const allowed = await buildAllowlist();
  if (!allowed.has(real)) return { denied: true };
  return { real };
}

// ---- Descubrimiento multi-repo ----------------------------------------------
async function discoverRepos(cwd: string): Promise<{ cwd: string; repos: GitRepoRef[] }> {
  const abs = path.resolve(cwd);
  const repos: GitRepoRef[] = [];
  const seen = new Set<string>();

  // 1. rev-parse en el cwd → repo primary (kind 'cwd').
  let primary: string | null = null;
  try {
    const { stdout } = await runGit(abs, ['rev-parse', '--show-toplevel'], READ_TIMEOUT_MS);
    const top = stdout.trim();
    if (top) {
      const r = safeReal(top) ?? path.resolve(top);
      primary = r;
      repos.push({ root: r, name: path.basename(r), kind: 'cwd', primary: true });
      seen.add(r);
    }
  } catch {
    primary = null;
  }

  // 2. Escaneo de hijos hasta profundidad 2 (tope 50).
  for (const child of scanChildRepos([abs])) {
    if (seen.has(child)) continue;
    seen.add(child);
    repos.push({ root: child, name: path.basename(child), kind: 'child', primary: false });
  }

  // 3. Submódulos del primary (recursivo).
  if (primary) {
    const out = await tryGit(primary, ['submodule', 'status', '--recursive']);
    if (out) {
      for (const line of out.split('\n')) {
        const m = line.match(/^[ +U-][0-9a-f]{40} (\S+)/);
        if (!m) continue;
        const subAbs = path.join(primary, m[1]);
        const r = safeReal(subAbs);
        if (!r || seen.has(r)) continue;
        seen.add(r);
        repos.push({ root: r, name: path.basename(r), kind: 'submodule', primary: false });
      }
    }
  }

  return { cwd: abs, repos };
}

// ---- Tooling -----------------------------------------------------------------
async function computeTooling(cwd: string): Promise<GitTooling> {
  let git: GitTooling['git'] = { ok: false, downloadUrl: GIT_DOWNLOAD_URL };
  try {
    // git --version
    const { stdout } = await execFileAsync('git', ['--version'], {
      cwd,
      env: BASE_ENV,
      timeout: READ_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    const m = String(stdout ?? '').match(/git version (\S+)/);
    git = { ok: true, version: m?.[1], downloadUrl: GIT_DOWNLOAD_URL };
  } catch {
    git = { ok: false, downloadUrl: GIT_DOWNLOAD_URL };
  }

  let gh: GitTooling['gh'] = { ok: false, downloadUrl: GH_DOWNLOAD_URL, authenticated: false };
  try {
    const { stdout } = await execFileAsync('gh', ['--version'], {
      cwd,
      env: BASE_ENV,
      timeout: READ_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    const m = String(stdout ?? '').match(/gh version (\S+)/);
    let authenticated = false;
    let user: string | undefined;
    try {
      // gh auth status
      const st = await runGh(['auth', 'status'], NET_TIMEOUT_MS, cwd);
      const combined = `${st.stdout}\n${st.stderr}`;
      authenticated = /Logged in to/i.test(combined);
      const um = combined.match(/Logged in to \S+ account (\S+)/i);
      if (um) user = um[1];
    } catch {
      authenticated = false;
    }
    gh = { ok: true, version: m?.[1], downloadUrl: GH_DOWNLOAD_URL, authenticated, user };
  } catch {
    gh = { ok: false, downloadUrl: GH_DOWNLOAD_URL, authenticated: false };
  }
  return { git, gh };
}

async function getTooling(cwd: string): Promise<GitTooling> {
  if (toolingCache && cacheFresh(toolingCache.at, TOOLING_TTL_MS)) return toolingCache.value;
  const value = await computeTooling(cwd);
  toolingCache = { at: Date.now(), value };
  return value;
}

// ---- Status -------------------------------------------------------------------
function emptyTotals(): { files: number; added: number; deleted: number } {
  return { files: 0, added: 0, deleted: 0 };
}

type NumStat = { added: number; deleted: number; binary: boolean };

/** git diff --numstat -z (y --cached): mapa ruta → stats; ambas caras del rename. */
function parseNumstatZ(stdout: string): Map<string, NumStat> {
  const map = new Map<string, NumStat>();
  const chunks = stdout.split('\0');
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const m = c.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    const stat: NumStat = {
      added: m[1] === '-' ? 0 : Number(m[1]),
      deleted: m[2] === '-' ? 0 : Number(m[2]),
      binary,
    };
    const names = [m[3]];
    // Rename con -z: el segundo nombre llega en el chunk siguiente sin tabs.
    if (i + 1 < chunks.length && chunks[i + 1] !== '' && !chunks[i + 1].includes('\t')) {
      names.push(chunks[i + 1]);
      i++;
    }
    for (const n of names) if (n !== '') map.set(n, stat);
  }
  return map;
}

async function detectOperation(root: string): Promise<GitStatus['operation']> {
  let gitDir = await tryGit(root, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) {
    const rel = await tryGit(root, ['rev-parse', '--git-dir']);
    if (!rel) return 'none';
    gitDir = path.resolve(root, rel);
  }
  const exists = (n: string): boolean => {
    try {
      return fs.existsSync(path.join(gitDir as string, n));
    } catch {
      return false;
    }
  };
  if (exists('MERGE_HEAD')) return 'merge';
  if (exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (exists('REVERT_HEAD')) return 'revert';
  if (exists('BISECT_LOG')) return 'bisect';
  if (exists('rebase-merge') || exists('rebase-apply')) return 'rebase';
  return 'none';
}

const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'production']);

async function computeStatus(root: string): Promise<GitStatusResult> {
  // git no disponible → no-git (D5).
  if (!(await getTooling(root)).git.ok) {
    return { ok: false, reason: 'no-git', downloadUrl: GIT_DOWNLOAD_URL };
  }

  let statusOut: string;
  try {
    // git status --porcelain=v2 --branch --untracked-files=all -z
    const r = await runGit(
      root,
      ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'],
      READ_TIMEOUT_MS,
    );
    statusOut = r.stdout;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not a git repository/i.test(msg)) {
      const { repos } = await discoverRepos(root);
      return { ok: false, reason: 'not-a-repo', cwd: path.resolve(root), candidates: repos };
    }
    return { ok: false, reason: 'error', message: msg };
  }

  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let oid = '';

  const files: GitFileChange[] = [];
  let untracked = 0;

  for (const rec of statusOut.split('\0')) {
    if (rec === '') continue;
    if (rec.charAt(0) === '#') {
      let m = rec.match(/^# branch\.head (.+)$/);
      if (m) {
        if (m[1] === '(detached)') {
          detached = true;
          branch = null;
        } else {
          branch = m[1];
        }
        continue;
      }
      m = rec.match(/^# branch\.oid (.+)$/);
      if (m) {
        oid = m[1];
        continue;
      }
      m = rec.match(/^# branch\.upstream (.+)$/);
      if (m) {
        upstream = m[1];
        continue;
      }
      m = rec.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
      continue;
    }
    const tag = rec.charAt(0);
    if (tag === '?') {
      const p = rec.slice(2);
      files.push({
        path: p,
        index: '?',
        worktree: '?',
        staged: false,
        unstaged: false,
        untracked: true,
        conflicted: false,
        added: 0,
        deleted: 0,
        binary: false,
        sensitive: 'none',
      });
      untracked++;
      continue;
    }
    if (tag === '1' || tag === '2' || tag === 'u') {
      const parts = rec.split(' ');
      // 1: [1, XY, subm, mH, mI, mW, hH, hI, path...]
      // 2: [2, XY, subm, mH, mI, mW, hH, hI, score, path...]
      // u: [u, XY, subm, m1, m2, m3, mW, h1, h2, h3, path...]
      const xy = parts[1] ?? '..';
      const idx = tag === '1' || tag === '2' ? 8 : 10;
      const pathPart = parts.slice(tag === '2' ? 9 : idx).join(' ');
      const tabAt = pathPart.indexOf('\t');
      const rel = tabAt >= 0 ? pathPart.slice(0, tabAt) : pathPart;
      const orig = tabAt >= 0 ? pathPart.slice(tabAt + 1) : undefined;
      const x = xy.charAt(0);
      const y = xy.charAt(1);
      const conflicted = tag === 'u';
      files.push({
        path: rel,
        ...(orig ? { origPath: orig } : {}),
        index: x,
        worktree: y,
        staged: !conflicted && x !== '.' && x !== '?' && x !== '!',
        unstaged: !conflicted && y !== '.' && y !== '?' && y !== '!',
        untracked: false,
        conflicted,
        added: 0,
        deleted: 0,
        binary: false,
        sensitive: 'none',
      });
      continue;
    }
  }

  // git diff --numstat -z / git diff --cached --numstat -z
  const [unstagedNs, stagedNs] = await Promise.all([
    tryGit(root, ['diff', '--numstat', '-z']).then((o) => (o === null ? null : parseNumstatZ(o))),
    tryGit(root, ['diff', '--cached', '--numstat', '-z']).then((o) =>
      o === null ? null : parseNumstatZ(o),
    ),
  ]);
  const staged = emptyTotals();
  const unstagedT = emptyTotals();
  let conflicts = 0;
  for (const f of files) {
    if (f.conflicted) {
      conflicts++;
      continue;
    }
    if (f.untracked) {
      try {
        f.sizeBytes = fs.statSync(path.join(root, f.path)).size;
      } catch {
        // ruta ilegible → sin tamaño.
      }
      continue;
    }
    const sStat = stagedNs?.get(f.path) ?? (f.origPath ? stagedNs?.get(f.origPath) : undefined);
    if (sStat && f.staged) {
      f.added += sStat.added;
      f.deleted += sStat.deleted;
      if (sStat.binary) f.binary = true;
      staged.files++;
      staged.added += sStat.added;
      staged.deleted += sStat.deleted;
    }
    const uStat =
      unstagedNs?.get(f.path) ?? (f.origPath ? unstagedNs?.get(f.origPath) : undefined);
    if (uStat && f.unstaged) {
      // Si también está staged, el numstat unstaged ya es incremental sobre el index.
      f.added += f.staged ? 0 : uStat.added;
      f.deleted += f.staged ? 0 : uStat.deleted;
      if (!f.staged) {
        f.added = uStat.added;
        f.deleted = uStat.deleted;
      }
      if (uStat.binary) f.binary = true;
      unstagedT.files++;
      unstagedT.added += uStat.added;
      unstagedT.deleted += uStat.deleted;
    }
  }

  // Guardia D8: Nivel A (ruta) y Nivel C (tamaño/extensión) por archivo.
  classifySensitive(root, files);

  // git config user.name / user.email
  const [userName, userEmail] = await Promise.all([
    tryGit(root, ['config', 'user.name']),
    tryGit(root, ['config', 'user.email']),
  ]);

  // git remote get-url origin
  const remoteOut = await tryGit(root, ['remote', 'get-url', 'origin']);
  const remoteUrl = remoteOut && remoteOut !== '' ? remoteOut.split('\n')[0] : null;
  const remoteHost = remoteUrl === null ? null : /github\.com/i.test(remoteUrl) ? 'github' : 'other';

  // git stash list
  const stashOut = await tryGit(root, ['stash', 'list']);
  const stashes = stashOut === null || stashOut === '' ? 0 : stashOut.split('\n').length;

  // git log -1 --format=%h%x00%s%x00%an%x00%ar
  let lastCommit: GitStatus['lastCommit'] = null;
  const logOut = await tryGit(root, ['log', '-1', '--format=%h%x00%s%x00%an%x00%ar']);
  if (logOut) {
    const parts = logOut.split('\0');
    if (parts.length >= 4) {
      lastCommit = { hash: parts[0], subject: parts[1], author: parts[2], relDate: parts[3] };
    }
  }

  // git rev-list --left-right --count HEAD...@{upstream}
  if (upstream) {
    const rl = await tryGit(root, ['rev-list', '--left-right', '--count', `HEAD...@{upstream}`]);
    if (rl) {
      const m = rl.match(/^(\d+)\s+(\d+)$/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    }
  } else {
    ahead = 0;
    behind = 0;
  }

  const operation = await detectOperation(root);
  const head = lastCommit?.hash ?? (oid !== '' && oid !== '(initial)' ? oid.slice(0, 7) : '');

  return {
    ok: true,
    root: safeReal(root) ?? path.resolve(root),
    name: path.basename(safeReal(root) ?? path.resolve(root)),
    branch,
    detached,
    head,
    upstream,
    ahead,
    behind,
    user: { name: userName ?? '', email: userEmail ?? '' },
    remoteUrl,
    remoteHost,
    files,
    staged,
    unstaged: unstagedT,
    untracked,
    stashes,
    conflicts,
    lastCommit,
    operation,
    protectedBranch: branch !== null && PROTECTED_BRANCHES.has(branch),
  };
}

async function getStatus(root: string): Promise<GitStatusResult> {
  const key = cacheKey(root);
  const hit = statusCache.get(key);
  if (hit && cacheFresh(hit.at, STATUS_TTL_MS)) return hit.value;
  const value = await computeStatus(root);
  statusCache.set(key, { at: Date.now(), value });
  return value;
}

// ---- Diff ---------------------------------------------------------------------
export interface GitDiffResultOk {
  ok: true;
  patch: string;
  truncated: boolean;
}
export type GitDiffResult =
  | GitDiffResultOk
  | { ok: false; reason: 'not-allowed' }
  | { ok: false; reason: 'no-git'; downloadUrl: string }
  | { ok: false; reason: 'error'; message: string };

function truncatePatch(patch: string): { patch: string; truncated: boolean } {
  const bytes = Buffer.byteLength(patch, 'utf8');
  if (bytes <= DIFF_MAX_BYTES) return { patch, truncated: false };
  // Corta por líneas para no partir un carácter multibyte.
  let acc = 0;
  const lines = patch.split('\n');
  const kept: string[] = [];
  for (const ln of lines) {
    const lb = Buffer.byteLength(ln + '\n', 'utf8');
    if (acc + lb > DIFF_MAX_BYTES) break;
    kept.push(ln);
    acc += lb;
  }
  return { patch: `${kept.join('\n')}\n${DIFF_TRUNCATED_MARK}`, truncated: true };
}

async function computeDiff(root: string, rel: string, staged: boolean): Promise<GitDiffResult> {
  if (!(await getTooling(root)).git.ok) {
    return { ok: false, reason: 'no-git', downloadUrl: GIT_DOWNLOAD_URL };
  }
  // La ruta viaja tras `--`; además se rechaza el escape del repo.
  const norm = path.normalize(rel);
  const segs = norm.split(path.sep);
  if (path.isAbsolute(rel) || norm === '..' || segs[0] === '..') {
    return { ok: false, reason: 'error', message: `Ruta fuera del repo: ${rel}` };
  }
  try {
    // git diff -- <path> / git diff --cached -- <path>
    const args = staged
      ? ['diff', '--cached', '--', rel]
      : ['diff', '--', rel];
    const { stdout } = await runGit(root, args, READ_TIMEOUT_MS);
    const { patch, truncated } = truncatePatch(stdout);
    return { ok: true, patch, truncated };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

// ---- Guardia de secretos D8 ------------------------------------------------------

// Nivel A — por ruta (basename). Sin override desde la UI: la fila lleva badge
// 🔒, no es seleccionable para stage/commit y ofrece «añadir a .gitignore».
function levelAReason(rel: string): string | null {
  const base = path.basename(rel);
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) {
    return 'archivo .env';
  }
  if (base === '.routers.json' || base === '.projects.json') return 'config sensible del proyecto';
  if (/\.(pem|key|p12|pfx|keystore)$/i.test(base)) return 'clave o certificado';
  if (base.startsWith('id_rsa')) return 'clave SSH';
  if (/credentials.*\.json$/i.test(base)) return 'credenciales';
  return null;
}

// Nivel C — aviso blando, no bloquea: > 5 MB o documento fuera de assets.
const DOC_EXT_RE = /\.(pdf|docx|xlsx|pptx)$/i;
const BIG_FILE_BYTES = 5 * 1024 * 1024;

function levelCWarn(rel: string, sizeBytes?: number): string | null {
  if (sizeBytes !== undefined && sizeBytes > BIG_FILE_BYTES) return 'supera 5 MB';
  if (DOC_EXT_RE.test(rel)) {
    const inAssets = rel.split('/').some((s) => s.toLowerCase() === 'assets');
    if (!inAssets) return 'documento fuera de assets';
  }
  return null;
}

/** Clasifica files in-place (Nivel A → blocked, Nivel C → warn). */
function classifySensitive(root: string, files: GitFileChange[]): void {
  for (const f of files) {
    const a = levelAReason(f.path) ?? (f.origPath ? levelAReason(f.origPath) : null);
    if (a) {
      f.sensitive = 'blocked';
      f.sensitiveReason = a;
      continue;
    }
    if (f.sizeBytes === undefined && !f.conflicted) {
      try {
        f.sizeBytes = fs.statSync(path.join(root, f.path)).size;
      } catch {
        // Ruta ilegible o borrada → sin tamaño; igual se evalúa la extensión.
      }
    }
    const c = levelCWarn(f.path, f.sizeBytes);
    if (c) {
      f.sensitive = 'warn';
      f.sensitiveReason = c;
    }
  }
}

// Nivel B — secreto embebido en el contenido: escaneo del patch a commitear.
// Bloquea salvo overrideSecrets (falsos positivos: una regex en el propio código).
const SECRET_RULES: Array<{ rule: string; re: RegExp }> = [
  { rule: 'sk-ant-', re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { rule: 'sk-generic', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { rule: 'gho_', re: /\bgho_[A-Za-z0-9_]{10,}/ },
  { rule: 'ghp_', re: /\bghp_[A-Za-z0-9_]{10,}/ },
  { rule: 'github_pat_', re: /\bgithub_pat_[A-Za-z0-9_]{10,}/ },
  { rule: 'AKIA', re: /\bAKIA[0-9A-Z]{16}/ },
  { rule: 'xoxb-', re: /\bxoxb-[A-Za-z0-9-]{8,}/ },
  { rule: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'AIza', re: /\bAIza[0-9A-Za-z\-_]{35}/ },
];

const MAX_SECRET_FINDINGS = 50;

export interface SecretFinding {
  path: string;
  line: number;
  rule: string;
  excerpt: string;
}

function maskSecret(content: string, secret: string): string {
  const cut = content.length > 200 ? `${content.slice(0, 200)}…` : content;
  return cut.split(secret).join('•••');
}

/** Recorre un diff unificado y devuelve path:line + fragmento enmascarado. */
function scanPatchSecrets(patch: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let file = '';
  let line = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('@@ ')) {
      const m = raw.match(/\+(\d+)/);
      line = m ? Number(m[1]) : 0;
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const content = raw.slice(1);
      for (const { rule, re } of SECRET_RULES) {
        const m = content.match(re);
        if (m?.[0]) {
          findings.push({
            path: file === '' || file === '/dev/null' ? '(desconocido)' : file,
            line,
            rule,
            excerpt: maskSecret(content, m[0]),
          });
          break;
        }
      }
      line++;
      if (findings.length >= MAX_SECRET_FINDINGS) break;
    } else if (raw.startsWith(' ')) {
      line++;
    }
  }
  return findings;
}

// ---- Escrituras F3 ------------------------------------------------------------

/** Texto de error de execFile: stderr crudo (más stdout) para mostrar tal cual. */
function execErrText(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const e2 = e as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const err = typeof e2.stderr === 'string' ? e2.stderr : '';
    const out = typeof e2.stdout === 'string' ? e2.stdout : '';
    const combined = `${out}\n${err}`.trim();
    if (combined !== '') return combined;
    if (typeof e2.message === 'string') return e2.message;
  }
  return String(e);
}

const LOCK_RETRY_WAIT_MS = 400;

/**
 * Escritura con reintento único ante index.lock (colisión con el agente).
 * Todos los paths viajan tras `--`; nunca shell.
 */
async function runWrite(root: string, args: string[], timeout: number): Promise<RunOk> {
  try {
    return await runGit(root, args, timeout);
  } catch (e) {
    if (!/index\.lock/i.test(execErrText(e))) throw e;
    await new Promise((r) => setTimeout(r, LOCK_RETRY_WAIT_MS));
    return await runGit(root, args, timeout);
  }
}

const JSON_BODY_MAX = 1024 * 1024;

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > JSON_BODY_MAX) {
        reject(new Error('Cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Rutas relativas que no escapan del repo; null si el cuerpo es inválido. */
function cleanPaths(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: string[] = [];
  for (const p of v) {
    if (typeof p !== 'string' || p === '') return null;
    if (path.isAbsolute(p)) return null;
    const norm = path.normalize(p);
    if (norm === '..' || norm === '.' || norm.startsWith(`..${path.sep}`)) return null;
    out.push(p);
  }
  return out;
}

type WriteOutcome = { status: number; body: GitActionResult };
type GitWriteHandler = (root: string, body: Record<string, unknown>) => Promise<WriteOutcome>;

function okAction(body: GitActionResult): WriteOutcome {
  return { status: 200, body };
}

/**
 * Envuelve un POST de escritura: root tras allowlist, mutex por root,
 * invalidación de cachés + refresco inmediato en el cliente.
 */
async function runWriteRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fn: GitWriteHandler,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch {
    sendJson(req, res, 400, { ok: false, message: 'Cuerpo JSON inválido.' } satisfies GitActionResult);
    return;
  }
  const body: Record<string, unknown> =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (typeof body.root !== 'string' || body.root === '') {
    sendJson(req, res, 400, { ok: false, message: 'Falta root.' } satisfies GitActionResult);
    return;
  }
  const chk = await checkAllowed(body.root);
  if ('denied' in chk) {
    sendJson(req, res, 403, { ok: false, reason: 'not-allowed' });
    return;
  }
  const root = chk.real;
  try {
    const r = await withGitWriteLock(root, () => fn(root, body));
    sendJson(req, res, r.status, r.body);
  } catch (e) {
    sendJson(req, res, 200, { ok: false, message: execErrText(e) } satisfies GitActionResult);
  } finally {
    invalidateGitRoot(root);
  }
}

/** Rechaza paths de Nivel A (nunca se suben, sin override). */
function blockedLevelA(paths: string[]): string[] {
  return paths.filter((p) => levelAReason(p) !== null);
}

function levelABlock(paths: string[]): WriteOutcome {
  return okAction({
    ok: false,
    blocked: { files: paths, findings: [] },
    message: 'Archivos sensibles (Nivel A), excluidos: usa «ignorar» para añadirlos a .gitignore.',
  });
}

/** Subconjunto trackeado de paths (para restore/rm --cached). */
async function trackedSubset(root: string, paths: string[]): Promise<string[]> {
  try {
    const { stdout } = await runWrite(root, ['ls-files', '--', ...paths], READ_TIMEOUT_MS);
    return stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  } catch {
    return [];
  }
}

async function doPush(root: string, setUpstream: boolean): Promise<GitActionResult> {
  // git push / git push -u origin HEAD. NUNCA --force.
  const args = setUpstream ? ['push', '-u', 'origin', 'HEAD'] : ['push'];
  try {
    const r = await runWrite(root, args, NET_TIMEOUT_MS);
    return { ok: true, message: `${r.stdout}\n${r.stderr}`.trim() || 'Push completado.' };
  } catch (e) {
    return { ok: false, message: execErrText(e) };
  }
}

async function handleCommit(root: string, body: Record<string, unknown>): Promise<WriteOutcome> {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message === '') return okAction({ ok: false, message: 'Escribe un mensaje de commit primero.' });
  const scope = body.scope === 'all' ? 'all' : 'staged';
  const overrideSecrets = body.overrideSecrets === true;
  const pushAfter = body.push === true;

  let patch = '';
  if (scope === 'all') {
    // `git commit -a` subiría también .env y cía: se replica su conjunto
    // (trackeados modificados) menos el Nivel A, que queda excluido (D8).
    const st = await computeStatus(root);
    if (!st.ok) return okAction({ ok: false, message: 'No se pudo leer el estado del repo.' });
    const touched = st.files.filter(
      (f) => (f.staged || f.unstaged) && !f.untracked && !f.conflicted,
    );
    const blockedA = touched.filter((f) => f.sensitive === 'blocked').map((f) => f.path);
    const candidates = touched.filter((f) => f.sensitive !== 'blocked').map((f) => f.path);
    if (candidates.length === 0) {
      if (blockedA.length > 0) return levelABlock(blockedA);
      return okAction({ ok: false, message: 'No hay cambios que commitear.' });
    }
    try {
      // git diff HEAD -- <candidatos> (lo que se va a commitear)
      patch = (await runWrite(root, ['diff', 'HEAD', '--', ...candidates], READ_TIMEOUT_MS)).stdout;
    } catch (e) {
      return okAction({ ok: false, message: execErrText(e) });
    }
    const findings = scanPatchSecrets(patch);
    if (findings.length > 0 && !overrideSecrets) {
      return okAction({
        ok: false,
        blocked: { files: [...new Set(findings.map((f) => f.path))], findings },
        message: 'Posibles secretos en el contenido: commit bloqueado (Nivel B).',
      });
    }
    try {
      // git add -- <candidatos>
      await runWrite(root, ['add', '--', ...candidates], WRITE_TIMEOUT_MS);
    } catch (e) {
      return okAction({ ok: false, message: execErrText(e) });
    }
  } else {
    let names = '';
    try {
      // git diff --cached --name-only -z
      names = (await runWrite(root, ['diff', '--cached', '--name-only', '-z'], READ_TIMEOUT_MS)).stdout;
    } catch (e) {
      return okAction({ ok: false, message: execErrText(e) });
    }
    const staged = names.split('\0').map((s) => s.trim()).filter((s) => s !== '');
    const blockedA = staged.filter((p) => levelAReason(p) !== null);
    if (blockedA.length > 0) return levelABlock(blockedA);
    try {
      // git diff --cached -- (lo preparado)
      patch = (await runWrite(root, ['diff', '--cached', '--', ...staged], READ_TIMEOUT_MS)).stdout;
    } catch (e) {
      return okAction({ ok: false, message: execErrText(e) });
    }
    const findings = scanPatchSecrets(patch);
    if (findings.length > 0 && !overrideSecrets) {
      return okAction({
        ok: false,
        blocked: { files: [...new Set(findings.map((f) => f.path))], findings },
        message: 'Posibles secretos en el contenido: commit bloqueado (Nivel B).',
      });
    }
  }

  // git commit -m <mensaje> (scope 'all' ya preparó su conjunto arriba)
  let msg: string;
  try {
    const r = await runWrite(root, ['commit', '-m', message], WRITE_TIMEOUT_MS);
    msg = `${r.stdout}\n${r.stderr}`.trim() || 'Commit creado.';
  } catch (e) {
    return okAction({ ok: false, message: execErrText(e) });
  }
  if (pushAfter) {
    const pr = await doPush(root, false);
    if (!pr.ok) return okAction({ ok: false, message: `${msg}\n${pr.message ?? ''}`.trim() });
    msg = `${msg}\n${pr.message ?? ''}`.trim();
  }
  return okAction({ ok: true, message: msg });
}

// ---- Pull requests F4 ----------------------------------------------------------
// GET /api/git/pr (`gh pr view`), POST /api/git/pr (`gh pr create`),
// POST /api/git/pr/merge (`gh pr merge`). Caché 60 s (invalidada por
// push/commit/crear/merge vía invalidateGitRoot), timeout 60 s (red) y
// detección de remote GitHub vía `git remote get-url origin`.

/** Respuesta cruda de `gh pr view --json ...` (contrato §4.2). */
interface GhPrViewJson {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string | null;
  statusCheckRollup: Array<{ status?: string; conclusion?: string | null }>;
  baseRefName: string;
  headRefName: string;
  author: { login?: string } | null;
  updatedAt: string;
}

const GH_AUTH_HINT = 'Ejecuta `gh auth login` para autenticar gh.';

async function githubRemoteUrl(root: string): Promise<string | null> {
  // git remote get-url origin (detección de remote GitHub)
  const out = await tryGit(root, ['remote', 'get-url', 'origin']);
  if (!out) return null;
  const first = out.split('\n')[0]?.trim() ?? '';
  return first === '' ? null : first;
}

function isGithubUrl(url: string | null): boolean {
  return url !== null && /github\.com/i.test(url);
}

async function ghPresent(root: string): Promise<boolean> {
  try {
    await execFileAsync('gh', ['--version'], {
      cwd: root,
      env: BASE_ENV,
      timeout: READ_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

async function ghAuthenticated(root: string): Promise<boolean> {
  try {
    // gh auth status
    const st = await runGh(['auth', 'status'], NET_TIMEOUT_MS, root);
    return /Logged in to/i.test(`${st.stdout}\n${st.stderr}`);
  } catch {
    return false;
  }
}

/**
 * Mapea el JSON de `gh pr view` a GitPr: checks total/passed/failed/pending
 * desde statusCheckRollup (passed = SUCCESS/NEUTRAL/SKIPPED, failed = resto
 * de conclusiones terminales de error, pending = sin conclusión terminal).
 */
function mapGhPrView(j: GhPrViewJson): GitPr {
  const rollup = Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup : [];
  let passed = 0;
  let failed = 0;
  for (const c of rollup) {
    const conclusion = String(c?.conclusion ?? '').toUpperCase();
    if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') {
      passed++;
    } else if (
      conclusion === 'FAILURE' ||
      conclusion === 'CANCELLED' ||
      conclusion === 'TIMED_OUT' ||
      conclusion === 'ACTION_REQUIRED' ||
      conclusion === 'STARTUP_FAILURE' ||
      conclusion === 'STALE'
    ) {
      failed++;
    }
  }
  const state = String(j.state ?? '').toUpperCase();
  const mergeable = String(j.mergeable ?? 'UNKNOWN').toUpperCase();
  const rd = j.reviewDecision ? String(j.reviewDecision).toUpperCase() : null;
  return {
    number: Number(j.number),
    title: String(j.title ?? ''),
    url: String(j.url ?? ''),
    state: state === 'MERGED' ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    isDraft: j.isDraft === true,
    mergeable: mergeable === 'CONFLICTING'
      ? 'CONFLICTING'
      : mergeable === 'MERGEABLE'
        ? 'MERGEABLE'
        : 'UNKNOWN',
    reviewDecision: rd === 'APPROVED'
      ? 'APPROVED'
      : rd === 'CHANGES_REQUESTED'
        ? 'CHANGES_REQUESTED'
        : rd === 'REVIEW_REQUIRED'
          ? 'REVIEW_REQUIRED'
          : null,
    checks: { total: rollup.length, passed, failed, pending: rollup.length - passed - failed },
    baseRefName: String(j.baseRefName ?? ''),
    headRefName: String(j.headRefName ?? ''),
    author: typeof j.author?.login === 'string' ? j.author.login : '',
    updatedAt: String(j.updatedAt ?? ''),
  };
}

/** Lectura fresca del PR (sin caché): remote → gh → auth → `gh pr view`. */
async function computePrFresh(root: string): Promise<GitPrResult> {
  if (!isGithubUrl(await githubRemoteUrl(root))) return { ok: false, reason: 'not-github' };
  // Sin gh → no-gh + downloadUrl (D5).
  if (!(await ghPresent(root))) return { ok: false, reason: 'no-gh', downloadUrl: GH_DOWNLOAD_URL };
  // Sin auth → gh-unauthenticated + hint.
  if (!(await ghAuthenticated(root))) {
    return { ok: false, reason: 'gh-unauthenticated', hint: GH_AUTH_HINT };
  }
  try {
    // gh pr view --json number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup,baseRefName,headRefName,author,updatedAt
    const { stdout } = await runGh(
      [
        'pr',
        'view',
        '--json',
        'number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup,baseRefName,headRefName,author,updatedAt',
      ],
      NET_TIMEOUT_MS,
      root,
    );
    const parsed: unknown = JSON.parse(stdout);
    return { ok: true, pr: mapGhPrView(parsed as GhPrViewJson) };
  } catch (e) {
    const msg = execErrText(e);
    if (/no pull requests? found/i.test(msg)) return { ok: true, pr: null };
    return { ok: false, reason: 'error', message: msg };
  }
}

async function getPr(root: string): Promise<GitPrResult> {
  const key = cacheKey(root);
  const hit = prCache.get(key);
  if (hit && cacheFresh(hit.at, PR_TTL_MS)) return hit.value;
  const value = await computePrFresh(root);
  prCache.set(key, { at: Date.now(), value });
  return value;
}

// ---- HTTP -----------------------------------------------------------------------
// ---- Sugerencia de mensaje F5 ----------------------------------------------------
// Conventional Commit desde el diff PREPARADO (nunca el worktree sin preparar)
// usando los routers de .routers.json, todo server-side: la apiKey del router
// nunca sale al cliente (D7). Higiene antes de llamar al LLM: se excluyen los
// archivos Nivel A y los secretos Nivel B se enmascaran con •••.

const SUGGEST_DIFF_MAX_BYTES = 12 * 1024;
const SUGGEST_TIMEOUT_MS = 30_000;
const SUGGEST_SYSTEM =
  'Generas mensajes de commit siguiendo Conventional Commits ' +
  '("<tipo>: <descripción>", con tipos feat, fix, docs, style, refactor, test, chore). ' +
  'Responde en español con UNA sola línea de máximo 72 caracteres, sin comillas, ' +
  'sin fences de código y sin explicación. Describe únicamente lo que cambia el diff; ' +
  'prohibido mensajes genéricos como "update files" o "cambios varios". Solo el mensaje.';

/** Enmascara los secretos Nivel B de un patch antes de enviarlo al LLM. */
function maskPatchForLlm(patch: string): string {
  let out = patch;
  for (const { re } of SECRET_RULES) {
    out = out.replace(new RegExp(re.source, 'g'), '•••');
  }
  return out;
}

/** Corta por líneas para no partir un carácter multibyte. */
function cutForLlm(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let acc = 0;
  const kept: string[] = [];
  for (const ln of s.split('\n')) {
    const lb = Buffer.byteLength(`${ln}\n`, 'utf8');
    if (acc + lb > maxBytes) break;
    kept.push(ln);
    acc += lb;
  }
  return `${kept.join('\n')}\n…(truncado)`;
}

/**
 * Entrada para el LLM: lo mismo que va a commitear. Scope 'staged' = diff
 * preparado; scope 'all' = preparado + no preparado (tracked, como `commit -a`).
 * Sin Nivel A, con Nivel B enmascarado. Vacío si no hay nada que commitear.
 */
async function buildSuggestInput(
  root: string,
  scope: 'staged' | 'all',
): Promise<{ input: string } | { empty: string }> {
  const namesOf = (out: string): string[] =>
    out
      .split('\0')
      .map((s) => s.trim())
      .filter((s) => s !== '' && levelAReason(s) === null);
  let staged: string[] = [];
  let unstaged: string[] = [];
  try {
    staged = namesOf(
      (await runGit(root, ['diff', '--cached', '--name-only', '-z'], READ_TIMEOUT_MS)).stdout,
    );
    if (scope === 'all') {
      unstaged = namesOf(
        (await runGit(root, ['diff', '--name-only', '-z'], READ_TIMEOUT_MS)).stdout,
      ).filter((s) => !staged.includes(s));
    }
  } catch (e) {
    return { empty: execErrText(e) };
  }
  if (staged.length === 0 && unstaged.length === 0) {
    return {
      empty:
        scope === 'all'
          ? 'No hay cambios para commitear.'
          : 'Prepara cambios (▸) antes de pedir una sugerencia, o marca «todo».',
    };
  }
  const sections: string[] = [];
  try {
    if (staged.length > 0) {
      const stat = (await runGit(root, ['diff', '--cached', '--stat', '--', ...staged], READ_TIMEOUT_MS)).stdout;
      const patch = (await runGit(root, ['diff', '--cached', '--', ...staged], READ_TIMEOUT_MS)).stdout;
      sections.push(`Cambios preparados:\n${staged.join('\n')}\n\n${stat}\n${maskPatchForLlm(patch)}`);
    }
    if (unstaged.length > 0) {
      const stat = (await runGit(root, ['diff', '--stat', '--', ...unstaged], READ_TIMEOUT_MS)).stdout;
      const patch = (await runGit(root, ['diff', '--', ...unstaged], READ_TIMEOUT_MS)).stdout;
      sections.push(
        `Cambios sin preparar (se commitearán con «todo»):\n${unstaged.join('\n')}\n\n${stat}\n${maskPatchForLlm(patch)}`,
      );
    }
  } catch (e) {
    return { empty: execErrText(e) };
  }
  return { input: cutForLlm(sections.join('\n\n'), SUGGEST_DIFF_MAX_BYTES) };
}

/** Hechos compactos del estado + frase local, para el resumen de voz. */
function buildSpeakFacts(st: GitStatus): { facts: string; template: string } {
  const branch = st.detached ? st.head : (st.branch ?? st.head);
  const n = st.files.length;
  const top = st.files.slice(0, 12).map((f) => f.path);
  const last = st.lastCommit ? `"${st.lastCommit.subject}"` : 'sin commits';
  const facts =
    `Rama: ${branch} (ahead ${st.ahead}, behind ${st.behind}). ` +
    `Archivos con cambios: ${n} (${st.staged.files} preparados, ` +
    `${st.unstaged.files} sin preparar, ${st.untracked} sin seguimiento). ` +
    `Líneas: +${st.staged.added + st.unstaged.added} -${st.staged.deleted + st.unstaged.deleted}. ` +
    `Último commit: ${last}. Conflictos: ${st.conflicts}. Operación: ${st.operation}.` +
    (top.length > 0 ? ` Archivos: ${top.join(', ')}.` : '');
  const parts = [`Rama ${branch}`];
  parts.push(
    n === 0 ? 'sin cambios' : `${n} archivo${n === 1 ? '' : 's'} con cambios, ${st.staged.files} preparados`,
  );
  if (st.ahead > 0) parts.push(`${st.ahead} commit${st.ahead === 1 ? '' : 's'} por subir`);
  if (st.behind > 0) parts.push(`${st.behind} por bajar`);
  if (st.conflicts > 0) parts.push(`${st.conflicts} conflicto${st.conflicts === 1 ? '' : 's'}`);
  if (st.operation !== 'none') parts.push(`operación ${st.operation} en curso`);
  return { facts, template: `${parts.join('. ')}.` };
}

/** Una línea de respuesta del LLM → Conventional Commit limpio (sin fences
 *  ni comillas; no se come la primera palabra aunque comparta línea). */
function cleanSuggestLine(s: string): string {
  let t = s.trim();
  if (t.startsWith('```') && t.endsWith('```') && t.length > 6) {
    t = t.slice(3, -3).trim();
  }
  t = t.replace(/^```[\w-]*\s*/, '').replace(/\s*```$/, '');
  return t.replace(/^["'`]|["'`]$/g, '').trim();
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
}
interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
}

/** Llama al router en formato Anthropic Messages (igual que testRouter) y
 *  devuelve el texto plano de la respuesta. */
async function callRouterMessages(
  router: RouterConfig,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  const model = router.sonnetModel || router.opusModel || router.haikuModel || 'default';
  const cleanBase = router.baseUrl.replace(/\/+$/, '');
  const url = cleanBase.endsWith('/v1') ? `${cleanBase}/messages` : `${cleanBase}/v1/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': router.apiKey,
      'anthropic-version': '2023-06-01',
      authorization: `Bearer ${router.apiKey}`,
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as AnthropicMessagesResponse;
  const text = (json.content ?? [])
    .map((b) => (typeof b.text === 'string' ? b.text.trim() : ''))
    .filter((s) => s !== '')
    .join('\n');
  if (text === '') throw new Error('respuesta sin contenido');
  return text;
}

/** Una línea con forma de Conventional Commit (para saltar preámbulos del LLM). */
const COMMIT_SHAPE_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?:\s+\S/i;

/** Texto del LLM → una sola línea de Conventional Commit. */
async function suggestViaRouter(router: RouterConfig, diffInput: string): Promise<string> {
  const text = await callRouterMessages(
    router,
    SUGGEST_SYSTEM,
    `Genera el mensaje de commit para este diff:\n\n${diffInput}`,
    128,
  );
  const lines = text
    .split('\n')
    .map(cleanSuggestLine)
    .filter((s) => s !== '');
  const line = lines.find((s) => COMMIT_SHAPE_RE.test(s)) ?? lines[0];
  if (!line) throw new Error('respuesta sin contenido');
  return line.slice(0, 120);
}

const SPEAK_SYSTEM =
  'Resume el estado de un repositorio git para LEERLO EN VOZ ALTA en español. ' +
  'Responde con 2 o 3 frases cortas y naturales, sin markdown, sin listas, sin código ' +
  'y sin nombrar más de dos archivos. Solo el resumen.';

/** Hechos del LLM → frase hablable (una línea, sin markdown). */
async function speakViaRouter(router: RouterConfig, facts: string): Promise<string> {
  const text = await callRouterMessages(router, SPEAK_SYSTEM, `Resume este estado git:\n\n${facts}`, 256);
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '') throw new Error('respuesta sin contenido');
  return clean.slice(0, 400);
}

function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin ?? '*';
  return {
    'Access-Control-Allow-Origin': origin,
    // Solo GET/POST/OPTIONS: prohibido PUT/PATCH.
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function sendJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...corsHeaders(req),
  });
  res.end(payload);
}

function defaultCwd(): string {
  const viaHook = hooks?.resolveCwd(undefined, undefined);
  return viaHook ?? process.cwd();
}

/** Atiende /api/git/* (solo GET/POST/OPTIONS). Devuelve true si la manejó. */
export async function handleGitHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  const segs = pathname.split('/');
  if (segs[1] !== 'api' || segs[2] !== 'git') return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    // PUT/PATCH (y DELETE) prohibidos en /api/git/*.
    sendJson(req, res, 405, { ok: false, reason: 'error', message: `Método no permitido: ${req.method}` });
    return true;
  }

  const rest = `/${segs.slice(3).join('/')}`;

  // GET /api/git/tooling → GitTooling
  if (rest === '/tooling' && req.method === 'GET') {
    sendJson(req, res, 200, await getTooling(defaultCwd()));
    return true;
  }

  // GET /api/git/repos → { ok, cwd, repos }
  if (rest === '/repos' && req.method === 'GET') {
    const sectionId = url.searchParams.get('sectionId') ?? undefined;
    const cwdParam = url.searchParams.get('cwd') ?? undefined;
    const cwd = cwdParam ?? hooks?.resolveCwd(sectionId, undefined) ?? defaultCwd();
    const key = `repos:${path.resolve(cwd)}`;
    const hit = reposCache.get(key);
    if (hit && cacheFresh(hit.at, REPOS_TTL_MS)) {
      sendJson(req, res, 200, { ok: true, cwd: path.resolve(cwd), repos: hit.value });
      return true;
    }
    const { repos } = await discoverRepos(cwd);
    reposCache.set(key, { at: Date.now(), value: repos });
    sendJson(req, res, 200, { ok: true, cwd: path.resolve(cwd), repos });
    return true;
  }

  // GET /api/git/status → GitStatusResult
  if (rest === '/status' && req.method === 'GET') {
    const rootParam = url.searchParams.get('root') ?? undefined;
    const sectionId = url.searchParams.get('sectionId') ?? undefined;
    if (rootParam) {
      const chk = await checkAllowed(rootParam);
      if ('denied' in chk) {
        sendJson(req, res, 403, { ok: false, reason: 'not-allowed' });
        return true;
      }
      sendJson(req, res, 200, await getStatus(chk.real));
      return true;
    }
    // Sin root: el primary del cwd de la sección (o cwd por defecto).
    const cwd = hooks?.resolveCwd(sectionId, undefined) ?? defaultCwd();
    const { repos } = await discoverRepos(cwd);
    const primary = repos.find((r) => r.primary) ?? repos[0];
    if (!primary) {
      sendJson(req, res, 200, {
        ok: false,
        reason: 'not-a-repo',
        cwd: path.resolve(cwd),
        candidates: [],
      } satisfies GitStatusResult);
      return true;
    }
    sendJson(req, res, 200, await getStatus(primary.root));
    return true;
  }

  // GET /api/git/diff → { ok, patch, truncated }
  if (rest === '/diff' && req.method === 'GET') {
    const rootParam = url.searchParams.get('root') ?? '';
    const rel = url.searchParams.get('path') ?? '';
    const staged = url.searchParams.get('staged') === '1';
    if (!rootParam || !rel) {
      sendJson(req, res, 400, { ok: false, reason: 'error', message: 'Faltan ?root= y ?path=' });
      return true;
    }
    const chk = await checkAllowed(rootParam);
    if ('denied' in chk) {
      sendJson(req, res, 403, { ok: false, reason: 'not-allowed' });
      return true;
    }
    const result = await computeDiff(chk.real, rel, staged);
    sendJson(req, res, 200, result);
    return true;
  }

  // GET /api/git/pr → GitPrResult (caché 60 s)
  if (rest === '/pr' && req.method === 'GET') {
    const rootParam = url.searchParams.get('root') ?? '';
    if (rootParam === '') {
      sendJson(req, res, 400, { ok: false, reason: 'error', message: 'Falta ?root=' });
      return true;
    }
    const chk = await checkAllowed(rootParam);
    if ('denied' in chk) {
      sendJson(req, res, 403, { ok: false, reason: 'not-allowed' });
      return true;
    }
    sendJson(req, res, 200, await getPr(chk.real));
    return true;
  }

  // ---- Escrituras F3 (solo POST) ----
  if (req.method === 'POST') {
    // POST /api/git/stage {root, paths[]} → git add -- <paths>
    if (rest === '/stage') {
      await runWriteRoute(req, res, async (root, body) => {
        const paths = cleanPaths(body.paths);
        if (!paths) return { status: 400, body: { ok: false, message: 'paths[] inválido.' } };
        const blockedA = blockedLevelA(paths);
        if (blockedA.length > 0) return levelABlock(blockedA);
        try {
          await runWrite(root, ['add', '--', ...paths], WRITE_TIMEOUT_MS);
          return okAction({ ok: true, message: `${paths.length} archivo(s) preparado(s).` });
        } catch (e) {
          return okAction({ ok: false, message: execErrText(e) });
        }
      });
      return true;
    }

    // POST /api/git/unstage {root, paths[]} → git restore --staged -- <paths>
    if (rest === '/unstage') {
      await runWriteRoute(req, res, async (root, body) => {
        const paths = cleanPaths(body.paths);
        if (!paths) return { status: 400, body: { ok: false, message: 'paths[] inválido.' } };
        try {
          await runWrite(root, ['restore', '--staged', '--', ...paths], WRITE_TIMEOUT_MS);
          return okAction({ ok: true, message: `${paths.length} archivo(s) fuera del commit.` });
        } catch (e) {
          return okAction({ ok: false, message: execErrText(e) });
        }
      });
      return true;
    }

    // POST /api/git/discard {root, paths[], mode:'stash'|'hard'} (D6).
    // stash (defecto): recuperable; hard: restore + clean. Nunca reset --hard.
    if (rest === '/discard') {
      await runWriteRoute(req, res, async (root, body) => {
        const paths = cleanPaths(body.paths);
        if (!paths) return { status: 400, body: { ok: false, message: 'paths[] inválido.' } };
        if (body.mode === 'hard') {
          const tracked = await trackedSubset(root, paths);
          if (tracked.length > 0) {
            try {
              // git restore -- <trackeados>
              await runWrite(root, ['restore', '--', ...tracked], WRITE_TIMEOUT_MS);
            } catch (e) {
              return okAction({ ok: false, message: execErrText(e) });
            }
          }
          try {
            // git clean -fd -- <paths> (solo toca lo sin seguimiento)
            await runWrite(root, ['clean', '-fd', '--', ...paths], WRITE_TIMEOUT_MS);
          } catch (e) {
            return okAction({ ok: false, message: execErrText(e) });
          }
          return okAction({ ok: true, message: `Cambios eliminados en ${paths.length} archivo(s).` });
        }
        const tag = `bennzen/discard-${new Date().toISOString()}`;
        try {
          // git stash push --include-untracked -m "bennzen/discard-<ISO>" -- <paths>
          await runWrite(
            root,
            ['stash', 'push', '--include-untracked', '-m', tag, '--', ...paths],
            WRITE_TIMEOUT_MS,
          );
          return okAction({ ok: true, message: `Descartado en stash ${tag}.` });
        } catch (e) {
          return okAction({ ok: false, message: execErrText(e) });
        }
      });
      return true;
    }

    // POST /api/git/commit {root, message, scope, push?, overrideSecrets?}
    if (rest === '/commit') {
      await runWriteRoute(req, res, handleCommit);
      return true;
    }

    // POST /api/git/push {root, setUpstream?} → git push / -u origin HEAD
    if (rest === '/push') {
      await runWriteRoute(req, res, async (root, body) => okAction(await doPush(root, body.setUpstream === true)));
      return true;
    }

    // POST /api/git/pull {root, rebase?} → git pull --ff-only / --rebase
    if (rest === '/pull') {
      await runWriteRoute(req, res, async (root, body) => {
        // git pull --ff-only / git pull --rebase
        const args = body.rebase === true ? ['pull', '--rebase'] : ['pull', '--ff-only'];
        try {
          const r = await runWrite(root, args, NET_TIMEOUT_MS);
          return okAction({ ok: true, message: `${r.stdout}\n${r.stderr}`.trim() || 'Pull completado.' });
        } catch (e) {
          return okAction({ ok: false, message: execErrText(e) });
        }
      });
      return true;
    }

    // POST /api/git/fetch {root} → git fetch --prune
    if (rest === '/fetch') {
      await runWriteRoute(req, res, async (root) => {
        try {
          const r = await runWrite(root, ['fetch', '--prune'], NET_TIMEOUT_MS);
          return okAction({ ok: true, message: `${r.stdout}\n${r.stderr}`.trim() || 'Fetch completado.' });
        } catch (e) {
          return okAction({ ok: false, message: execErrText(e) });
        }
      });
      return true;
    }

    // POST /api/git/undo-commit {root} → git reset --soft HEAD~1
    if (rest === '/undo-commit') {
      await runWriteRoute(req, res, async (root) => {
        try {
          const r = await runWrite(root, ['reset', '--soft', 'HEAD~1'], WRITE_TIMEOUT_MS);
          return okAction({ ok: true, message: `${r.stdout}\n${r.stderr}`.trim() || 'Último commit deshecho.' });
        } catch (e) {
          return okAction({ ok: false, message: execErrText(e) });
        }
      });
      return true;
    }

    // POST /api/git/ignore {root, paths[]} → .gitignore + git rm --cached si trackeado
    if (rest === '/ignore') {
      await runWriteRoute(req, res, async (root, body) => {
        const paths = cleanPaths(body.paths);
        if (!paths) return { status: 400, body: { ok: false, message: 'paths[] inválido.' } };
        try {
          const giPath = path.join(root, '.gitignore');
          let cur = '';
          try {
            cur = fs.readFileSync(giPath, 'utf8');
          } catch {
            cur = '';
          }
          const present = new Set(cur.split('\n').map((l) => l.trim()));
          const additions = paths.filter((p) => !present.has(p));
          if (additions.length > 0) {
            fs.appendFileSync(giPath, `${cur === '' || cur.endsWith('\n') ? '' : '\n'}${additions.join('\n')}\n`);
          }
        } catch (e) {
          return okAction({ ok: false, message: execErrText(e) });
        }
        const tracked = await trackedSubset(root, paths);
        if (tracked.length > 0) {
          try {
            await runWrite(root, ['rm', '--cached', '--', ...tracked], WRITE_TIMEOUT_MS);
          } catch (e) {
            return okAction({ ok: false, message: execErrText(e) });
          }
        }
        return okAction({ ok: true, message: `${paths.join(', ')} añadido a .gitignore.` });
      });
      return true;
    }

    // POST /api/git/init {root} → git init (el root es el cwd: pasa el allowlist)
    if (rest === '/init') {
      await runWriteRoute(req, res, async (root) => {
        try {
          const r = await runWrite(root, ['init'], WRITE_TIMEOUT_MS);
          reposCache.clear();
          return okAction({ ok: true, message: `${r.stdout}\n${r.stderr}`.trim() || 'Repositorio inicializado.' });
        } catch (e) {
          return okAction({ ok: false, message: execErrText(e) });
        }
      });
      return true;
    }

    // POST /api/git/pr {title, body, base?, draft?} → GitPrResult
    // gh pr create --title <t> --body <b> [--base <b>] [--draft]
    if (rest === '/pr') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        sendJson(req, res, 400, { ok: false, reason: 'error', message: 'Cuerpo JSON inválido.' });
        return true;
      }
      const payload: Record<string, unknown> =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      if (typeof payload.root !== 'string' || payload.root === '') {
        sendJson(req, res, 400, { ok: false, reason: 'error', message: 'Falta root.' });
        return true;
      }
      const chk = await checkAllowed(payload.root);
      if ('denied' in chk) {
        sendJson(req, res, 403, { ok: false, reason: 'not-allowed' });
        return true;
      }
      const root = chk.real;
      const title = typeof payload.title === 'string' ? payload.title.trim() : '';
      const prBody = typeof payload.body === 'string' ? payload.body : '';
      const base =
        typeof payload.base === 'string' && payload.base.trim() !== ''
          ? payload.base.trim()
          : undefined;
      const draft = payload.draft === true;
      if (title === '') {
        sendJson(req, res, 400, { ok: false, reason: 'error', message: 'Falta el título del PR.' });
        return true;
      }
      if (base !== undefined && /[\s;|&$`]/.test(base)) {
        sendJson(req, res, 400, { ok: false, reason: 'error', message: 'base inválida.' });
        return true;
      }
      try {
        const result = await withGitWriteLock(root, async (): Promise<GitPrResult> => {
          if (!isGithubUrl(await githubRemoteUrl(root))) {
            return { ok: false, reason: 'not-github' };
          }
          if (!(await ghPresent(root))) {
            return { ok: false, reason: 'no-gh', downloadUrl: GH_DOWNLOAD_URL };
          }
          if (!(await ghAuthenticated(root))) {
            return { ok: false, reason: 'gh-unauthenticated', hint: GH_AUTH_HINT };
          }
          const args = [
            'pr',
            'create',
            '--title',
            title,
            '--body',
            prBody,
            ...(base !== undefined ? ['--base', base] : []),
            ...(draft ? ['--draft'] : []),
          ];
          try {
            await runGh(args, NET_TIMEOUT_MS, root);
          } catch (e) {
            return { ok: false, reason: 'error', message: execErrText(e) };
          }
          prCache.delete(cacheKey(root));
          return await computePrFresh(root);
        });
        sendJson(req, res, 200, result);
      } catch (e) {
        sendJson(req, res, 200, { ok: false, reason: 'error', message: execErrText(e) });
      } finally {
        invalidateGitRoot(root);
      }
      return true;
    }

    // POST /api/git/pr/merge {number, method, deleteBranch?} → GitActionResult
    // gh pr merge <n> --squash|--merge|--rebase [--delete-branch]
    if (rest === '/pr/merge') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        sendJson(req, res, 400, { ok: false, message: 'Cuerpo JSON inválido.' } satisfies GitActionResult);
        return true;
      }
      const payload: Record<string, unknown> =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      if (typeof payload.root !== 'string' || payload.root === '') {
        sendJson(req, res, 400, { ok: false, message: 'Falta root.' } satisfies GitActionResult);
        return true;
      }
      const chk = await checkAllowed(payload.root);
      if ('denied' in chk) {
        sendJson(req, res, 403, { ok: false, reason: 'not-allowed' });
        return true;
      }
      const root = chk.real;
      const rawNumber = payload.number;
      const number =
        typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number(rawNumber) : NaN;
      if (!Number.isInteger(number) || number <= 0) {
        sendJson(req, res, 400, { ok: false, message: 'Falta number de PR válido.' } satisfies GitActionResult);
        return true;
      }
      const method = payload.method;
      if (method !== 'squash' && method !== 'merge' && method !== 'rebase') {
        sendJson(req, res, 400, { ok: false, message: 'method debe ser squash|merge|rebase.' } satisfies GitActionResult);
        return true;
      }
      const deleteBranch = payload.deleteBranch === true;
      try {
        const result = await withGitWriteLock(root, async (): Promise<GitActionResult> => {
          if (!(await ghPresent(root))) {
            return {
              ok: false,
              message: `gh no instalado: descárgalo en ${GH_DOWNLOAD_URL}.`,
              detail: GH_DOWNLOAD_URL,
            };
          }
          if (!(await ghAuthenticated(root))) {
            return { ok: false, message: GH_AUTH_HINT };
          }
          const flag = method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge';
          try {
            const r = await runGh(
              ['pr', 'merge', String(number), flag, ...(deleteBranch ? ['--delete-branch'] : [])],
              NET_TIMEOUT_MS,
              root,
            );
            return {
              ok: true,
              message: `${r.stdout}\n${r.stderr}`.trim() || `PR #${number} fusionado (${method}).`,
            };
          } catch (e) {
            return { ok: false, message: execErrText(e) };
          }
        });
        sendJson(req, res, 200, result);
      } catch (e) {
        sendJson(req, res, 200, { ok: false, message: execErrText(e) } satisfies GitActionResult);
      } finally {
        invalidateGitRoot(root);
      }
      return true;
    }

    // POST /api/git/suggest-message {root, routerId?} → { ok, message }
    // Conventional Commit desde el diff PREPARADO, vía routers de
    // .routers.json, todo server-side (la apiKey nunca sale al cliente, D7).
    if (rest === '/suggest-message') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        sendJson(req, res, 400, { ok: false, message: 'Cuerpo JSON inválido.' });
        return true;
      }
      const payload: Record<string, unknown> =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      if (typeof payload.root !== 'string' || payload.root === '') {
        sendJson(req, res, 400, { ok: false, message: 'Falta root.' });
        return true;
      }
      const chk = await checkAllowed(payload.root);
      if ('denied' in chk) {
        sendJson(req, res, 403, { ok: false, reason: 'not-allowed' });
        return true;
      }
      const root = chk.real;
      const routerId =
        typeof payload.routerId === 'string' && payload.routerId !== '' ? payload.routerId : undefined;
      const routers = loadRouters();
      if (routers.length === 0) {
        sendJson(req, res, 200, {
          ok: false,
          message: 'Sin routers configurados: crea uno en Ajustes → Routers.',
        });
        return true;
      }
      const router = routerId !== undefined ? getRouter(routerId) : routers[0];
      if (!router) {
        sendJson(req, res, 200, { ok: false, message: `Router «${routerId}» no encontrado.` });
        return true;
      }
      const scope = payload.scope === 'all' ? 'all' : 'staged';
      const built = await buildSuggestInput(root, scope);
      if ('empty' in built) {
        sendJson(req, res, 200, { ok: false, message: built.empty });
        return true;
      }
      try {
        const message = await suggestViaRouter(router, built.input);
        sendJson(req, res, 200, { ok: true, message });
      } catch (e) {
        sendJson(req, res, 200, {
          ok: false,
          message: `No se pudo sugerir (${router.name}): ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      return true;
    }

    // POST /api/git/speak-summary {root, routerId?} → { ok, message, via? }
    // Resumen hablable del estado: el router de Ajustes → Routers lo redacta;
    // sin routers (o si el LLM falla) cae a la frase local. La PWA lo lee con
    // la voz de la sección (config de voz de bennzen).
    if (rest === '/speak-summary') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        sendJson(req, res, 400, { ok: false, message: 'Cuerpo JSON inválido.' });
        return true;
      }
      const payload: Record<string, unknown> =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      if (typeof payload.root !== 'string' || payload.root === '') {
        sendJson(req, res, 400, { ok: false, message: 'Falta root.' });
        return true;
      }
      const chk = await checkAllowed(payload.root);
      if ('denied' in chk) {
        sendJson(req, res, 403, { ok: false, reason: 'not-allowed' });
        return true;
      }
      const root = chk.real;
      const st = await getStatus(root);
      if (!st.ok) {
        const reason =
          st.reason === 'not-a-repo'
            ? 'Sin repositorio git para resumir.'
            : st.reason === 'no-git'
              ? 'git no está instalado.'
              : 'No se pudo leer el estado git.';
        sendJson(req, res, 200, { ok: false, message: reason });
        return true;
      }
      const { facts, template } = buildSpeakFacts(st);
      const routerId =
        typeof payload.routerId === 'string' && payload.routerId !== '' ? payload.routerId : undefined;
      const routers = loadRouters();
      const router = routerId !== undefined ? getRouter(routerId) : routers[0];
      if (!router) {
        sendJson(req, res, 200, { ok: true, message: template, via: 'template' });
        return true;
      }
      try {
        const message = await speakViaRouter(router, facts);
        sendJson(req, res, 200, { ok: true, message, via: 'llm' });
      } catch {
        sendJson(req, res, 200, { ok: true, message: template, via: 'template' });
      }
      return true;
    }
    sendJson(req, res, 404, { ok: false, reason: 'error', message: `Ruta git desconocida: ${rest}` });
    return true;
  }
  sendJson(req, res, 404, { ok: false, reason: 'error', message: `Ruta git desconocida: ${rest}` });
  return true;
}
