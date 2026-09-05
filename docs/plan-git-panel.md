# Plan · Panel Git de bennzen

> Estado: **aprobado, pendiente de ejecución**
> Autor: sesión Claude Code · Fecha: 2026-09-05
> Alcance aprobado por el usuario: **completo (F0 → F6)**

---

## 1. Objetivo

Añadir a bennzen un **indicador git en el centro del header** y un **modal de gestión git en dos
columnas**, ambos conscientes de que cada sección trabaja sobre un repositorio distinto y de que
los agentes CLI modifican el working tree mientras el usuario mira.

---

## 2. Decisiones cerradas (no replanificar)

| # | Decisión | Valor |
|---|---|---|
| D1 | Alcance | Completo: F0 → F6 |
| D2 | Ámbito del repo | **Sigue a la sección activa**. Si el `cwd` contiene varios repos → **selector `▾`** en el widget, con elección persistida por sección |
| D3 | Actualización | **Polling adaptativo** + invalidación reactiva por actividad del agente + refresco inmediato tras cada acción |
| D4 | Sin repositorio | Estado explícito en el widget y en el modal, con acción opcional `git init` |
| D5 | Herramienta ausente | Estado explícito; **clic → abre la página de descarga oficial** en pestaña nueva |
| D6 | Descartar cambios | **`git stash push` recuperable** con etiqueta `bennzen/discard-<ISO>` (modo duro disponible, nunca por defecto) |
| D7 | Mensaje de commit IA | Vía **routers de `.routers.json`**, endpoint server-side |
| D8 | Secretos | **Nunca se suben.** Archivos sensibles excluidos del commit por defecto + acción "añadir a `.gitignore`". Secretos embebidos en contenido → commit bloqueado |

---

## 3. Restricciones del código existente (verificadas)

1. `orchestrator/server.ts:37` — `if (req.url?.startsWith('/api/'))` es un **catch-all** hacia el
   proxy de voz. `/api/git` **debe registrarse antes de esa línea**, con el patrón
   `const handled = await handleGitHttp(req, res); if (handled) return;`.
2. CORS de los módulos existentes permite `GET, POST, DELETE, OPTIONS`. **Prohibido PUT/PATCH.**
3. `registry` y `ptyRegistry` son consts locales de `server.ts`, no exportadas → `git.ts` recibe un
   resolver `sectionId → cwd` **por inyección** (mismo patrón que `PtyHooks`, `pty.ts:20-25`).
4. `PtyRegistry` no expone getter individual: usar `ptyRegistry.list().find(...)`.
5. `void handle(ws, msg)` no se await-ea → sin cola por sección. Necesario **mutex por repo**.
6. El `switch` de `server.ts:206` tiene check de exhaustividad (`const _exhaustive: never`): todo
   `ClientMsg` nuevo obliga a añadir su `case` o rompe `npm run typecheck`.
7. `pwa/main.ts` monta el DOM en top-level y `$()` **lanza** si el selector no existe → todo markup
   nuevo debe estar en `index.html` antes del import.
8. `.overlay[hidden] { display:none }` es obligatorio para cualquier contenedor flex/grid oculto.
9. La cadena de Escape vive en `pwa/main.ts:2105-2111` — registrar ahí el modal nuevo.

---

## 4. Arquitectura

### 4.1 Contrato de tipos — `shared/git.ts` (nuevo)

`shared/protocol.ts` se reserva para el WebSocket. Los tipos del panel git van en un módulo aparte
que importan tanto el orquestador como la PWA.

```ts
// ---- Disponibilidad de herramientas -------------------------------------
export interface ToolState {
  ok: boolean;
  version?: string;
  downloadUrl: string;
}
export interface GitTooling {
  git: ToolState;                                   // https://git-scm.com/downloads
  gh: ToolState & { authenticated: boolean; user?: string }; // https://cli.github.com
}

// ---- Descubrimiento de repos --------------------------------------------
export interface GitRepoRef {
  root: string;                        // ruta absoluta al toplevel
  name: string;                        // basename(root)
  kind: 'cwd' | 'child' | 'submodule';
  primary: boolean;                    // el repo que contiene al cwd de la sección
}

// ---- Estado ---------------------------------------------------------------
export type SensitiveLevel = 'none' | 'blocked' | 'warn';

export interface GitFileChange {
  path: string;            // relativa al root
  origPath?: string;       // renombrados
  index: string;           // código X de porcelain v2
  worktree: string;        // código Y
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
  branch: string | null;               // null si detached
  detached: boolean;
  head: string;                        // sha corto
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
  protectedBranch: boolean;            // main | master | develop | production
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
  message?: string;        // stderr real de git, para mostrar tal cual
  detail?: string;
  blocked?: {              // guardia de secretos
    files: string[];
    findings: Array<{ path: string; line: number; rule: string; excerpt: string }>;
  };
}
```

### 4.2 Backend — `orchestrator/git.ts` (nuevo)

**Runner.** `execFile` promisificado (patrón de `projects.ts:4-34`). Nunca `exec` con string, nunca
shell. Todos los paths van tras el separador `--`.

```ts
const BASE_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',      // jamás bloquear pidiendo credenciales
  GIT_OPTIONAL_LOCKS: '0',       // lecturas sin tocar el index.lock del agente
  LC_ALL: 'C',
};
// git siempre con: ['-c', 'core.quotepath=false', ...args]
```

Timeouts: lectura **5 s**, escritura local **20 s**, red (`push`/`pull`/`fetch`/`gh`) **60 s**.
`maxBuffer: 16 MB`. Diffs truncados a **200 KB** con marca `…(truncado)`.

**Allowlist de rutas (obligatorio).** Un `root` recibido del cliente solo se acepta si coincide
**exactamente** (tras `path.resolve` + `fs.realpathSync`) con un root descubierto a partir de:
(a) los `path` de `.projects.json`, (b) los `cwd` de sesiones vivas, (c) los repos hijo encontrados
bajo esas rutas hasta profundidad 2. Comparación por igualdad de string resuelto, **nunca**
`startsWith` (evita `../`). Fallo → `{ ok:false, reason:'not-allowed' }` + HTTP 403.

**Mutex por root.** `Map<string, Promise<void>>` encadenando las operaciones de escritura del mismo
repositorio. Las lecturas no toman el mutex.

**Caché.**
| Dato | TTL | Invalidación |
|---|---|---|
| `tooling` | 5 min | manual |
| `repos` (descubrimiento) | 30 s | manual |
| `status` | 800 ms | cualquier escritura sobre ese root |
| `pr` | 60 s | cualquier `push`/`commit`/creación o merge de PR |

**Descubrimiento multi-repo** (`GET /api/git/repos`):
1. `git rev-parse --show-toplevel` en el `cwd` → si responde, ese es el repo `primary` (`kind:'cwd'`).
2. Escaneo de hijos hasta **profundidad 2** buscando la entrada `.git`. Se saltan `node_modules`,
   `dist*`, `.git`, y cualquier directorio que empiece por `.`. Tope de **50** candidatos.
3. `git submodule status --recursive` sobre el primary → `kind:'submodule'`.
4. Si no hay ninguno → `{ ok:false, reason:'not-a-repo', candidates: [] }`.

**Endpoints** (registrados en `server.ts` **antes** de la línea 37; solo `GET`/`POST`/`OPTIONS`):

| Método | Ruta | Cuerpo / query | Devuelve |
|---|---|---|---|
| GET | `/api/git/tooling` | — | `GitTooling` |
| GET | `/api/git/repos` | `?sectionId=` ó `?cwd=` | `{ ok, cwd, repos: GitRepoRef[] }` |
| GET | `/api/git/status` | `?root=` | `GitStatusResult` |
| GET | `/api/git/diff` | `?root=&path=&staged=0\|1` | `{ ok, patch, truncated }` |
| POST | `/api/git/stage` | `{root, paths[]}` | `GitActionResult` |
| POST | `/api/git/unstage` | `{root, paths[]}` | `GitActionResult` |
| POST | `/api/git/discard` | `{root, paths[], mode:'stash'\|'hard'}` | `GitActionResult` |
| POST | `/api/git/commit` | `{root, message, scope:'staged'\|'all', push?, overrideSecrets?}` | `GitActionResult` |
| POST | `/api/git/push` | `{root, setUpstream?}` | `GitActionResult` |
| POST | `/api/git/pull` | `{root, rebase?}` | `GitActionResult` |
| POST | `/api/git/fetch` | `{root}` | `GitActionResult` |
| POST | `/api/git/undo-commit` | `{root}` | `GitActionResult` |
| POST | `/api/git/ignore` | `{root, paths[]}` | `GitActionResult` |
| POST | `/api/git/init` | `{root}` | `GitActionResult` |
| GET | `/api/git/pr` | `?root=` | `GitPrResult` |
| POST | `/api/git/pr` | `{root, title, body, base?, draft?}` | `GitPrResult` |
| POST | `/api/git/pr/merge` | `{root, number, method, deleteBranch?}` | `GitActionResult` |
| POST | `/api/git/suggest-message` | `{root, routerId?}` | `{ ok, message }` |

**Comandos git exactos**

```
git --version
git rev-parse --show-toplevel
git status --porcelain=v2 --branch --untracked-files=all -z
git diff --numstat -z            /  git diff --cached --numstat -z
git config user.name             /  git config user.email
git remote get-url origin
git stash list
git log -1 --format=%h%x00%s%x00%an%x00%ar
git rev-list --left-right --count HEAD...@{upstream}
git diff -- <path>               /  git diff --cached -- <path>
git add -- <paths>
git restore --staged -- <paths>
git stash push --include-untracked -m "bennzen/discard-<ISO>" -- <paths>
git restore -- <paths>           /  git clean -fd -- <paths>          (modo 'hard')
git commit -m <mensaje>          /  git commit -a -m <mensaje>        (scope 'all')
git push                         /  git push -u origin HEAD
git pull --ff-only               /  git pull --rebase
git fetch --prune
git reset --soft HEAD~1
gh auth status
gh pr view --json number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup,baseRefName,headRefName,author,updatedAt
gh pr create --title <t> --body <b> --base <b>
gh pr merge <n> --squash|--merge|--rebase [--delete-branch]
```

`git push --force` **no se implementa**. `git reset --hard` **no se implementa**.

### 4.3 Guardia de secretos (D8)

**Nivel A — archivo sensible → excluido, nunca se sube.**
Patrones de ruta: `.env`, `.env.*` (salvo `.env.example`), `.routers.json`, `.projects.json`,
`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `*credentials*.json`, `*.keystore`.
Comportamiento: la fila aparece con badge 🔒, **no es seleccionable** para stage/commit, y ofrece
la acción `Añadir a .gitignore` (`POST /api/git/ignore` → escribe en `.gitignore` +
`git rm --cached` si estuviera trackeado). Sin override desde la UI.

**Nivel B — secreto embebido en el contenido → commit bloqueado.**
Escaneo del patch a commitear buscando `sk-ant-`, `sk-[A-Za-z0-9]{20,}`, `gho_`, `ghp_`, `github_pat_`,
`AKIA[0-9A-Z]{16}`, `xoxb-`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`, `AIza[0-9A-Za-z\-_]{35}`.
Devuelve `blocked.findings` con `path:line` y el fragmento enmascarado. La UI muestra el listado y
**bloquea el commit**; se puede forzar con `overrideSecrets:true` únicamente tras un `uiConfirm`
con `danger = true` (contempla falsos positivos: una regex escrita en el propio código).

**Nivel C — aviso blando.** Archivos > 5 MB o con extensión de documento (`.pdf`, `.docx`, `.xlsx`,
`.pptx`) fuera de un directorio de assets declarado. No bloquea; badge de advertencia.

### 4.4 Frontend — `pwa/git.ts` (nuevo módulo)

Precedente: `sections.ts`, `terminal.ts`, `voice.ts`. `main.ts` solo importa y cablea.

```ts
export function initGit(deps: {
  apiBase: string;
  getActiveSection: () => { sectionId: string; cwd: string } | undefined;
  uiConfirm: (msg: string, title?: string, danger?: boolean) => Promise<boolean>;
  uiAlert:   (msg: string, title?: string, icon?: 'info'|'error'|'success') => Promise<void>;
  uiPrompt:  (title: string, def?: string, ph?: string) => Promise<string | null>;
  onBadges: (badges: Map<string, { branch: string; dirty: boolean }>) => void; // cards del sidebar
}): {
  syncActiveSection(): void;      // llamar al final de render()
  notifyActivity(sectionId: string): void;  // desde delta / term-data
  open(): void;
  close(): void;
  isOpen(): boolean;
};
```

**Polling adaptativo (D3)**

| Situación | Intervalo |
|---|---|
| Modal abierto | 4 s |
| Solo widget, actividad reciente del agente (< 30 s) | 6 s |
| Solo widget, en reposo | 20 s |
| `document.hidden` | **pausado** (refresco al volver, en `visibilitychange`) |
| Tras cualquier acción git | inmediato |
| Tras `delta` / `term-data` de la sección activa | debounce 1,5 s |

Persistencia local: `bennzen.git-repo-by-section` → `Record<sectionId, root>` (elección del selector
multi-repo). Se limpia al cerrar la sección, junto al resto de claves en `closeSection`.

---

## 5. UI

### 5.1 Widget del header

`<header>` pasa de `flex: space-between` a `display: grid; grid-template-columns: minmax(0,1fr) auto minmax(0,1fr)`
— `.brand` izquierda, `#git-info` centro, `.header-right` con `justify-self:end`. Sin tocar el
markup existente de brand ni de controles.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ◈ BENNZEN          ● bennzen ▾ · ⎇ master ↑2               ● conectado  ▣ ▤   │
│                      Rzyfront · +46 −8 · 5 arch · PR #12 ✓                     │
└────────────────────────────────────────────────────────────────────────────────┘
```

- Dos líneas de ~11 px, todo con `text-overflow: ellipsis`.
- Punto de estado: limpio / sucio / conflicto / operación en curso (merge, rebase).
- `▾` **solo aparece si hay más de un repo** → despliega el selector (D2).
- Clic en el cuerpo → abre el modal.

**Estados degradados** (D4/D5), todos clicables:

| Estado | Texto | Clic |
|---|---|---|
| Sin sección activa | widget oculto | — |
| `cwd` sin repo y sin candidatos | `sin repositorio git` | abre modal en estado vacío con `git init` |
| `cwd` sin repo pero con hijos | `n repos ▾` | despliega el selector |
| `git` no instalado | `git no instalado ↗` | abre `https://git-scm.com/downloads` |
| `gh` no instalado | (solo afecta a la pestaña PR) | abre `https://cli.github.com` |
| `gh` sin autenticar | `gh sin autenticar` | muestra `gh auth login` con botón de copiar |

### 5.2 Modal `#git-modal`

Esqueleto copiado de `#read-text-modal` (`index.html:612-663`), ancho `.modal-lg`, cuerpo con el
layout de dos columnas de `.routers-body` (`style.css:1318-1344`), filas con `.router-item` +
`.router-tag-badge`, diff en `<pre>` con el estilo de `#log`.

```
┌─ Git · bennzen ▾ ───────────────────────────────────────────────────── ⟳  ✕ ─┐
│  ⎇ master → origin/master   ↑2 ↓0   ·   Rafael Martinez                       │
├────────────────────────────────────┬─────────────────────────────────────────┤
│  SIN PREPARAR                   5  │   [ Diff ]  [ Estado ]  [ PR #12 ]      │
│  ┌──────────────────────────────┐  │  ┌───────────────────────────────────┐  │
│  │ ☐ M  pwa/main.ts    +46 −8 ⋮ │  │  │ @@ -263,7 +263,12 @@              │  │
│  │ ☐ M  orchestrator/pty.ts +5  │  │  │ - const MUTE_STORAGE_KEY = …      │  │
│  │ ☐ ?  spark.png               │  │  │ + const MUTE_MIGRATED_KEY = …     │  │
│  │ 🔒 .env          (excluido)  │  │  └───────────────────────────────────┘  │
│  └──────────────────────────────┘  │   último: b63ea1c "feat: custom …"      │
│  PREPARADO                      0  │   stashes: 0 · sin conflictos            │
│                                    │   [Fetch] [Pull] [Push ↑2] [Deshacer]    │
├────────────────────────────────────┴─────────────────────────────────────────┤
│  ┌──────────────────────────────────────┐  ✨   [ Commit ]  [ Commit + Push ]  │
│  │ mensaje de commit…                   │      ☑ todo                          │
│  └──────────────────────────────────────┘                                      │
└───────────────────────────────────────────────────────────────────────────────┘
```

Acciones por fila (visibles al hover, patrón `.router-item-del`): `▸ preparar`, `↩ quitar`,
`⌫ descartar`, `🚫 ignorar` (solo nivel A).

Pestaña **PR**: si hay PR → número, título, checks, review, mergeable, `Merge (squash|merge|rebase)`,
`Abrir en GitHub`. Si no hay → `Crear PR` con título y cuerpo prellenados desde los commits por
subir. Si el remote no es GitHub → la pestaña no se renderiza.

### 5.3 Badge en las cards del sidebar

Cada `.card` gana una línea `⎇ rama ●` (punto si está sucia), alimentada por `onBadges`. Reutiliza
`.card-sub`/`.card-path`. Se apaga en secciones sin repo.

---

## 6. Fases

> Ninguna fase tiene skill que la respalde: **`[Sin skill — knowledge gap]`**. La F6 cierra el hueco.

### F0 · Contrato + núcleo de lectura backend
**Archivos**: `shared/git.ts` (nuevo), `orchestrator/git.ts` (nuevo), `orchestrator/server.ts` (registro antes de la línea 37).
**Contenido**: tipos completos, runner seguro, allowlist, mutex, caché, descubrimiento multi-repo,
`GET /api/git/tooling|repos|status|diff`.
**Aceptación**: `npm run typecheck` exit 0; `curl` a los cuatro GET devuelve JSON correcto para
bennzen, para un proyecto de `.projects.json` y para un directorio sin repo; una ruta fuera del
allowlist devuelve 403.

### F1 · Widget del header (solo lectura)
**Archivos**: `pwa/index.html`, `pwa/style.css`, `pwa/git.ts` (nuevo), `pwa/main.ts` (import + cableado).
**Contenido**: header a grid, widget de dos líneas, selector multi-repo, estados degradados D4/D5,
polling adaptativo D3.
**Aceptación**: el widget refleja la sección activa; cambiar de sección lo cambia; al editar un
archivo desde un agente, el contador se actualiza en < 3 s; con la pestaña oculta no hay peticiones.

### F2 · Modal en dos columnas (lectura)
**Archivos**: `pwa/index.html`, `pwa/style.css`, `pwa/git.ts`, `pwa/main.ts` (cadena de Escape).
**Contenido**: lista de archivos agrupada, diff coloreado, pestaña Estado, estado vacío D4.
**Aceptación**: abre desde el widget; cierra por ✕, Cancelar, backdrop y Escape sin romper la
prioridad existente de la cadena.

### F3 · Acciones de escritura + guardias
**Archivos**: `orchestrator/git.ts`, `pwa/git.ts`, `pwa/style.css`.
**Contenido**: `stage`/`unstage`/`discard`(D6)/`commit`/`push`/`pull`/`fetch`/`undo-commit`/`ignore`/`init`,
guardia de secretos D8 (A/B/C), aviso de rama protegida, stderr real en el modal.
**Aceptación**: commit selectivo funciona; descartar deja un stash `bennzen/discard-*` recuperable;
intentar preparar `.env` es imposible desde la UI; un token pegado en un archivo bloquea el commit
con `path:line`; push a `master` exige confirmación.

### F4 · Pull requests con `gh`
**Archivos**: `orchestrator/git.ts`, `pwa/git.ts`, `pwa/index.html`, `pwa/style.css`.
**Contenido**: `GET/POST /api/git/pr`, `POST /api/git/pr/merge`, caché 60 s, detección de remote
GitHub, estados `no-gh` / `gh-unauthenticated` con enlace de descarga D5.
**Aceptación**: con PR abierto se ve número/checks/review y el merge funciona; sin `gh` el enlace
abre `https://cli.github.com`; en un repo con remote no-GitHub la pestaña no aparece.

### F5 · Extras
**Archivos**: `orchestrator/git.ts`, `pwa/git.ts`, `pwa/main.ts`, `pwa/style.css`.
**Contenido**: ✨ mensaje de commit vía routers (D7), badge git en las cards, resumen del estado por
voz reutilizando el pipeline TTS, deshacer último commit local.
**Aceptación**: ✨ produce un Conventional Commit a partir del diff preparado usando el router
seleccionado; el badge de cada card muestra la rama correcta de su propio repo.

### F6 · Skill `bennzen-git-panel`
**Archivo**: `.claude/skills/bennzen-git-panel/SKILL.md`.
**Contenido**: contrato de `/api/git/*`, allowlist, mutex, TTL de cachés, guardas destructivas,
modelo de refresco reactivo, comandos git permitidos y los prohibidos (`push --force`, `reset --hard`).

---

## 7. Ejecución delegada

Contrato primero: **F0 entrega `shared/git.ts` antes que nada**; a partir de ahí dos carriles en
paralelo.

- **Carril A (backend)**: F0 → F3-backend → F4-backend → F5-backend
- **Carril B (frontend)**: F1 → F2 → F3-frontend → F4-frontend → F5-frontend
- **Serie**: F6 al final.

Cada sub-agente debe ejecutar `npm run typecheck` y confirmar **exit 0** antes de reportar. El
orquestador verifica el output y hace smoke test antes de pasar de fase.

---

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| `git push` cuelga pidiendo credenciales | `GIT_TERMINAL_PROMPT=0` + timeout 60 s |
| Colisión con el `index.lock` del agente | `GIT_OPTIONAL_LOCKS=0` en lecturas; mutex en escrituras; reintento único ante `index.lock` |
| Hooks de husky que fallan en el commit | stderr crudo devuelto y mostrado en el modal, sin reinterpretar |
| Escaneo multi-repo lento en árboles grandes | profundidad 2, exclusiones, tope 50, caché 30 s |
| Diff enorme | truncado a 200 KB + aviso |
| Rutas con acentos mal escapadas | `-c core.quotepath=false` + `-z` |
| Traversal por `root` manipulado | allowlist con igualdad exacta sobre `realpath`, nunca `startsWith` |
| Secretos publicados | guardia D8 de tres niveles |
