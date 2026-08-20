import { execFileSync } from 'node:child_process';

/**
 * El Agent SDK trae un binario nativo opcional que puede faltar tras la
 * instalación. Reusamos el `claude` ya instalado (CLI autenticado del usuario)
 * vía `pathToClaudeCodeExecutable`. Cacheado tras la primera resolución.
 *
 * Compartido por `ClaudeAdapter` y los proxies (`mini`, `qwen`): todos
 * ejecutan el mismo binario `claude`, solo cambian las variables de entorno.
 */
let cachedBin: string | null | undefined;
export function resolveClaudeBin(): string | undefined {
  if (cachedBin !== undefined) return cachedBin ?? undefined;
  const fromEnv = process.env.CLAUDE_CODE_EXECUTABLE;
  if (fromEnv) {
    cachedBin = fromEnv;
    return fromEnv;
  }
  try {
    cachedBin = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || null;
  } catch {
    cachedBin = null;
  }
  return cachedBin ?? undefined;
}