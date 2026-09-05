// Tipos del panel git de bennzen (F0).
// `shared/protocol.ts` se reserva para el WebSocket; este módulo lo importan
// tanto el orquestador como la PWA. Contrato exacto de docs/plan-git-panel.md §4.1.

// ---- Disponibilidad de herramientas -------------------------------------
export interface ToolState {
  ok: boolean;
  version?: string;
  downloadUrl: string;
}
export interface GitTooling {
  git: ToolState; // https://git-scm.com/downloads
  gh: ToolState & { authenticated: boolean; user?: string }; // https://cli.github.com
}

// ---- Descubrimiento de repos --------------------------------------------
export interface GitRepoRef {
  root: string; // ruta absoluta al toplevel
  name: string; // basename(root)
  kind: 'cwd' | 'child' | 'submodule';
  primary: boolean; // el repo que contiene al cwd de la sección
}

// ---- Estado ---------------------------------------------------------------
export type SensitiveLevel = 'none' | 'blocked' | 'warn';

export interface GitFileChange {
  path: string; // relativa al root
  origPath?: string; // renombrados
  index: string; // código X de porcelain v2
  worktree: string; // código Y
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  added: number;
  deleted: number;
  binary: boolean;
  sizeBytes?: number;
  sensitive: SensitiveLevel;
  sensitiveReason?: string;
}

export interface GitTotals {
  files: number;
  added: number;
  deleted: number;
}

export interface GitStatus {
  ok: true;
  root: string;
  name: string;
  branch: string | null; // null si detached
  detached: boolean;
  head: string; // sha corto
  upstream: string | null;
  ahead: number;
  behind: number;
  user: { name: string; email: string };
  remoteUrl: string | null;
  remoteHost: 'github' | 'other' | null;
  files: GitFileChange[];
  staged: GitTotals;
  unstaged: GitTotals;
  untracked: number;
  stashes: number;
  conflicts: number;
  lastCommit: { hash: string; subject: string; author: string; relDate: string } | null;
  operation: 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';
  protectedBranch: boolean; // main | master | develop | production
}

export type GitStatusResult =
  | GitStatus
  | { ok: false; reason: 'not-a-repo'; cwd: string; candidates: GitRepoRef[] }
  | { ok: false; reason: 'no-git'; downloadUrl: string }
  | { ok: false; reason: 'not-allowed' }
  | { ok: false; reason: 'error'; message: string };

// ---- Pull requests --------------------------------------------------------
export interface GitPr {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  checks: { total: number; passed: number; failed: number; pending: number };
  baseRefName: string;
  headRefName: string;
  author: string;
  updatedAt: string;
}

export type GitPrResult =
  | { ok: true; pr: GitPr | null }
  | { ok: false; reason: 'no-gh'; downloadUrl: string }
  | { ok: false; reason: 'gh-unauthenticated'; hint: string }
  | { ok: false; reason: 'not-github' }
  | { ok: false; reason: 'error'; message: string };

// ---- Resultado genérico de acción ----------------------------------------
export interface GitActionResult {
  ok: boolean;
  message?: string; // stderr real de git, para mostrar tal cual
  detail?: string;
  blocked?: {
    // guardia de secretos
    files: string[];
    findings: Array<{ path: string; line: number; rule: string; excerpt: string }>;
  };
}
