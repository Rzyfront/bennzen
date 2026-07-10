import type { AgentAdapter, CreateSessionOpts, Delta } from './types';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Adaptador de eco: no necesita CLIs ni credenciales. Sirve para validar el
 * loop voz → STT → WS → TTS de punta a punta antes de cablear agentes reales.
 */
export class MockAdapter implements AgentAdapter {
  readonly kind = 'mock' as const;
  private sessions = new Map<string, CreateSessionOpts>();
  private counter = 0;

  async createSession(opts: CreateSessionOpts): Promise<{ sessionId: string }> {
    const sessionId = `mock-${++this.counter}`;
    this.sessions.set(sessionId, opts);
    return { sessionId };
  }

  async *send(sessionId: string, text: string): AsyncIterable<Delta> {
    const opts = this.sessions.get(sessionId);
    yield { type: 'text', text: `Eco [${opts?.mode ?? '?'}] ` };
    // Simula streaming token-a-token para probar el troceo por frase del TTS.
    for (const word of text.split(/\s+/).filter(Boolean)) {
      await delay(70);
      yield { type: 'text', text: word + ' ' };
    }
    yield { type: 'done' };
  }

  async close(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
