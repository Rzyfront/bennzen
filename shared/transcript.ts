// Reductor y formateo del historial. Compartido por orquestador y PWA para
// que el transcript persistido y el que se ve en vivo sean idénticos (sin drift).
import type { Delta, TranscriptEntry } from './protocol';

/** Aplica un delta de streaming al historial (mutando el arreglo). */
export function applyDelta(entries: TranscriptEntry[], delta: Delta): void {
  switch (delta.type) {
    case 'text': {
      const last = entries[entries.length - 1];
      // Acumula los deltas de texto consecutivos en una sola línea del agente.
      if (last && last.role === 'agent') last.text += delta.text;
      else entries.push({ role: 'agent', text: delta.text });
      break;
    }
    case 'tool':
      entries.push({ role: 'tool', text: delta.name });
      break;
    case 'error':
      entries.push({ role: 'error', text: delta.message });
      break;
    case 'done':
      break;
  }
}

export function pushUser(entries: TranscriptEntry[], text: string): void {
  entries.push({ role: 'user', text });
}

export function pushSystem(entries: TranscriptEntry[], text: string): void {
  entries.push({ role: 'system', text });
}

const PREFIX: Record<TranscriptEntry['role'], string> = {
  user: '🗣 ',
  agent: '🤖 ',
  tool: '🔧 ',
  error: '⚠️ ',
  system: '— ',
};

/** Renderiza una entrada a la línea de texto que se muestra en el log. */
export function formatEntry(e: TranscriptEntry): string {
  if (e.role === 'system') return `— ${e.text} —`;
  return PREFIX[e.role] + e.text;
}
