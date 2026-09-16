# Plan: Espacios — agrupar secciones por proyecto de trabajo

## Goal

Permitir agrupar secciones en **espacios** (nombre provisional) para no ver todas las secciones juntas: filtrar la lista por espacio activo, crear secciones dentro del espacio actual, mover secciones entre espacios por arrastre, y persistir espacios + configuración de secciones en `localStorage` para restaurar disposición y agentes tras cierres o reinicios del orquestador. Todo sin cambios en backend ni protocolo. Incluir la capa de comunicación/UX necesaria (avisos, estados vacíos, indicadores agregados) para que el filtrado nunca oculte información importante al usuario.

## Success Criteria

1. El usuario crea, renombra y elimina espacios; cada espacio muestra solo sus secciones.
2. Sin espacios creados, la app se comporta como hoy (vista "Todas").
3. Crear una sección dentro de un espacio la asigna a ese espacio; el modal permite elegir destino.
4. Arrastrar una card a otro espacio la mueve; reordenar dentro del espacio persiste por espacio.
5. Tras matar y reiniciar el orquestador, un botón "Restaurar N sesiones" recrea las secciones con su agente/modo/tipo/cwd/título/mute/espacio (sesiones frescas, sin historial — comunicado en UI).
6. Cerrar una sección con ✕ nunca la resucita la restauración.
7. Las secciones que hablan o tienen actividad git en espacios no visibles siguen siendo perceptibles (indicadores agregados en el rail).
8. `npm run typecheck` en verde; sin regresiones en badges git, mute, títulos, colapso del sidebar ni modal de nueva sección.

## Context And Current Facts

- Fuente de verdad de sesiones: orquestador **en memoria** (`orchestrator/sessions.ts` `SessionRegistry`, `orchestrator/pty.ts` `PtyRegistry`); al conectar envía `snapshot` completo (`orchestrator/server.ts:107-115`). Refresh de PWA = restaura; reinicio de orquestador = pierde todo.
- PWA: `sections: Map` + un único `activeId` (`pwa/main.ts:188-189`); `render()` repinta toda la lista (`pwa/main.ts:2323+`); orden global en `bennzen.section-order` vía `getOrderedSections()` (`pwa/main.ts:592-604`); DnD de reorden ya implementado (`pwa/main.ts:2508-2567`).
- Persistencia local existente (patrón a seguir): títulos (`bennzen.section-titles`), orden, mute por sección, perfiles (`bennzen.profiles.v1`), config de voz, colapso del sidebar (`bennzen.sidebar-left-collapsed`).
- Creación: `createSection()` (`pwa/main.ts:1404-1426`) genera ID en cliente, inserta optimista y llama `bridge.create`; perfiles rápidos usan el mismo camino (`pwa/main.ts:1517`).
- Cierre: `closeSection()` (`pwa/main.ts:1542+`) purga título/mute/orden; el prune por snapshot (`pwa/main.ts:666-676`) elimina de UI las ausentes en servidor.
- Sidebar: 250px colapsable (`pwa/style.css:434-450`); lista `#sections` (`pwa/index.html:52`); modal de nueva sección en 2 columnas con `ns-project` (cwd), `ns-create`, `profiles-list` (`pwa/index.html:120-237`).
- **Colisión de nombre**: "Proyectos" ya existe = carpetas cwd en `.projects.json` consumidas vía `/api/projects` (`orchestrator/projects.ts`, `pwa/main.ts:1017-1089`).
- Git: `applyGitBadges()` parchea `#sections .card` in place (`pwa/main.ts:197-214`); `getAllSections()` alimenta el barrido de badges (`pwa/main.ts:238`); skill `bennzen-git-panel` vigente.
- Comunicación actual: diálogos `uiAlert/uiConfirm/uiPrompt` (`pwa/main.ts:57-186`), línea `vhint`, `statusEl` de conexión. **No existe toast/banner** (búsqueda en `pwa/` sin resultados).
- Sin suite de tests PWA (`package.json` sin script `test`); validación = `typecheck` + smoke scripts de orquestador + checks manuales.

## Constraints And Non-goals

- Cero cambios en `orchestrator/*`, `shared/*` y protocolo WS. Toda la funcionalidad es PWA + `localStorage`.
- La restauración recrea sesiones **frescas**: historial rpc y scrollback pty no son recuperables (limitación física, debe comunicarse).
- No sincronización entre navegadores/dispositivos; `localStorage` es por navegador.
- No-go v1: espacios anidados, arrastrar entre pestañas, guardar espacio dentro de perfiles, auto-restauración silenciosa, deshacer (undo) de borrado de espacio, migración de "Proyectos" (cwd) al nuevo concepto.

## Key Decisions

| # | Decisión | Recomendación | Alternativa rechazada y por qué |
|---|----------|---------------|---------------------------------|
| 1 | Nombre del concepto | **Espacios** | "Proyectos" colisiona con carpetas cwd en la misma pantalla; "Grupos" es válido pero menos distintivo. |
| 2 | Layout | **Rail vertical de espacios dentro del sidebar izquierdo** (rail ~56px + lista) | Tabs superiores: el header está ocupado (git-center + toggles) y roban altura al terminal; no escalan con 6+ espacios. |
| 3 | Secciones sin espacio | Visibles **solo en "Todas"** | Mostrarlas en todos los espacios duplica y confunde el conteo. |
| 4 | Orden | **Por espacio**, con migración one-time desde `bennzen.section-order` (la clave legacy se conserva para downgrade) | Orden global filtrado: el reorden entre espacios produce resultados sorprendentes. |
| 5 | IDs al restaurar | **Reutilizar el mismo `sectionId`** guardado | IDs nuevos romperían títulos/mute/`bennzen.git-repo-by-section`; reutilizar es seguro porque el servidor ya olvidó esos IDs (solo se restauran IDs ausentes del snapshot). |
| 6 | Disparador de restauración | **Botón manual** "Restaurar N sesiones" (banner persistente) | Auto-restaurar sorprende: spawnea procesos PTY reales sin consentimiento; se deja como opt-in futuro. |
| 7 | Invariante de purga | `closeSection()` purga la config guardada; el prune por snapshot **no** la purga | Sin esta distinción, o resucitan secciones cerradas a propósito, o la restauración es imposible. |
| 8 | Comunicación | **Banner inline en sidebar** (persistente, accionable) + **toast mínimo transitorio** (nuevo, ~60 líneas) + estados vacíos + dots agregados en rail | Reutilizar solo `uiAlert` bloquearía con modales cada acción; `vhint` es efímero y fácil de perder. |

## Recommended Approach

**Modelo de datos (`localStorage`, versionado, siguiendo el patrón una-clave-por-concepto):**
- `bennzen.spaces.v1`: `Space[]` (`{id, name, createdAt}`).
- `bennzen.active-space.v1`: `spaceId | 'all'` (default `'all'`).
- `bennzen.section-space.v1`: `Record<sectionId, spaceId>` (ausente = sin espacio).
- `bennzen.section-config.v1`: `Record<sectionId, {agent, mode, kind, cwd, cols?, rows?}>` — se escribe en `createSection()` y se refresca con cada snapshot; se purga **solo** en `closeSection()`.
- `bennzen.section-order.v1`: `Record<'all'|spaceId|'unassigned', string[]>`; migración one-time desde `bennzen.section-order` → bucket `unassigned`.
- `bennzen.space-active.v1`: `Record<spaceId|'all', sectionId>` (última sección activa por vista).

**UI:** el `aside#sidebar-left` (250px → ~300px) se divide en rail vertical (`#spaces-rail`: botón "Todas" + espacios + "+") y la columna de lista existente. Cada item del rail muestra inicial del nombre, badge de conteo y dots agregados (hablando/sucio-git) para no perder conciencia de espacios no visibles. La lista filtra por `getVisibleSections()` (nuevo selector sobre `getOrderedSections()` + membresía). Botón de restaurar como banner sobre la lista cuando hay restaurables.

**DnD:** se conserva el reorder entre cards (persistiendo en el bucket del espacio visible) y se añade drop sobre items del rail = mover de espacio; drop sobre "Todas" = quitar del espacio (pasar a sin-espacio).

**Creación:** `createSection()` asigna el espacio activo (si no es `'all'`); el modal añade select "Espacio destino" (default = activo); los perfiles rápidos heredan el espacio activo al usar el mismo camino.

**Restauración:** tras cada snapshot, `restorable = configs guardadas − IDs vivos`. Si no vacío → banner "Restaurar N sesiones" con nota "se recrean frescas, sin historial". Al confirmar: recrear `UiSection` local (título/mute/espacio desde storage), `bridge.create` con el **mismo ID** (+ `cols/rows` guardados en pty; `TermView` solo para la que quede activa, el resto usa el patrón `pendingScrollback` existente), `setCapture` según `ttsClean`, progreso en el propio banner ("Restaurando 2/5…").

**Comunicación/UX (v1):** toast mínimo bottom-right auto-dismiss 3.5s para acciones de espacios ("Espacio «X» creado", "Sección movida a «Y»", "Espacio eliminado — sus N secciones pasaron a Todas"); estado vacío por espacio con zona de drop ("Vacío — arrastra secciones aquí o crea una nueva"); `uiConfirm`/`uiPrompt` existentes para eliminar/renombrar con copy final en español (ver Fase 5); atajos `Alt+1..9` para cambiar de vista con tooltips; `aria-label`s en rail; hint one-time descartable si el usuario tiene >3 secciones al estrenar la versión.

## Work Plan

Orden secuencial (cada fase depende de la anterior). Publicación: **una sola unidad** (rama/PR único); las fases son orden de construcción, no splits de commit. Ejecución con delegación a sub-agentes: un implementador por fase + revisión del orquestador antes de avanzar.

**Fase 0 — Cierre de decisiones (sin código).** Skills: — (producto).
- Confirmar las 8 decisiones / responder Open Questions. Criterio: decisiones cerradas por escrito.

**Fase 1 — Modelo de datos + migración.** Skills: `[Sin skill — knowledge gap: secciones/UI]`.
- Nuevo módulo `pwa/spaces.ts`: tipos `Space`, load/persist por clave, `getSpaceOf()`, `setSpaceOf()`, migración one-time de orden legacy, `getRestorableIds(vivos)`.
- Invariante purga: `closeSection()` purga `section-config` + membresía; prune por snapshot no purga (añadir comentario + test manual).
- `createSection()` y handler `snapshot` escriben/actualizan `section-config` (incl. `cols/rows` pty).
- Criterio: recargar con datos legacy migra sin pérdida; cerrar con ✕ purga; matar orch no purga.

**Fase 2 — Rail de espacios + filtrado.** Skills: `bennzen-git-panel` (no romper `applyGitBadges`/`getAllSections`), `[Sin skill — knowledge gap: secciones/UI]`.
- `index.html`: estructura `#spaces-rail` en sidebar; `style.css`: sidebar ~300px, rail, badges, dots, banner, estado vacío, tooltips; colapso intacto.
- `main.ts`: `getVisibleSections()`, render del rail con conteos + dots agregados (speaking desde `sectionVoices`, git desde `gitBadges`), CRUD de espacios (`uiPrompt`/`uiConfirm`), `space-active` por vista, listener evento `storage` para re-render multi-pestaña.
- Invariante git: `getAllSections()` sigue devolviendo **todas** (barrido), el filtro solo afecta a la lista visible.
- Criterio: filtrado correcto; badges git se actualizan también en secciones ocultas al volver a la vista; colapso funciona; dos pestañas se re-sincronizan al cambiar espacios.

**Fase 3 — DnD mover + destino al crear.** Skills: `[Sin skill — knowledge gap: secciones/UI]`.
- Drop sobre item de rail = mover (highlight `drag-over`); drop sobre "Todas" = desasignar; reorder entre cards persiste en bucket del espacio visible.
- Modal: select "Espacio destino" en `ns-left` (default = vista activa); `createSection()` firma + `spaceId?`; perfiles heredan activo.
- Criterio: mover/desasignar/reordenar persisten tras recarga; crear desde modal y desde perfil cae en el espacio esperado.

**Fase 4 — Restauración post-cierre.** Skills: `[Sin skill — knowledge gap: secciones/UI]`.
- Banner "Restaurar N sesiones" + nota de sesiones frescas; flujo de recreación con mismo ID (rpc directo; pty con `cols/rows` guardados + `mountTerm` solo para la activa + `setCapture`); progreso en banner; reintento por fallo individual sin abortar el resto.
- Criterio: matar orch → banner con N correcto → restaurar recrea N sesiones vivas con título/mute/espacio/orden; fallo de una (cwd inválido) no bloquea las demás y se comunica cuál.

**Fase 5 — Comunicación y UX.** Skills: `[Sin skill — knowledge gap: secciones/UI]`.
- Toast mínimo (`pwa/toast.ts` + estilos): `toast(msg)`, auto-dismiss 3.5s, apilado máx. 3, sin dependencias.
- Copy final ES (diálogos, banner, vacíos, tooltips), atajos `Alt+1..9`, `aria-label`s, foco inicial del select destino, hint one-time `bennzen.spaces-hint-dismissed`.
- Criterio: cada acción de espacios da feedback visible <100ms; sin modales salvo renombrar/eliminar; navegación por teclado completa del rail.

**Fase 6 — Verificación y pulido.** Skills: `bennzen-git-panel` (regresión badges), `[Sin skill — knowledge gap]`.
- `npm run typecheck`, matrices manuales del Validation Plan, revisión de copy, limpieza de TODOs.
- Criterio: todos los checks en verde.

## Validation Plan

- **Comandos**: `npm run typecheck` (cada fase); orquestador aislado `PORT=4321 npx tsx orchestrator/server.ts` + PWA contra él para pruebas destructivas sin tocar la sesión real.
- **Fase 1**: (a) con orden legacy, cargar → bucket `unassigned` conserva el orden; (b) cerrar ✕ → claves purgadas (inspeccionar `localStorage`); (c) matar orch → snapshot vacío → configs intactas.
- **Fase 2**: (a) crear 2 espacios + membresía de prueba → filtrado y conteos correctos; (b) actividad git en sección oculta → dot en rail + badge correcto al volver; (c) colapsar sidebar; (d) 2 pestañas: crear espacio en una → aparece en la otra.
- **Fase 3**: (a) drag card→rail mueve y persiste tras `location.reload()`; (b) drag→"Todas" desasigna; (c) reorder dentro de espacio no altera otros; (d) crear desde modal con destino ≠ activo; (e) crear desde perfil en espacio activo.
- **Fase 4 (mayor riesgo — validación crítica)**: 3 rpc + 2 pty distribuidas en 2 espacios → `kill -9` orch → banner "Restaurar 5 sesiones" → restaurar → 5 sesiones vivas, títulos/mute/espacios/orden intactos, pty con geometría; probar con un cwd inválido → error comunicado + resto OK.
- **Fase 5**: checklist de copy (sin tecnicismos, sin inglés mezclado), `Alt+1..9`, `aria-label`s, toast apilado.
- Evidencia esperada: typecheck verde + checklist manual firmada por fase (capturas opcionales del banner/toast/rail).

## Risks / Rollback

- **Resurrección indebida**: mitigado por invariante Fase 1 + validación 1(b). Riesgo residual bajo.
- **Colisión de `sectionId` al restaurar**: mitigado (solo IDs ausentes del snapshot). Residual despreciable.
- **Tormenta de spawns pty** (N terminales a la vez): restauración secuencial con pequeña pausa; N habitual <10. Residual bajo.
- **Divergencia multi-pestaña**: mitigado con evento `storage`; última escritura gana (aceptable v1).
- **Regresión badges git en filtrado**: mitigado por invariante `getAllSections()` + validación 2(b).
- **Rollback**: seguro por construcción — claves nuevas versionadas, clave de orden legacy conservada (downgrade = la app vieja ignora las nuevas y sigue usando la legacy). Sin cambios de servidor, no hay migración que revertir. Rollback = desplegar versión anterior + (opcional) limpiar claves `bennzen.spaces*/section-config*/section-space*`.

## Open Questions

1. **Nombre**: ¿Espacios (recomendado), Grupos u otro? (Afecta copy + nombre de archivo del plan; reversible.)
2. **Layout**: ¿rail vertical izquierdo (recomendado) o tabs superiores? (Afecta Fase 2; el modelo de datos no cambia.)
3. **Restauración**: ¿botón manual (recomendado v1) o auto-restaurar al detectar pérdida? (Afecta Fase 4; auto queda como follow-up opt-in.)
4. Supuesto que desbloquea el resto: se asume Espacios + rail + manual salvo respuesta contraria; el plan es ejecutable con cualquiera de las alternativas sin cambiar fases.

## Skills

| Sección del plan | Skills |
|---|---|
| Fase 0 | — (decisiones de producto) |
| Fase 1, 3, 4, 5 | `[Sin skill — knowledge gap: secciones/UI]` → candidato a nuevo skill si el patrón se repite |
| Fase 2, 6 (render filtrado, badges) | `bennzen-git-panel` (invocado: protege `applyGitBadges`/`getAllSections`) |
| Voz/mute en restauración | `bennzen-voice-pipeline` **no aplica**: no se tocan `pwa/voice.ts` ni archivos de voz del orquestador; el mute vive en `main.ts` y se conserva vía reutilización de IDs |
