import { createOpencode } from '@opencode-ai/sdk';
import type { OpencodeClient, SessionPromptData } from '@opencode-ai/sdk';
import type { AgentAdapter, CreateSessionOpts, Delta, PermMode } from './types';

type PromptBody = NonNullable<SessionPromptData['body']>;

/**
 * Adaptador OpenCode — modelo servidor.
 * `createOpencode()` lanza un único `opencode serve` y devuelve un cliente HTTP;
 * cada sección es una sesión del servidor. El modo de permiso se aproxima a
 * nivel de prompt: en `readonly` se deshabilitan las tools de escritura.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly kind = 'opencode' as const;
  private clientPromise?: Promise<OpencodeClient>;
  private serverClose?: () => void;
  private modes = new Map<string, PermMode>();
  private dirs = new Map<string, string>();

  private client(): Promise<OpencodeClient> {
    if (!this.clientPromise) {
      this.clientPromise = createOpencode().then((r) => {
        this.serverClose = r.server.close;
        return r.client;
      });
    }
    return this.clientPromise;
  }

  async createSession(opts: CreateSessionOpts): Promise<{ sessionId: string }> {
    const client = await this.client();
    const res = await client.session.create({ body: { title: `voice-${opts.mode}` } });
    const id = res.data?.id;
    if (!id) throw new Error(`OpenCode: no se pudo crear la sesión (${JSON.stringify(res.error)})`);
    this.modes.set(id, opts.mode);
    this.dirs.set(id, opts.cwd);
    return { sessionId: id };
  }

  async *send(sessionId: string, text: string): AsyncIterable<Delta> {
    const client = await this.client();
    const directory = this.dirs.get(sessionId);
    const body: PromptBody = { parts: [{ type: 'text', text }] };
    if (this.modes.get(sessionId) === 'readonly') {
      // Best-effort: apaga tools de mutación (nombres habituales de OpenCode).
      body.tools = { write: false, edit: false, bash: false, patch: false };
    }

    const res = await client.session.prompt({
      path: { id: sessionId },
      body,
      ...(directory ? { query: { directory } } : {}),
    });

    if (res.error) {
      yield { type: 'error', message: `OpenCode: ${JSON.stringify(res.error)}` };
      yield { type: 'done' };
      return;
    }

    for (const part of res.data?.parts ?? []) {
      if (part.type === 'text' && part.text) yield { type: 'text', text: part.text };
      else if (part.type === 'tool') yield { type: 'tool', name: 'tool' };
    }
    yield { type: 'done' };
  }

  async close(sessionId: string): Promise<void> {
    this.modes.delete(sessionId);
    this.dirs.delete(sessionId);
    if (this.clientPromise) {
      try {
        const client = await this.client();
        // Borra la sesión server-side para no dejarla colgada en el `opencode serve`.
        await client.session.delete({ path: { id: sessionId } });
      } catch {
        /* la sesión puede ya no existir */
      }
    }
    // Sin sesiones activas → cerramos el server compartido (evita proceso huérfano).
    if (this.modes.size === 0) await this.shutdown();
  }

  /** Cierra el `opencode serve` compartido al apagar el orquestador. */
  async shutdown(): Promise<void> {
    this.serverClose?.();
    this.serverClose = undefined;
    this.clientPromise = undefined;
  }
}
