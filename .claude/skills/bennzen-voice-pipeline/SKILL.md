---
name: bennzen-voice-pipeline
description: Arquitectura y reglas del sistema de voz (TTS/STT) de bennzen — pipeline de síntesis con prefetch gapless, limpieza LLM desacoplada (/api/clean), segmentador unificado con ramp-up, y cachés LRU. Invocar ANTES de tocar pwa/voice.ts, orchestrator/voice-proxy.ts, orchestrator/tts-cache.ts, orchestrator/clean-cache.ts o orchestrator/tts-extractor.ts, o al depurar latencia/cortes/consumo de tokens de la voz.
---

# bennzen — Pipeline de voz (TTS/STT)

bennzen es un cliente de voz PWA sobre agentes CLI, con un orquestador Node. La voz
tiene dos proveedores intercambiables por sesión: `browser` (Web Speech nativo) y
`api` (síntesis/transcripción vía el orquestador). Este skill cubre la ruta `api`,
que es donde vive toda la optimización.

## Regla de oro de configuración

**El `.env` del orquestador NO trae proveedores de voz** (voice-config devuelve
`stt:false, tts:false`). TODA la config de voz llega del **modal de la PWA**
(localStorage) como cabeceras `x-voice-*` por petición. Consecuencia: para probar
cualquier cosa hay que configurar proveedor + key en el modal; sin eso el proxy
responde 503. Fallback a `.env` solo si el modal no manda cabeceras.

## Arquitectura de 4 etapas

```
[Fuente]            [Segmentador]           [Limpiador (opc, ON)]   [Sintetizador]        [Reproductor]
rpc deltas / pty →  acumula + concatena  →  /api/clean (bloques) →  /api/tts (caché LRU) → cola gapless
  speak()           segmentText():           1 LLM por BLOQUE        hash(text+params)     prefetch FIFO
                    frase>cláusula>          + caché de resultado    sirve blob si hit     lookahead=3
                    espacio>duro; ramp-up     re-segmenta lo LIMPIO
                                              por frase → TTS
```

- **OFF (limpieza apagada):** Segmentador → Sintetizador(caché). Sin etapa de limpieza.
- **ON (limpieza encendida):** Segmentador(bloques grandes) → `/api/clean` → re-segmenta
  el texto limpio por frase → Sintetizador(caché).

Un solo motor de tiempos/segmentación; los parámetros cambian por modo. Esto rompe el
trade-off "progresivo = más llamadas LLM": se limpia en bloques grandes (pocas llamadas,
buen contexto) y se sintetiza por frases del texto ya limpio (fluido y cacheable).

## Archivos y responsabilidades

| Archivo | Responsabilidad |
|---------|-----------------|
| `pwa/voice.ts` | Capa de voz cliente: `ApiTts` (pipeline TTS + etapa de limpieza), `startApiStt`, `segmentText`, `BrowserTts`, `MicMeter`. |
| `orchestrator/voice-proxy.ts` | Router `/api/*`: `handleStt`, `handleTts`, `handleClean`, `doCleanup`, `resolveCleanupConfig`. Reenvía al proveedor con fallback `.env`. |
| `orchestrator/tts-cache.ts` | Caché LRU en memoria de audio TTS (Buffer). |
| `orchestrator/clean-cache.ts` | Caché LRU en memoria de texto limpio (string). |
| `orchestrator/tts-extractor.ts` | `TerminalExtractor`: extrae prosa del PTY (debounce 500ms, dedup por línea). |
| `orchestrator/server.ts` | Enruta `/api/*` → `handleVoiceHttp`. WS para el resto. |
| `pwa/main.ts` | `wireTtsState`: mapea `onStateChange`/`onLevel`/`onCleaning` al orbe. |

## Segmentador unificado — `segmentText(buf, target, force, emit): string`

Función PURA exportada (testeable). Extrae del `buf` cuantos segmentos hablables pueda,
cortando en el **MEJOR límite disponible**: fin de frase `.!?` > cláusula `,;:` > espacio
> corte duro. Emite cada segmento con `emit` y **devuelve el remanente no emitido**.

- Una frase completa que quepa (`≤ target*1.4`) se emite entera (natural, progresivo).
- Si el buf excede `target` sin cerrar frase (prosa de captura total sin puntuación),
  corta por cláusula/espacio dentro de la ventana (no espera).
- `force=true` (fin de turno/flush): emite también el remanente corto sin cierre.
- **Guard de vacío** (`hasWord`): nunca emite segmentos sin letra/número (puntuación o
  glifos sueltos se retienen en el remanente; no se hablan).
- `firstSentenceEnd` exige espacio/fin tras `.!?` → no parte decimales (`3.14`) ni siglas.

`chunkSentences` (viejo, solo frases `.!?`) SE MANTIENE porque `BrowserTts` aún lo usa.

## Ramp-up y tamaños objetivo (`ApiTts.targetLen()`)

Primer segmento del turno pequeño (primer audio rápido); crece con `segCount` (menos
llamadas y mejor prosodia después). `segCount++` ocurre en `emitSegment` (cuenta
bloques/segmentos por turno), se resetea en `stop()`.

| Modo | primero | cap | paso/segmento |
|------|---------|-----|---------------|
| OFF (TTS directo) | 60 | 240 | +80 |
| ON (bloque a limpiar) | 160 | 900 | +240 |
| ON (frase del limpio → TTS) | fijo `CLEAN_SENTENCE_TARGET=220`, `force` | — | — |

## Tiempos de flush (debounce con techo) — SOLO modo ON

`flush(immediate=false)` con `ttsClean.enabled` y `!immediate` → debounce doble:
- `settleTimer` (`CLEAN_SETTLE_MS=1000`): se REPROGRAMA en cada fragmento → dispara al
  fin de una ráfaga.
- `maxTimer` (`CLEAN_MAX_INTERVAL_MS=3000`): se arma UNA vez con contenido pendiente y
  NO se reprograma → garantiza síntesis cada ~3s aunque el stream no pare. **Mata el bug
  histórico "solo habla al final"** (el debounce clásico se reiniciaba sin fin).

`immediate=true` (el `done` de rpc = fin de turno real) salta el debounce. En **modo OFF
no hay debounce**: `flush()` es inmediato (OFF nunca tuvo el problema). Los valores
"recomendados" del plan (OFF 700/2500) son objetivos de la Fase 6 (configurables), aún
no implementados.

## Pipeline TTS con prefetch gapless (`ApiTts`)

- Cola `jobs: AudioJob[]` ORDENADA (FIFO). Fetch (síntesis) y reproducción DESACOPLADOS.
- `pumpPrefetch()`: arranca fetches de jobs `pending` en orden hasta `lookahead=3` en
  vuelo/listos por delante del cabezal (acota RAM; el orden de red lo absorbe el array).
- `pumpPlayback()`: consume `jobs[0]` uno a uno (mutex `playing`); `await job.blobPromise`
  resuelve al instante si ya se prefetcheó → sin hueco de red. Un `<audio>` nuevo por
  trozo (`createMediaElementSource` solo 1 vez por elemento).
- **Cancelación por generación**: `stop()` hace `gen++`, aborta todos los `controller`,
  vacía colas. Tras cada `await` se chequea `myGen !== this.gen` → descarta trabajo viejo.
  Es la guarda LÓGICA principal; abortar es el complemento para cortar la red.

## Etapa de limpieza (modo ON) — worker secuencial ordenado

- `cleanQueue: CleanJob[]` + mutex `cleanBusy`. `enqueueClean(bloque)` desde `emitSegment`.
- `pumpClean()`: procesa el cabezal de UNO EN UNO (en orden), `fetch /api/clean` con
  `cleanHeaders`, y con la respuesta re-segmenta por frase (`emitCleanSentences` →
  `enqueue` al pipeline TTS). Mismas guardas por generación que `pumpPlayback`.
- Si `/api/clean` falla → habla el ORIGINAL (no se pierde información).
- **UX de limpieza** (`onCleaning 'start'/'done'`) atada a ESTE fetch, no al TTS.
- `notify()` incluye `cleanBusy || cleanQueue.length` → el orbe no se apaga en el hueco
  entre fin del stream y llegada del audio limpio.

## Contratos HTTP

### POST /api/tts  (TTS puro — NO recibe cabeceras de limpieza desde Fase 2)
- Body `{ text, voice? }`. Cabeceras `x-voice-*` (format/url/key/model/tts-voice/speed/lang).
- Formatos: `openai`, `generic`, `minimax` (JSON+audio hex, handler propio). `groq`→openai.
- Respuesta: audio binario. Cabecera `x-tts-cache: hit|miss`.

### POST /api/clean  (limpieza LLM desacoplada)
- Body `{ text }`. Cabeceras `x-voice-clean-*` (format/url/key/model/prompt).
- Respuesta JSON `{ clean, before, after, cached?, fallback? }`. Cabecera `x-clean-cache: hit|miss|error`.
- Si el LLM falla → 200 con `{ clean: <original>, fallback: true }`.
- `resolveCleanupConfig(req)` resuelve config (headers→.env, defaults MiniMax, decode prompt);
  compartida con la limpieza acoplada de `/api/tts` (que queda solo como COMPAT/FALLBACK).

### POST /api/stt
- Body: audio binario (`audio/webm;codecs=opus`, ~24kbps mono). Cabeceras `x-voice-*`.
- Guards cliente: descarta si `< MIN_TALK_MS=350` o `blob < MIN_BLOB_BYTES=1500`.

## Cachés

- **tts-cache** (audio): LRU 200 entradas / 64MB. Key = `sha1(['tts'|'minimax', format/model, voice, speed, (lang minimax), text])`.
- **clean-cache** (texto): LRU 500 entradas / ~4M chars. Key = `ttsCacheKey(['clean', model, prompt, text])`.
- Ambos: `Map` por orden de inserción; `get` re-inserta al final; evict del más viejo.
- **Prompt caching** (tokens): `doCleanup` manda el system prompt como PREFIJO ESTABLE
  byte-idéntico (`messages[0]`) + user variable, `temperature:0`. MiniMax auto-cachea
  prefijos ≥512 tok (~66% ahorro; prompt default ~800 tok). OpenAI exige ≥1024 tok → no
  cachea con este prompt (usar MiniMax, o engordar el prefijo). **INVARIANTE: no anteponer
  nada variable al system ni fusionarlo con el user**, o se rompe el prefijo cacheable.

## Gotchas (aprendidos a la mala)

- **`tsx watch` NO hace type-check**: transpila y arranca; un `ReferenceError` en runtime
  NO bloquea el arranque. Correr SIEMPRE `npm run typecheck` (exit 0) antes de confiar.
  Una regresión de llamadas huérfanas a `dclog()` tumbó TODO el TTS (pty y rpc) sin que el
  server fallara al arrancar.
- **Cabeceras HTTP no admiten no-ASCII**: el prompt de limpieza (acentos/ñ) viaja con
  `encodeURIComponent` (cliente) y se decodifica con `decodeURIComponent` (server). Sin
  esto `fetch()` lanza "Invalid value" → silencio total.
- **`mini`/`qwen` son `claude` + env** (proxies de Claude Code), no binarios; MiniMax
  usa `MINI_AUTH_TOKEN` como fallback de key para TTS y limpieza minimax. `qwen` apunta a
  Alibaba Bailian y lee su key de `BAILIAN_API_KEY` o del Keychain (`bailian-api`).
- Puertos: orquestador 4319 (`tsx watch orchestrator/server.ts`), PWA Vite 5180.

## Verificación mínima al tocar la voz

1. `npm run typecheck` → exit 0.
2. Smoke del proxy (puerto de prueba): `/api/voice-config` 200; `/api/clean` y `/api/tts`
   503 sin config; `/api/clean` con JSON inválido 400. Log sin `ReferenceError`.
3. Si tocas la reproducción o la segmentación: prueba REAL en navegador (ON y OFF) — el
   audio y el gapless NO se pueden verificar headless. Comprobar: primer audio rápido,
   flujo sin cortes, orbe "limpiando"→"hablando", barge-in corta limpio, Network muestra
   `/api/clean` por bloques + `/api/tts` por frases con `x-tts-cache`.

## Estado del plan de optimización

Núcleo COMPLETO: Fase 0 (higiene), 1 (caché audio), 3 (segmentador unificado), 2
(desacople `/api/clean`), 4 (prompt caching). Pendientes: Fase 5 (dedup semántico en
`tts-extractor.ts` — normalizar líneas volátiles antes del dedup por línea), Fase 6
(knobs en el modal + métricas cache-hit/tokens/latencia), Fase 7 (STT: un solo
`getUserMedia` compartido MicMeter+MediaRecorder, VAD, streaming).
