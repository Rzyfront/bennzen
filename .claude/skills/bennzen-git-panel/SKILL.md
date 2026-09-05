---
name: bennzen-git-panel
description: Panel git de bennzen — contrato /api/git/* (18 endpoints), allowlist por igualdad exacta realpath, mutex por root solo escrituras, TTL de cachés e invalidaciones, guardas destructivas (stash recuperable bennzen/discard-*, nunca push --force ni reset --hard), modelo de refresco (polling adaptativo + reactivo + inmediato), comandos permitidos/prohibidos, guardia de secretos A/B/C y ramas protegidas. Invocar ANTES de tocar orchestrator/git.ts, shared/git.ts, pwa/git.ts o el modal/widget git, o al depurar 403, estados obsoletos o commits bloqueados.
---

# bennzen — Panel git

bennzen monta un indicador git en el centro del header y un modal de gestión en dos
columnas, conscientes de que cada sección trabaja sobre un repositorio distinto y de que
los agentes CLI modifican el working tree mientras el usuario mira. Tipos en
`shared/git.ts`, backend en `orchestrator/git.ts`, frontend en `pwa/git.ts`.

## Contrato `/api/git/*` (18 endpoints)

Registrados en `server.ts` **antes** del catch-all `/api/` (línea 37). Solo
`GET`/`POST`/`OPTIONS`; `PUT`/`PATCH`/`DELETE` → **405**.

| Método | Ruta | Cuerpo / query | Respuesta |
|---|---|---|---|
| GET | `/api/git/tooling` | — | `GitTooling` (`git` + `gh` con `authenticated?`, `user?`) |
| GET | `/api/git/repos` | `?sectionId=` ó `?cwd=` | `{ ok, cwd, repos: GitRepoRef[] }` |
| GET | `/api/git/status` | `?root=` | `GitStatusResult` |
| GET | `/api/git/diff` | `?root=&path=&staged=0\|1` | `{ ok, patch, truncated }` |
| POST | `/api/git/stage` | `{root, paths[]}` | `GitActionResult` |
| POST | `/api/git/unstage` | `{root, paths[]}` | `GitActionResult` |
| POST | `/api/git/discard` | `{root, paths[], mode:'stash'\|'hard'}` | `GitActionResult` |
| POST | `/api/git/commit` | `{root, message, scope:'staged'\|'all', push?, overrideSecrets?}` | `GitActionResult` (+`blocked?`) |
| POST | `/api/git/push` | `{root, setUpstream?}` | `GitActionResult` |
| POST | `/api/git/pull` | `{root, rebase?}` | `GitActionResult` |
| POST | `/api/git/fetch` | `{root}` | `GitActionResult` |
| POST | `/api/git/undo-commit` | `{root}` | `GitActionResult` |
| POST | `/api/git/ignore` | `{root, paths[]}` | `GitActionResult` |
| POST | `/api/git/init` | `{root}` (el cwd) | `GitActionResult` |
| GET | `/api/git/pr` | `?root=` | `GitPrResult` |
| POST | `/api/git/pr` | `{root, title, body, base?, draft?}` | `GitPrResult` (PR fresco) |
| POST | `/api/git/pr/merge` | `{root, number, method, deleteBranch?}` | `GitActionResult` |
| POST | `/api/git/suggest-message` | `{root, scope:'staged'\|'all', routerId?}` | `{ ok, message }` |
| POST | `/api/git/speak-summary` | `{root, routerId?}` | `{ ok, message, via:'llm'\|'template' }` |

`GitStatusResult` es unión: `GitStatus` (`ok:true`) o `not-a-repo` (con `candidates`),
`no-gh`, `not-allowed`, `error`. `GitPrResult`: `{ok:true, pr}` o `no-gh` /
`gh-unauthenticated` / `not-github` / `error`. Errores de git devuelven el **stderr
crudo** en `message` para mostrarlo tal cual en el modal.

## Allowlist de rutas (obligatorio)

Un `root` del cliente solo se acepta si coincide **exactamente** (tras `path.resolve` +
`fs.realpathSync`) con un root descubierto desde: (a) los `path` de `.projects.json`,
(b) los `cwd` de sesiones vivas, (c) los repos hijo bajo esas rutas hasta profundidad 2.
Comparación por **igualdad de string resuelto, nunca `startsWith`** (evita `../`).
Fallo → `{ ok:false, reason:'not-allowed' }` + HTTP **403**. Falta `?root=` → **400**.

## Mutex por root (solo escrituras)

`Map<string, Promise<void>>` encadena las operaciones de escritura del mismo repositorio.
Las **lecturas no toman el mutex**. Reintento único ante `index.lock` (colisión con el
agente CLI). Lecturas con `GIT_OPTIONAL_LOCKS=0` para no tocar el lock del agente.

## Cachés: TTL e invalidaciones

| Dato | TTL | Invalidación |
|---|---|---|
| `tooling` | 5 min | manual |
| `repos` (descubrimiento) | 30 s | `init` |
| `status` | 800 ms | cualquier escritura sobre ese root |
| `pr` | 60 s | `push` / `commit` / crear o merge de PR |

## Guardas destructivas

- **Descartar = stash recuperable por defecto**: `git stash push --include-untracked -m
  "bennzen/discard-<ISO>" -- <paths>`. Deja el worktree limpio y el contenido recuperable
  vía `git stash list`.
- **Modo `hard` solo explícito** (Alt+clic + confirmación propia): `git restore -- <paths>`
  + `git clean -fd -- <paths>` sobre paths dados. Nunca por defecto.
- **Prohibidos**: `git push --force` no se implementa; `git reset --hard` no se implementa.
- **Deshacer commit** = `git reset --soft HEAD~1` (conserva los cambios en staged).
- **Ramas protegidas** (`main`, `master`, `develop`, `production`): `status.protectedBranch`
  y el `push` exige confirmación en la UI. La pestaña PR solo se renderiza si
  `remoteHost === 'github'`.

## Modelo de refresco

- **Polling adaptativo**: modal abierto 4 s; solo widget con actividad reciente del agente
  (< 30 s) 6 s; en reposo 20 s; `document.hidden` → pausado (refresco en `visibilitychange`).
- **Reactivo**: `notifyActivity(sectionId)` desde `delta` / `term-data` con debounce 1,5 s.
- **Inmediato** tras cada acción git y al abrir el modal.
- Selección de archivo, tab y formulario PR **persisten entre repintados** del polling y se
  reinician al cambiar de root. Elección multi-repo persistida en
  `bennzen.git-repo-by-section` (se limpia al cerrar la sección). Badges de cards no activas:
  barrido con throttle 15 s, tope 12, respetando `document.hidden`.

## Comandos permitidos y prohibidos

Runner: `execFile` promisificado, **nunca `exec` con string, nunca shell**; todos los paths
tras el separador `--`. Env: `GIT_TERMINAL_PROMPT=0` (jamás pedir credenciales),
`GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`; siempre `-c core.quotepath=false`. Timeouts: lectura
5 s, escritura local 20 s, red (`push`/`pull`/`fetch`/`gh`) 60 s. `maxBuffer` 16 MB. Diffs
truncados a 200 KB con marca `…(truncado)`.

Permitidos (lista cerrada): `git --version`; `rev-parse --show-toplevel`;
`status --porcelain=v2 --branch --untracked-files=all -z`; `diff --numstat -z` y
`diff --cached --numstat -z`; `config user.name|email`; `remote get-url origin`;
`stash list`; `log -1 --format=…`; `rev-list --left-right --count HEAD...@{upstream}`;
`diff [--cached] -- <path>`; `add --`; `restore --staged --`; `stash push
--include-untracked -m "bennzen/discard-<ISO>" --`; `restore --` / `clean -fd --` (hard);
`commit -m` / `commit -a -m` (scope `all` replica `-a` **excluyendo Nivel A**);
`push` / `push -u origin HEAD`; `pull --ff-only` / `pull --rebase`; `fetch --prune`;
`reset --soft HEAD~1`; `gh auth status`;
`gh pr view --json number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup,baseRefName,headRefName,author,updatedAt`;
`gh pr create --title --body [--base] [--draft]`; `gh pr merge <n>
--squash|--merge|--rebase [--delete-branch]`.

Prohibidos: `push --force` (cualquier variante), `reset --hard`, `exec`/shell con strings,
paths sin `--`, `startsWith` para validar rutas.

## Guardia de secretos (D8)

- **Nivel A — archivo sensible → excluido, nunca se sube, sin override desde la UI.**
  Por basename: `.env`, `.env.*` (salvo `.env.example`), `.routers.json`,
  `.projects.json`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `id_rsa*`,
  `*credentials*.json`. Fila con badge 🔒, no seleccionable; acción «añadir a `.gitignore`»
  (`POST /api/git/ignore` → escribe en `.gitignore` + `git rm --cached` si trackeado).
- **Nivel B — secreto embebido → commit bloqueado.** Escaneo del patch a commitear con:
  `sk-ant-[A-Za-z0-9_-]{8,}`, `\bsk-[A-Za-z0-9]{20,}`, `\bgho_[A-Za-z0-9_]{10,}`,
  `\bghp_[A-Za-z0-9_]{10,}`, `\bgithub_pat_[A-Za-z0-9_]{10,}`, `\bAKIA[0-9A-Z]{16}`,
  `\bxoxb-[A-Za-z0-9-]{8,}`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  `\bAIza[0-9A-Za-z\-_]{35}`. Devuelve `blocked.findings` (`path:line` + excerpt con el
  secreto sustituido por `•••`, tope 50). Desbloqueo solo con `overrideSecrets:true` tras
  `uiConfirm` danger (contempla falsos positivos: una regex en el propio código).
- **Nivel C — aviso blando, no bloquea.** > 5 MB o `.pdf`/`.docx`/`.xlsx`/`.pptx` fuera de
  un directorio `assets/` (exento). Badge de advertencia.

## Degradados y ausencias

Sin sección activa → widget oculto. `cwd` sin repo y sin candidatos → `sin repositorio
git` + modal vacío con `git init`. Con hijos → `n repos ▾`. Sin `git` → abre
`https://git-scm.com/downloads`. Sin `gh` → pestaña PR con enlace a
`https://cli.github.com`; sin auth → hint `gh auth login` con botón de copiar. Remote no
GitHub → la pestaña PR no se renderiza. Sin routers → `suggest-message` responde amable.
La apiKey de `suggest-message` vive server-side y el diff enviado al LLM lleva secretos
Nivel B enmascarados y corte a 12 KB.
