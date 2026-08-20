/**
 * Variables de entorno que convierten al binario `claude` en un proxy distinto
 * (cambia el endpoint de la API, el token de auth y el mapeo de modelos).
 *
 * `mini` y `qwen` no son binarios separados: son `claude` + este env. Por eso
 * el adaptador rpc los spawnea con `Options.env` y el modo pty los lanza como
 * `claude` mergeando este env sobre `process.env`. Así se evita cualquier
 * wrapper de shell (`zsh -ic`…) que contaminaría el stdio del SDK.
 *
 * Única fuente de verdad del env de cada proxy; la usan tanto el adaptador rpc
 * como `resolveCommand` (pty).
 */

import { execFileSync } from 'node:child_process';

export type ClaudeProxy = 'mini' | 'qwen';

/** Nombre de la var de entorno (en `.env`, gitignorado) que guarda el token. */
export function proxyTokenEnvVar(proxy: ClaudeProxy): string {
  return proxy === 'mini' ? 'MINI_AUTH_TOKEN' : 'BAILIAN_API_KEY';
}

/** Servicio del llavero de macOS donde vive la key de Bailian (misma que usa `qwen()` en ~/.zshrc). */
const BAILIAN_KEYCHAIN_SERVICE = 'bailian-api';

/**
 * Lee la key de Bailian del Keychain de macOS, igual que la función `qwen()` del
 * `.zshrc`. Se cachea solo el ÉXITO: si aún no está cargada, un reintento tras
 * `security add-generic-password` la encuentra sin reiniciar el orquestador.
 */
let cachedKeychainKey: string | undefined;
function bailianKeyFromKeychain(): string | undefined {
  if (cachedKeychainKey) return cachedKeychainKey;
  try {
    const key = execFileSync(
      'security',
      ['find-generic-password', '-s', BAILIAN_KEYCHAIN_SERVICE, '-w'],
      // timeout: si el llavero está bloqueado, `security` puede quedarse
      // esperando un diálogo de autorización y colgaría el spawn del agente.
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    ).trim();
    if (key) cachedKeychainKey = key;
    return key || undefined;
  } catch {
    // No existe la entrada, o no es macOS: el llamador reporta el error útil.
    return undefined;
  }
}

/**
 * Env del proxy, SIN incluir `process.env`: el llamador lo spread primero
 * (el SDK reemplaza el env del subprocess por completo si `env` viene seteado).
 * Devuelve `undefined` si falta un token obligatorio (caso `mini` sin
 * `MINI_AUTH_TOKEN`), para que el llamador falle con un mensaje claro en lugar
 * de lanzar un proceso que moriría de auth.
 */
export function proxyEnv(proxy: ClaudeProxy): { env: Record<string, string> } | { error: string } {
  switch (proxy) {
    case 'mini': {
      const token = process.env.MINI_AUTH_TOKEN;
      if (!token) {
        return {
          error:
            'Falta MINI_AUTH_TOKEN en .env. El agente `mini` es un proxy de Claude Code hacia MiniMax y necesita su token de auth (el mismo que usa la función `mini()` de tu .zshrc). Cópialo a .env del orquestador.',
        };
      }
      return {
        env: {
          ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
          ANTHROPIC_AUTH_TOKEN: token,
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000',
          ANTHROPIC_MODEL: 'MiniMax-M3[1m]',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.7-highspeed',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3[1m]',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3[1m]',
        },
      };
    }
    case 'qwen': {
      // Qwen vía Alibaba Bailian (endpoint Anthropic-compatible). La key se
      // busca primero en .env y, si no está, en el Keychain de macOS — mismo
      // orden que la función `qwen()` del .zshrc, para no duplicar el secreto.
      const token = process.env.BAILIAN_API_KEY || bailianKeyFromKeychain();
      if (!token) {
        return {
          error:
            'Falta la API key de Bailian. Cárgala en el Keychain con `security add-generic-password -U -s bailian-api -a "$USER" -w \'<sk-...>\'` o pon BAILIAN_API_KEY en el .env del orquestador.',
        };
      }
      // Contexto de 1M POR DEFECTO. Son dos piezas independientes y hacen falta
      // las dos: el sufijo `[1m]` del model id es lo que hace que Claude Code
      // pida la ventana larga (misma convención que `mini` → 'MiniMax-M3[1m]'),
      // y CLAUDE_CODE_AUTO_COMPACT_WINDOW es lo que evita que auto-compacte a
      // los ~200k. Si Bailian rechazara el id con sufijo, BAILIAN_MODEL lo
      // sobreescribe sin tocar código (p.ej. BAILIAN_MODEL=qwen3.8-max).
      const model = process.env.BAILIAN_MODEL ?? 'qwen3.8-max[1m]';
      return {
        env: {
          ANTHROPIC_BASE_URL:
            process.env.BAILIAN_BASE_URL ??
            'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
          ANTHROPIC_AUTH_TOKEN: token,
          ANTHROPIC_API_KEY: '',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000',
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          // El alias `sonnet` (modelo rápido) TAMBIÉN va con `[1m]`: aquí se
          // quiere 1M en todos los alias, no solo en el principal.
          ANTHROPIC_DEFAULT_SONNET_MODEL:
            process.env.BAILIAN_SONNET_MODEL ?? 'deepseek-v4-flash-0731[1m]',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        },
      };
    }
  }
}
