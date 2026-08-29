import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouterConfig, RouterTestResult } from '../shared/protocol';

const ROUTERS_FILE = path.resolve(process.cwd(), '.routers.json');

/**
 * Normaliza un identificador / slug seguro para un router (ej: "DeepSeek V3" -> "deepseek-v3").
 */
export function slugifyRouterId(name: string): string {
  const clean = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || `router-${Date.now().toString(36)}`;
}

/**
 * Carga los routers persistidos desde el archivo local .routers.json.
 */
export function loadRouters(): RouterConfig[] {
  try {
    if (!fs.existsSync(ROUTERS_FILE)) return [];
    const raw = fs.readFileSync(ROUTERS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('[routers] No se pudo leer .routers.json:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Guarda la lista completa de routers en .routers.json.
 */
function persistRouters(list: RouterConfig[]): void {
  try {
    fs.writeFileSync(ROUTERS_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.error('[routers] Error al escribir en .routers.json:', err instanceof Error ? err.message : err);
  }
}

/**
 * Obtiene un router por su ID o prefijo `router:${id}`.
 */
export function getRouter(idOrPrefixed: string): RouterConfig | undefined {
  const cleanId = idOrPrefixed.startsWith('router:') ? idOrPrefixed.slice(7) : idOrPrefixed;
  const routers = loadRouters();
  return routers.find((r) => r.id === cleanId || r.id === idOrPrefixed);
}

/**
 * Guarda o actualiza un router. Si no tiene ID, lo genera a partir del nombre.
 */
export function saveRouter(router: Partial<RouterConfig> & { name: string; baseUrl: string; apiKey: string }): RouterConfig {
  const routers = loadRouters();
  const id = router.id ? slugifyRouterId(router.id) : slugifyRouterId(router.name);
  
  const existingIdx = routers.findIndex((r) => r.id === id);
  const fullRouter: RouterConfig = {
    id,
    name: router.name.trim(),
    baseUrl: router.baseUrl.trim(),
    apiKey: router.apiKey.trim(),
    opusModel: router.opusModel?.trim() || undefined,
    sonnetModel: router.sonnetModel?.trim() || undefined,
    haikuModel: router.haikuModel?.trim() || undefined,
    autoCompactWindow: router.autoCompactWindow?.trim() || '500000',
    createdAt: router.createdAt ?? Date.now(),
  };

  if (existingIdx >= 0) {
    routers[existingIdx] = fullRouter;
  } else {
    routers.push(fullRouter);
  }

  persistRouters(routers);
  return fullRouter;
}

/**
 * Elimina un router por su ID.
 */
export function deleteRouter(id: string): boolean {
  const cleanId = id.startsWith('router:') ? id.slice(7) : id;
  const routers = loadRouters();
  const filtered = routers.filter((r) => r.id !== cleanId && r.id !== id);
  if (filtered.length === routers.length) return false;
  persistRouters(filtered);
  return true;
}

/**
 * Genera el diccionario de variables de entorno para que Claude Code (`claude`)
 * se comunique con el endpoint del router.
 */
export function buildRouterEnv(router: RouterConfig): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: router.baseUrl,
    ANTHROPIC_AUTH_TOKEN: router.apiKey,
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: router.autoCompactWindow || '500000',
  };

  if (router.opusModel) {
    env.ANTHROPIC_MODEL = router.opusModel;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = router.opusModel;
  }
  if (router.sonnetModel) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = router.sonnetModel;
    if (!env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = router.sonnetModel;
  }
  if (router.haikuModel) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = router.haikuModel;
  }

  return env;
}

/**
 * Prueba la conectividad enviando una petición ligera en formato Anthropic Messages (/v1/messages).
 */
export async function testRouter(config: Partial<RouterConfig>): Promise<RouterTestResult> {
  if (!config.baseUrl || !config.apiKey) {
    return { ok: false, error: 'Se requiere Base URL y API Key para probar la conexión.' };
  }

  const cleanBase = config.baseUrl.replace(/\/+$/, '');
  const url = cleanBase.endsWith('/v1') ? `${cleanBase}/messages` : `${cleanBase}/v1/messages`;
  const testModel = config.sonnetModel || config.opusModel || config.haikuModel || 'default';

  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: testModel,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(10000),
    });

    const latencyMs = Math.round(performance.now() - t0);

    if (res.ok) {
      return { ok: true, latencyMs };
    }

    let errorDetail = '';
    try {
      const json = await res.json() as { error?: { message?: string } | string; message?: string };
      if (typeof json.error === 'object' && json.error?.message) {
        errorDetail = json.error.message;
      } else if (typeof json.error === 'string') {
        errorDetail = json.error;
      } else if (json.message) {
        errorDetail = json.message;
      }
    } catch {
      errorDetail = await res.text().catch(() => '');
    }

    return {
      ok: false,
      latencyMs,
      error: `Error HTTP ${res.status} (${res.statusText}): ${errorDetail || 'Respuesta no válida del proveedor'}`,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('aborted') || msg.includes('timeout')) {
      return { ok: false, latencyMs, error: 'Tiempo de espera agotado (timeout de 10s al contactar al endpoint).' };
    }
    return { ok: false, latencyMs, error: `Fallo de conexión de red: ${msg}` };
  }
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin ?? '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-voice-*',
  };
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...corsHeaders(req),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Maneja las rutas HTTP bajo /api/routers. Devuelve true si la ruta fue manejada.
 */
export async function handleRoutersHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return true;
  }

  const url = req.url ?? '';
  const pathname = url.split('?')[0];

  if (req.method === 'GET' && pathname === '/api/routers') {
    sendJson(req, res, 200, loadRouters());
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/routers/test') {
    try {
      const raw = await readBody(req);
      const data = JSON.parse(raw || '{}') as Partial<RouterConfig>;
      const result = await testRouter(data);
      sendJson(req, res, 200, result);
    } catch (err) {
      sendJson(req, res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/routers') {
    try {
      const raw = await readBody(req);
      const data = JSON.parse(raw || '{}') as Partial<RouterConfig> & { name: string; baseUrl: string; apiKey: string };
      if (!data.name || !data.baseUrl || !data.apiKey) {
        sendJson(req, res, 400, { error: 'Campos requeridos: name, baseUrl, apiKey' });
        return true;
      }
      const saved = saveRouter(data);
      sendJson(req, res, 200, saved);
    } catch (err) {
      sendJson(req, res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/routers/')) {
    const id = pathname.slice('/api/routers/'.length);
    if (!id) {
      sendJson(req, res, 400, { error: 'Falta el id del router' });
      return true;
    }
    const ok = deleteRouter(id);
    sendJson(req, res, ok ? 200 : 404, { ok, id });
    return true;
  }

  return false;
}
