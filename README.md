# BENNZEN

Cliente de voz delgado sobre agentes CLI (**Claude Code / Codex / OpenCode**).
Hablas → STT → el agente elegido procesa → su respuesta vuelve como texto → TTS.

La app **no** gestiona el modelo ni la ejecución de herramientas: eso lo hacen los
CLIs nativamente, incluido el modo de permisos (`yolo` / `safe-auto` / `readonly`),
que se traduce al flag nativo de cada agente.

## Dos modos por sección

| Modo | Qué es | Cómo se habla con el agente |
|------|--------|------------------------------|
| **Texto + Voz** (`rpc`) | Cara programática del CLI (SDK / `exec` / `serve`). Texto limpio → TTS nítido. | Cuadro de texto o voz; respuesta en historial + voz. |
| **Terminal + Voz** (`pty`) | **Un solo proceso**: la TUI real del CLI bajo un PTY. Slash-commands, teclado y colores completos. | xterm.js (teclas) **y** voz dictada (se inyecta al mismo stdin). La prosa del agente se extrae y se habla. |

En modo `pty`, voz y terminal comparten **el mismo proceso vivo**: lo que tecleas y lo
que dictas van al mismo stdin; la salida va a la vez al terminal y (limpiada de ANSI) a TTS.

## Voz intercambiable (navegador o API)

STT y TTS pueden ser **del navegador** (Web Speech / SpeechSynthesis) o **por API**
(p.ej. OpenAI Whisper + TTS). El path `api` pasa por el orquestador (`/api/stt`,
`/api/tts`) → las API keys viven en `.env` del server, nunca en el navegador. Se elige
en el panel de **Ajustes de voz** de la PWA; si el server no tiene proveedor configurado,
el path `api` se deshabilita solo. Ver `.env.example`.

## Arquitectura

```
PWA (navegador)  ──WebSocket──►  Orquestador (Node)  ──►  Adaptadores rpc  ──►  CLIs (SDK/exec/serve)
  voz + UI + xterm   localhost      secciones/sesiones  └─►  PTY (node-pty)  ──►  TUI real del CLI
                     HTTP /api/*  ──►  proxy de voz (STT/TTS por API)
```

- **Sección** = sesión de un agente (`rpc` o `pty`), con su `cwd` y modo de permiso.
- **Adaptador** = implementación del contrato `AgentAdapter` (modo `rpc`).
- **PTY** = la TUI real bajo `node-pty`, derivada a xterm + extractor de prosa (modo `pty`).
- **Snapshot** = el orquestador es fuente de verdad persistente; al refrescar/reconectar
  reenvía todas las sesiones (incluido el scrollback del terminal). Nada se pierde.

## Requisitos

- Node 20+ y npm.
- CLIs instalados y autenticados según el agente que uses: `claude`, `codex`, `opencode`.
- Para voz por API (opcional): copia `.env.example` a `.env` y configura el proveedor.

## Uso

```bash
npm install          # postinstall arregla el bit +x del spawn-helper de node-pty
npm run dev          # orquestador (ws+http://localhost:4319) + PWA (http://localhost:5180)
```

Abre http://localhost:5180 en **Chrome** (Web Speech API para la voz del navegador).
Crea una sección eligiendo **Texto+Voz** o **Terminal+Voz**; usa el agente `mock`
(en `pty` arranca un `bash`) para validar sin depender de los CLIs reales.

> **node-pty**: sus prebuilds a veces pierden el bit de ejecución del `spawn-helper`
> (macOS/Linux) y `pty.spawn` falla con `posix_spawnp failed`. El `postinstall`
> (`scripts/fix-node-pty.mjs`) restaura `+x` automáticamente; es idempotente.

## Estado

- [x] Esqueleto + loop de voz + adaptador `mock` (eco) — verificado
- [x] Adaptadores OpenCode / Claude / Codex (modo `rpc`) — verificados ✅
- [x] Snapshot/persistencia de secciones (rpc + pty) — verificado ✅
- [x] Modo `pty`: TUI real bajo node-pty + extracción de prosa para TTS — verificado ✅
- [x] Voz intercambiable navegador/API (proxy `/api/stt`, `/api/tts`) — verificado ✅
- [ ] Streaming token-a-token en modo rpc (hoy por mensaje/turno)

### Smoke tests (sin navegador)

Con un orquestador en un puerto aislado (para no chocar con tu `npm run dev`):

```bash
PORT=4321 npx tsx orchestrator/server.ts &     # levanta server de prueba
node scripts/smoke.mjs <agent> <mode> "<prompt>" [cwd]   # turno rpc (apunta a 4319 por defecto)
node scripts/snapshot-test.mjs                  # persistencia rpc (puerto 4321)
node scripts/pty-smoke.mjs                       # PTY + proxy de voz (puerto 4321)
```

### Notas de los adaptadores

- **Claude**: el Agent SDK necesita el binario nativo. Si falta, el adaptador
  reutiliza tu `claude` instalado vía `pathToClaudeCodeExecutable` (auto-resuelto
  con `which claude`, o configurable con `CLAUDE_CODE_EXECUTABLE`).
- **Codex**: spawnea `codex exec --json`; el `thread_id` se reutiliza con
  `codex exec resume`. Usa tu provider/modelo configurado en `~/.codex`.
- **OpenCode**: `createOpencode()` lanza un único server; usa el modelo por
  defecto de tu config de OpenCode. `readonly` apaga tools de escritura (best-effort).

## Modos de permiso (passthrough)

| Modo        | Claude Agent SDK            | Codex `exec`                          | OpenCode |
|-------------|-----------------------------|---------------------------------------|----------|
| `yolo`      | `bypassPermissions`         | `-a never --sandbox danger-full-access` | `permission: allow` |
| `safe-auto` | `acceptEdits` + allowedTools | `-a never --sandbox workspace-write`  | ask/allow por tool |
| `readonly`  | `plan`                      | `--sandbox read-only`                 | deny escritura |
