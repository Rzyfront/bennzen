// Proxy HTTP de voz (STT/TTS por API), montado en el mismo servidor que el WS.
//
// FUENTE DE VERDAD: la config del cliente (localStorage → modal de la PWA), que
// llega en cabeceras `x-voice-*` por petición. Si no vienen cabeceras, se usa el
// `.env` del orquestador como FALLBACK. Así el navegador habla solo con este
// proxy local (sin CORS de proveedores externos como OpenAI) y las keys pueden
// vivir en el navegador (uso local) o en el server.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFileSync } from 'node:fs';

// [DIAG] escribe el diagnóstico de cleanup a un archivo que el asistente puede leer.
// Quitar (junto con las llamadas dclog) cuando la limpieza funcione.
const DIAG_FILE = '/tmp/bennzen-cleanup-diag.log';
function dclog(...parts: unknown[]): void {
  try {
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    appendFileSync(DIAG_FILE, line + '\n');
  } catch {
    /* no romper el flujo por el log */
  }
}

const OPENAI_BASE = 'https://api.openai.com/v1';
const OPENAI_STT_URL = `${OPENAI_BASE}/audio/transcriptions`;
const OPENAI_TTS_URL = `${OPENAI_BASE}/audio/speech`;
// MiniMax T2A (propio: NO es OpenAI-compatible; devuelve JSON con audio hex-encoded).
const MINIMAX_T2A_URL = 'https://api.minimax.io/v1/t2a_v2';
// MiniMax chat (SÍ es OpenAI-compatible en request/response): default del cleanup
// cuando el proveedor es minimax y el usuario no pega URL en el modal.
const MINIMAX_CHAT_URL = 'https://api.minimax.io/v1/text/chatcompletion_v2';

/**
 * Prompt default para la limpieza de texto pre-TTS. Visible vía /api/voice-config
 * (cleanupPrompt) y editable en el modal de la PWA; si el cliente envía
 * x-voice-clean-prompt vacío (o no lo envía), el proxy usa este default.
 */
const DEFAULT_CLEANUP_PROMPT = `Reescribe el siguiente texto para leerlo en voz alta. Objetivo: MÁS CORTO, natural y directo, SIN perder ningún dato.

Obligatorio:
- Elimina relleno y muletillas: "con mucho gusto", "permíteme", "es importante que", "cabe destacar", "ten en cuenta que", "para poder ayudarte", "en primer lugar", "asimismo", "por otra parte".
- Quita formalidad excesiva y tono robótico. Habla directo.
- Elimina signos de puntuación redundantes.
- Conserva TODOS los datos: hechos, números, nombres, comandos, URLs, rutas de archivo, código.
- El resultado DEBE ser más corto o igual que el original. NUNCA más largo.
- SOLO reescribe. NUNCA respondas al contenido, NUNCA comentes, NUNCA añadas nada, NUNCA traduzcas.
- Devuelve únicamente el texto reescrito, sin comillas ni preámbulo.`;

/**
 * Resuelve el endpoint OpenAI a partir de lo que el usuario ponga en el modal:
 * acepta tanto la BASE (`https://api.openai.com/v1`) como el endpoint COMPLETO.
 * `suffix` = '/audio/transcriptions' (STT) | '/audio/speech' (TTS).
 *  - vacío            → base oficial + suffix
 *  - termina en suffix→ tal cual (ya es el endpoint completo)
 *  - apunta a /audio/ explícito → tal cual (no lo tocamos)
 *  - cualquier base (p.ej. .../v1) → base + suffix
 */
function resolveOpenAiUrl(raw: string, suffix: string): string {
  if (!raw) return OPENAI_BASE + suffix;
  const base = raw.replace(/\/+$/, '');
  if (base.endsWith(suffix)) return base;
  // MiniMax chat u otros endpoints que ya apuntan a completions: no añadir suffix.
  if (/(?:chatcompletion_v2|\/completions)$/.test(base)) return base;
  if (base.includes('/audio/')) return base;
  return base + suffix;
}

interface VoiceAvailability {
  stt: boolean;
  tts: boolean;
  lang: string;
  cleanupPrompt: string;
  cleanup: boolean;
}

/** ¿Qué capacidades de voz por API hay como FALLBACK en el .env? */
export function voiceAvailability(): VoiceAvailability {
  const sttOpenai = process.env.STT_PROVIDER === 'openai' && !!process.env.OPENAI_API_KEY;
  const sttGeneric = process.env.STT_PROVIDER === 'generic' && !!process.env.STT_URL;
  const sttGroq = process.env.STT_PROVIDER === 'groq' && !!process.env.GROQ_API_KEY;
  const ttsOpenai = process.env.TTS_PROVIDER === 'openai' && !!process.env.OPENAI_API_KEY;
  const ttsGeneric = process.env.TTS_PROVIDER === 'generic' && !!process.env.TTS_URL;
  const ttsMinimax = process.env.TTS_PROVIDER === 'minimax' && !!(process.env.MINIMAX_API_KEY || process.env.MINI_AUTH_TOKEN);
  return {
    stt: sttOpenai || sttGeneric || sttGroq,
    tts: ttsOpenai || ttsGeneric || ttsMinimax,
    lang: process.env.VOICE_LANG ?? 'es-ES',
    cleanupPrompt: process.env.CLEANUP_PROMPT ?? DEFAULT_CLEANUP_PROMPT,
    cleanup: !!(process.env.CLEANUP_API_KEY && process.env.CLEANUP_MODEL),
  };
}

type Format = 'openai' | 'generic';

/** Normaliza el formato del cliente: 'groq' es OpenAI-compatible → 'openai'. */
function normalizeSttFormat(raw: string | undefined): Format | undefined {
  if (!raw) return undefined;
  if (raw === 'groq') return 'openai';
  if (raw === 'openai' || raw === 'generic') return raw;
  return undefined; // formato desconocido → ignora (cae a fallback .env)
}

/** Formato TTS: como Format pero con 'minimax' (propio, no OpenAI-compatible). */
type TtsFormat = Format | 'minimax';

/** Valida el formato TTS del cliente (no normaliza minimax: tiene su propio handler). */
function normalizeTtsFormat(raw: string | undefined): TtsFormat | undefined {
  if (!raw) return undefined;
  if (raw === 'minimax') return 'minimax';
  if (raw === 'openai' || raw === 'generic') return raw;
  return undefined; // formato desconocido → ignora (cae a fallback .env)
}

/** Lee el cuerpo completo de la petición a un Buffer. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Cabeceras CORS — la PWA (5180) y el proxy (4319) son orígenes distintos. */
function corsHeaders(req: IncomingMessage): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // Eco de las cabeceras pedidas (incluye nuestras x-voice-*) o comodín.
    'Access-Control-Allow-Headers':
      (req.headers['access-control-request-headers'] as string) ?? '*',
  };
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req) });
  res.end(JSON.stringify(body));
}

/** Una sola cabecera (node las da en minúscula; puede venir como array). */
function hdr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

/** Velocidad de habla válida (0.25–4.0) o undefined si no aplica / es 1. */
function parseSpeed(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 1) return undefined;
  return Math.min(4, Math.max(0.25, n));
}

/**
 * Modelos OpenAI TTS que aceptan el parámetro `speed`. SOLO tts-1 y tts-1-hd.
 * gpt-4o-mini-tts (y otros) devuelven 400 si se les manda `speed` → enviarlo
 * rompería la síntesis. Para esos modelos se omite (el audio sale a 1x).
 */
function modelSupportsSpeed(model: string): boolean {
  return model === 'tts-1' || model === 'tts-1-hd';
}

/** 'Header: value' → ['Header', 'value']; null si está mal formado. */
function parseAuthHeader(raw: string | undefined): [string, string] | null {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx < 0) return null;
  const name = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  return name && value ? [name, value] : null;
}

/** Extensión de archivo para el multipart de OpenAI según el content-type. */
function audioFilename(contentType: string): string {
  if (contentType.includes('ogg')) return 'audio.ogg';
  if (contentType.includes('mp4') || contentType.includes('m4a')) return 'audio.mp4';
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'audio.mp3';
  if (contentType.includes('wav')) return 'audio.wav';
  return 'audio.webm';
}

/** Router HTTP del proxy de voz. Solo maneja rutas /api/*. */
export async function handleVoiceHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const url = req.url ?? '';
  try {
    if (req.method === 'GET' && url.startsWith('/api/voice-config')) {
      sendJson(req, res, 200, voiceAvailability());
      return;
    }
    if (req.method === 'POST' && url.startsWith('/api/stt')) {
      await handleStt(req, res);
      return;
    }
    if (req.method === 'POST' && url.startsWith('/api/tts')) {
      await handleTts(req, res);
      return;
    }
    sendJson(req, res, 404, { error: 'Ruta de voz desconocida' });
  } catch (err) {
    sendJson(req, res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ---- STT -----------------------------------------------------------------

async function handleStt(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const audio = await readBody(req);
  const contentType = req.headers['content-type'] ?? 'audio/webm';
  const clientFormat = normalizeSttFormat(hdr(req, 'x-voice-format'));

  if (clientFormat) {
    // Config del cliente (localStorage / modal).
    const key = hdr(req, 'x-voice-key');
    const model = hdr(req, 'x-voice-model') ?? 'whisper-1';
    const rawUrl = hdr(req, 'x-voice-url');
    // OpenAI: completa la ruta si dieron solo la base (.../v1). Genérico: literal.
    const url =
      clientFormat === 'openai'
        ? resolveOpenAiUrl(rawUrl ?? '', '/audio/transcriptions')
        : (rawUrl ?? '');
    const auth = key ? (['Authorization', `Bearer ${key}`] as [string, string]) : null;
    await doStt(req, res, clientFormat, url, model, auth, audio, contentType);
    return;
  }

  // Fallback .env
  const provider = process.env.STT_PROVIDER as (Format | 'groq') | undefined;
  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    const auth: [string, string] = ['Authorization', `Bearer ${process.env.OPENAI_API_KEY}`];
    await doStt(req, res, 'openai', OPENAI_STT_URL, process.env.STT_MODEL ?? 'whisper-1', auth, audio, contentType);
    return;
  }
  // Groq es OpenAI-compatible: mismo flujo que openai pero con su base/key/modelo.
  if (provider === 'groq' && process.env.GROQ_API_KEY) {
    const auth: [string, string] = ['Authorization', `Bearer ${process.env.GROQ_API_KEY}`];
    const url = resolveOpenAiUrl(process.env.GROQ_STT_URL ?? 'https://api.groq.com/openai/v1', '/audio/transcriptions');
    await doStt(req, res, 'openai', url, process.env.STT_MODEL ?? 'whisper-large-v3-turbo', auth, audio, contentType);
    return;
  }
  if (provider === 'generic' && process.env.STT_URL) {
    await doStt(req, res, 'generic', process.env.STT_URL, '', parseAuthHeader(process.env.STT_AUTH_HEADER), audio, contentType);
    return;
  }
  sendJson(req, res, 503, { error: 'STT no configurado (ni en el modal ni en .env)' });
}

async function doStt(
  req: IncomingMessage,
  res: ServerResponse,
  format: Format,
  url: string,
  model: string,
  auth: [string, string] | null,
  audio: Buffer,
  contentType: string,
): Promise<void> {
  if (format === 'openai') {
    if (!auth) return sendJson(req, res, 503, { error: 'STT openai: falta API key' });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: contentType }), audioFilename(contentType));
    form.append('model', model);
    const upstream = await fetch(url, { method: 'POST', headers: { [auth[0]]: auth[1] }, body: form });
    if (!upstream.ok) return sendJson(req, res, 502, { error: `STT openai falló (${upstream.status}): ${(await upstream.text()).slice(0, 300)}` });
    const json = (await upstream.json()) as { text?: string };
    sendJson(req, res, 200, { text: json.text ?? '' });
    return;
  }
  // generic
  if (!url) return sendJson(req, res, 503, { error: 'STT genérico: falta endpoint (URL)' });
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (auth) headers[auth[0]] = auth[1];
  const upstream = await fetch(url, { method: 'POST', headers, body: new Uint8Array(audio) });
  if (!upstream.ok) return sendJson(req, res, 502, { error: `STT genérico falló (${upstream.status})` });
  const json = (await upstream.json()) as { text?: string };
  sendJson(req, res, 200, { text: json.text ?? '' });
}

// ---- TTS -----------------------------------------------------------------

/**
 * Limpia/compacta el texto del agente con un LLM OpenAI-compatible antes del TTS.
 * Patrón de doTts/doStt: fetch + Bearer. `url` acepta base (.../v1) o endpoint
 * completo (/chat/completions) — resolveOpenAiUrl se encarga. Si el LLM cae o
 * responde sin contenido, lanza (el llamador usa el texto original como fallback).
 */
async function doCleanup(
  text: string,
  url: string,
  key: string,
  model: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const endpoint = resolveOpenAiUrl(url, '/chat/completions');
  dclog('  doCleanup | endpoint-resuelto=', endpoint, '| model=', model, '| prompt.len=', prompt.length);
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: text },
      ],
      temperature: 0,
    }),
    signal,
  });
  if (!upstream.ok) {
    throw new Error(`cleanup LLM falló (${upstream.status}): ${(await upstream.text()).slice(0, 300)}`);
  }
  const json = (await upstream.json()) as { choices?: Array<{ message?: { content?: string } }>; base_resp?: { status_code?: number; status_msg?: string } };
  if (json.base_resp && json.base_resp.status_code !== 0) {
    throw new Error(`cleanup LLM (minimax) status ${json.base_resp.status_code}: ${json.base_resp.status_msg ?? ''}`);
  }
  const out = json.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('cleanup LLM: respuesta sin contenido');
  return out;
}

async function handleTts(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: { text?: string; voice?: string };
  try {
    parsed = JSON.parse(raw.toString('utf8') || '{}') as { text?: string; voice?: string };
  } catch {
    return sendJson(req, res, 400, { error: 'JSON inválido' });
  }
  let text = parsed.text;
  if (!text) return sendJson(req, res, 400, { error: 'Falta el campo text' });

  // --- Limpieza de texto opcional (cleanup LLM pre-TTS) ---
  // Si el cliente activa cleanup (x-voice-clean-enabled:'on'), mandamos el texto
  // a un LLM OpenAI-compatible que lo compacta/limpia antes de sintetizar. Si falla,
  // usamos el texto original (no rompemos la voz). Config del cliente por headers
  // con fallback a .env. Reusa resolveOpenAiUrl (soporta base y endpoint completo).
  const cleanEnabled = hdr(req, 'x-voice-clean-enabled') === 'on';
  // [DIAG] logs de diagnóstico de cleanup — quitar cuando la limpieza funcione.
  dclog('--- /api/tts', new Date().toISOString(),
    '| clean-enabled=', hdr(req, 'x-voice-clean-enabled') ?? '(none)',
    '| format=', hdr(req, 'x-voice-clean-format') ?? '(none)',
    '| url=', hdr(req, 'x-voice-clean-url') ?? '(none)',
    '| key=', hdr(req, 'x-voice-clean-key') ? '(set)' : '(empty)',
    '| model=', hdr(req, 'x-voice-clean-model') ?? '(none)',
    '| text.len=', (parsed.text ?? '').length);
  if (cleanEnabled) {
    let cleanUrl = hdr(req, 'x-voice-clean-url') ?? process.env.CLEANUP_URL ?? '';
    let cleanKey = hdr(req, 'x-voice-clean-key') ?? process.env.CLEANUP_API_KEY ?? '';
    const cleanModel = hdr(req, 'x-voice-clean-model') ?? process.env.CLEANUP_MODEL ?? '';
    const cleanFormat = hdr(req, 'x-voice-clean-format') ?? '';
    // MiniMax: si el usuario deja URL o key vacías en el modal, usamos los defaults
    // de MiniMax (endpoint chat OpenAI-compatible + token del .env: MINIMAX_API_KEY
    // o el del proxy `mini`), igual que el TTS minimax. Así "no pongo nada" funciona.
    if (cleanFormat === 'minimax') {
      if (!cleanUrl) cleanUrl = MINIMAX_CHAT_URL;
      if (!cleanKey) cleanKey = process.env.MINIMAX_API_KEY ?? process.env.MINI_AUTH_TOKEN ?? '';
    }
    // Prompt: header del cliente → .env → default del server. Cabecera vacía → default.
    // El cliente codifica el prompt con encodeURIComponent (los headers HTTP no
    // admiten bytes no-ASCII: acentos/ñ harían que fetch() lanzara "Invalid value").
    // Si lo hay, se decodifica aquí; si está vacío o el decode falla, default del server.
    const rawPrompt = hdr(req, 'x-voice-clean-prompt');
    let cleanPrompt = process.env.CLEANUP_PROMPT ?? DEFAULT_CLEANUP_PROMPT;
    if (rawPrompt) {
      try { cleanPrompt = decodeURIComponent(rawPrompt); }
      catch { cleanPrompt = rawPrompt; }
    }
    if (!cleanKey || !cleanModel) {
      return sendJson(req, res, 503, { error: 'Cleanup habilitado pero sin key/modelo configurados (ni en el modal ni en .env)' });
    }
    // Aborta el fetch al LLM si el cliente corta la conexión (barge-in / cierre).
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    dclog('  resolved | url=', cleanUrl, '| model=', cleanModel, '| key=', cleanKey ? '(set)' : '(EMPTY!)');
    try {
      const before = text;
      const cleaned = await doCleanup(text, cleanUrl, cleanKey, cleanModel, cleanPrompt, ac.signal);
      dclog('  OK | before.len=', before.length, '| after.len=', cleaned.length,
        '| after[0..160]=', cleaned.slice(0, 160));
      if (cleaned) {
        text = cleaned;
        // Informa al cliente cuánto compactó (indicador UI). setHeader ANTES del
        // writeHead de la síntesis → persiste. Expose-Headers para que el navegador
        // pueda leerlas con fetch (res.headers.get).
        res.setHeader('x-clean-before', String(before.length));
        res.setHeader('x-clean-after', String(cleaned.length));
        res.setHeader('Access-Control-Expose-Headers', 'x-clean-before, x-clean-after');
      }
    } catch (e) {
      dclog('  FALLÓ, uso texto original | err=', e instanceof Error ? e.message : String(e));
    }
  }

  const clientFormat = normalizeTtsFormat(hdr(req, 'x-voice-format'));
  const headerVoice = hdr(req, 'x-voice-tts-voice');
  const speed = parseSpeed(hdr(req, 'x-voice-speed'));
  const lang = hdr(req, 'x-voice-lang');

  if (clientFormat) {
    const key = hdr(req, 'x-voice-key');
    const rawUrl = hdr(req, 'x-voice-url');
    const auth = key ? (['Authorization', `Bearer ${key}`] as [string, string]) : null;
    // MiniMax tiene su propio handler (response JSON + audio hex-encoded); NO se
    // resuelve con resolveOpenAiUrl (ese es solo openai).
    if (clientFormat === 'minimax') {
      const url = rawUrl ?? MINIMAX_T2A_URL;
      const model = hdr(req, 'x-voice-model') ?? 'speech-2.8-hd';
      const voice = headerVoice ?? parsed.voice ?? 'English_expressive_narrator';
      // Si el cliente no manda key, reusa la del .env (MINIMAX_API_KEY o el token
      // del proxy `mini`). Así el usuario no tiene que pegar el token en el modal:
      // basta con elegir minimax como proveedor y dejar el campo key vacío.
      const mmKey = key || process.env.MINIMAX_API_KEY || process.env.MINI_AUTH_TOKEN;
      const mmAuth = mmKey ? (['Authorization', `Bearer ${mmKey}`] as [string, string]) : null;
      await doMinimaxTts(req, res, url, model, voice, mmAuth, text, speed, lang);
      return;
    }
    // openai / generic
    const model = hdr(req, 'x-voice-model') ?? 'tts-1';
    const voice = headerVoice ?? parsed.voice ?? 'alloy';
    const url =
      clientFormat === 'openai'
        ? resolveOpenAiUrl(rawUrl ?? '', '/audio/speech')
        : (rawUrl ?? '');
    await doTts(req, res, clientFormat, url, model, voice, auth, text, speed);
    return;
  }

  // Fallback .env
  const provider = process.env.TTS_PROVIDER as (Format | 'minimax') | undefined;
  const envSpeed = speed ?? parseSpeed(process.env.TTS_SPEED);
  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    const auth: [string, string] = ['Authorization', `Bearer ${process.env.OPENAI_API_KEY}`];
    const voice = parsed.voice ?? process.env.TTS_VOICE ?? 'alloy';
    await doTts(req, res, 'openai', OPENAI_TTS_URL, process.env.TTS_MODEL ?? 'tts-1', voice, auth, text, envSpeed);
    return;
  }
  if (provider === 'minimax') {
    // MINIMAX_API_KEY es la misma key de MiniMax que usa el proxy `mini`
    // (MINI_AUTH_TOKEN). Si no se setea por separado, reusamos esa.
    const mmKey = process.env.MINIMAX_API_KEY || process.env.MINI_AUTH_TOKEN;
    if (mmKey) {
      const auth: [string, string] = ['Authorization', `Bearer ${mmKey}`];
      const url = process.env.MINIMAX_TTS_URL ?? MINIMAX_T2A_URL;
      const voice = parsed.voice ?? process.env.TTS_VOICE ?? 'English_expressive_narrator';
      const model = process.env.TTS_MODEL ?? 'speech-2.8-hd';
      await doMinimaxTts(req, res, url, model, voice, auth, text, envSpeed, process.env.VOICE_LANG);
      return;
    }
  }
  if (provider === 'generic' && process.env.TTS_URL) {
    await doTts(req, res, 'generic', process.env.TTS_URL, '', parsed.voice ?? '', parseAuthHeader(process.env.TTS_AUTH_HEADER), text, envSpeed);
    return;
  }
  sendJson(req, res, 503, { error: 'TTS no configurado (ni en el modal ni en .env)' });
}

async function doTts(
  req: IncomingMessage,
  res: ServerResponse,
  format: Format,
  url: string,
  model: string,
  voice: string,
  auth: [string, string] | null,
  text: string,
  speed?: number,
): Promise<void> {
  if (format === 'openai') {
    if (!auth) return sendJson(req, res, 503, { error: 'TTS openai: falta API key' });
    const body: Record<string, unknown> = { model, voice, input: text };
    // Solo tts-1/tts-1-hd aceptan `speed`; gpt-4o-mini-tts y otros dan 400.
    if (speed && modelSupportsSpeed(model)) body.speed = speed;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { [auth[0]]: auth[1], 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!upstream.ok) return sendJson(req, res, 502, { error: `TTS openai falló (${upstream.status}): ${(await upstream.text()).slice(0, 300)}` });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', ...corsHeaders(req) });
    res.end(buf);
    return;
  }
  // generic
  if (!url) return sendJson(req, res, 503, { error: 'TTS genérico: falta endpoint (URL)' });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) headers[auth[0]] = auth[1];
  const genericBody: Record<string, unknown> = { text, voice };
  if (speed) genericBody.speed = speed;
  const upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(genericBody) });
  if (!upstream.ok) return sendJson(req, res, 502, { error: `TTS genérico falló (${upstream.status})` });
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') ?? 'audio/mpeg', ...corsHeaders(req) });
  res.end(buf);
}

/**
 * TTS MiniMax T2A: endpoint propio que devuelve JSON con el audio HEX-encoded
 * (NO es OpenAI-compatible). Decodifica el hex a mp3 y lo devuelve como audio/mpeg.
 */
/**
 * Mapea el idioma BCP-47 de bennzen (p.ej. es-ES) al `language_boost` de MiniMax.
 * Las voces HD de MiniMax son multilingües: el `voice_id` fija el timbre, y
 * `language_boost` fuerza la pronunciación en ese idioma. Sin lang conocido → 'auto'
 * (MiniMax autodetecta del texto). MiniMax acepta: Chinese, English, Spanish, auto, …
 */
function langToBoost(lang: string | undefined): string {
  if (!lang) return 'auto';
  const l = lang.toLowerCase();
  if (l.startsWith('es')) return 'Spanish';
  if (l.startsWith('en')) return 'English';
  if (l.startsWith('zh')) return 'Chinese';
  return 'auto';
}

async function doMinimaxTts(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  model: string,
  voice: string,
  auth: [string, string] | null,
  text: string,
  speed?: number,
  lang?: string,
): Promise<void> {
  if (!auth) return sendJson(req, res, 503, { error: 'TTS minimax: falta API key' });
  // MiniMax solo admite speed 0.5–2; bennzen envía 0.25–4 → clamp. undefined → 1.
  const sp = speed === undefined ? 1 : Math.min(2, Math.max(0.5, speed));
  const voiceId = voice || 'English_expressive_narrator';
  const body = {
    model: model || 'speech-2.8-hd',
    text,
    language_boost: langToBoost(lang),
    output_format: 'hex',
    voice_setting: { voice_id: voiceId, speed: sp, vol: 1, pitch: 0 },
    audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
  };
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { [auth[0]]: auth[1], 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!upstream.ok) return sendJson(req, res, 502, { error: `TTS minimax falló (${upstream.status}): ${(await upstream.text()).slice(0, 300)}` });
  const json = (await upstream.json()) as {
    data?: { audio?: string };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  if (json.base_resp?.status_code !== 0) {
    return sendJson(req, res, 502, { error: `TTS minimax: ${json.base_resp?.status_msg ?? 'error desconocido'}` });
  }
  if (!json.data?.audio) return sendJson(req, res, 502, { error: 'TTS minimax: respuesta sin audio' });
  const buf = Buffer.from(json.data.audio, 'hex');
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', ...corsHeaders(req) });
  res.end(buf);
}
