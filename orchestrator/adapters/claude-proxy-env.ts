/**
 * Variables de entorno que convierten al binario `claude` en un proxy distinto
 * (cambia el endpoint de la API, el token de auth y el mapeo de modelos).
 *
 * `mini` y `ollima` no son binarios separados: son `claude` + este env. Por eso
 * el adaptador rpc los spawnea con `Options.env` y el modo pty los lanza como
 * `claude` mergeando este env sobre `process.env`. Así se evita cualquier
 * wrapper de shell (`zsh -ic`…) que contaminaría el stdio del SDK.
 *
 * Única fuente de verdad del env de cada proxy; la usan tanto el adaptador rpc
 * como `resolveCommand` (pty).
 */

export type ClaudeProxy = 'mini' | 'ollima';

/** Nombre de la var de entorno (en `.env`, gitignorado) que guarda el token. */
export function proxyTokenEnvVar(proxy: ClaudeProxy): string {
  return proxy === 'mini' ? 'MINI_AUTH_TOKEN' : 'OLLAMA_AUTH_TOKEN';
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
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
          ANTHROPIC_MODEL: 'MiniMax-M3[1m]',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.7-highspeed',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3[1m]',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3[1m]',
        },
      };
    }
    case 'ollima': {
      // Ollama local: token "ollama" y localhost:11434 funcionan sin config.
      // Solo edita .env si tu instancia usa otra URL o auth.
      return {
        env: {
          ANTHROPIC_AUTH_TOKEN: process.env.OLLAMA_AUTH_TOKEN ?? 'ollama',
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_BASE_URL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
          ANTHROPIC_MODEL: 'glm-5.2:cloud',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2:cloud',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro:cloud',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'minimax-m3:cloud',
        },
      };
    }
  }
}