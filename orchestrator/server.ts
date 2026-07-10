import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionRegistry } from './sessions';
import { PtyRegistry } from './pty';
import { handleVoiceHttp } from './voice-proxy';
import { applyDelta, pushUser } from '../shared/transcript';
import type { ClientMsg, ServerMsg } from '../shared/protocol';

// Carga opcional del .env (claves de voz). Si no existe, no pasa nada: la PWA
// cae a la voz nativa del navegador.
try {
  process.loadEnvFile('.env');
} catch {
  // .env ausente — modo solo-navegador.
}

const PORT = Number(process.env.PORT ?? 4319);
// Dónde vive la app (Vite). Si abres el orquestador en el navegador, te rebota allí.
const PWA_URL = process.env.PWA_URL ?? 'http://localhost:5180';

const registry = new SessionRegistry();

// El proxy de voz vive en el mismo servidor HTTP que el WS (mismo origen → sin
// CORS para la PWA). Las rutas /api/* las atiende el proxy. Este proceso es
// backend (API + WebSocket): NO sirve la app. Un GET de navegador a otra ruta
// se redirige a la PWA para evitar el "Not Found" seco.
const httpServer = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    void handleVoiceHttp(req, res);
    return;
  }
  // Petición de navegador (acepta HTML) → redirige a la app.
  if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
    res.writeHead(302, { Location: PWA_URL });
    res.end();
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`BENNZEN — orquestador (API + WebSocket). La app está en ${PWA_URL}`);
});

const wss = new WebSocketServer({ server: httpServer });

// PTY: la salida cruda y la prosa extraída se difunden a TODOS los clientes
// (igual que el snapshot) para que cualquier pestaña conectada siga la sesión.
const ptyRegistry = new PtyRegistry({
  onData: (id, data) => broadcast({ t: 'term-data', sectionId: id, data }),
  onSpeak: (id, text) => broadcast({ t: 'speak', sectionId: id, text }),
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[orch] Puerto ${PORT} ocupado — ¿ya hay un orquestador corriendo?\n` +
        `       Libéralo (lsof -ti:${PORT} | xargs kill) o usa otro: PORT=4320 npm run orchestrator`,
    );
    process.exit(1);
  }
  console.error('[orch] error del servidor:', err.message);
  process.exit(1);
});

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Envía un mensaje a todos los clientes WS abiertos. */
function broadcast(msg: ServerMsg): void {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

/** Estado COMPLETO (rpc + pty) a todos los clientes (nada se pierde). */
function broadcastSnapshot(): void {
  broadcast({ t: 'snapshot', sessions: [...registry.list(), ...ptyRegistry.list()] });
}

wss.on('connection', (ws) => {
  console.log('[orch] cliente conectado → enviando snapshot');
  // Al (re)conectar (incl. tras refresh) la app recibe TODAS las sesiones vivas.
  send(ws, { t: 'snapshot', sessions: [...registry.list(), ...ptyRegistry.list()] });

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      send(ws, { t: 'error', message: 'JSON inválido' });
      return;
    }
    void handle(ws, msg);
  });

  // Refresh / cierre de pestaña: NO se tocan las sesiones; persisten en el
  // orquestador y se reenvían al reconectar. Solo el ✕ (o SIGTERM) las cierra.
  ws.on('close', () => console.log('[orch] cliente desconectado (sesiones preservadas)'));
});

async function handle(ws: WebSocket, msg: ClientMsg): Promise<void> {
  try {
    switch (msg.t) {
      case 'create': {
        if (msg.kind === 'pty') {
          ptyRegistry.create(msg.sectionId, msg.agent, msg.mode, msg.cwd, msg.cols, msg.rows);
          console.log(`[orch] sección pty ${msg.sectionId} → ${msg.agent} (${msg.mode})`);
          send(ws, {
            t: 'created',
            sectionId: msg.sectionId,
            agentSessionId: msg.sectionId,
            agent: msg.agent,
            kind: 'pty',
          });
          broadcastSnapshot();
          return;
        }
        const section = await registry.create(msg.sectionId, msg.agent, msg.mode, msg.cwd);
        console.log(`[orch] sección ${section.sectionId} → ${section.agent} (${section.mode})`);
        send(ws, {
          t: 'created',
          sectionId: section.sectionId,
          agentSessionId: section.agentSessionId,
          agent: section.agent,
          kind: 'rpc',
        });
        broadcastSnapshot();
        return;
      }
      case 'say': {
        if (ptyRegistry.has(msg.sectionId)) {
          send(ws, {
            t: 'error',
            sectionId: msg.sectionId,
            message: 'Sección pty: usa term-input',
          });
          return;
        }
        const section = registry.get(msg.sectionId);
        if (!section) {
          send(ws, { t: 'error', sectionId: msg.sectionId, message: 'Sección inexistente' });
          return;
        }
        pushUser(section.transcript, msg.text);
        for await (const delta of section.adapter.send(section.agentSessionId, msg.text)) {
          applyDelta(section.transcript, delta); // persiste el historial server-side
          send(ws, { t: 'delta', sectionId: msg.sectionId, delta });
        }
        return;
      }
      case 'term-input': {
        ptyRegistry.write(msg.sectionId, msg.data);
        return;
      }
      case 'term-resize': {
        ptyRegistry.resize(msg.sectionId, msg.cols, msg.rows);
        return;
      }
      case 'close': {
        if (ptyRegistry.has(msg.sectionId)) {
          await ptyRegistry.close(msg.sectionId);
        } else {
          await registry.close(msg.sectionId);
        }
        console.log(`[orch] sección ${msg.sectionId} cerrada (agente liberado)`);
        broadcastSnapshot();
        return;
      }
      default: {
        const _exhaustive: never = msg;
        send(ws, { t: 'error', message: `Mensaje desconocido: ${JSON.stringify(_exhaustive)}` });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const sectionId = 'sectionId' in msg ? msg.sectionId : undefined;
    console.error('[orch] error:', message);
    send(ws, { t: 'error', sectionId, message });
  }
}

httpServer.listen(PORT, () => {
  console.log(`[orch] WebSocket + voz HTTP escuchando en http://localhost:${PORT}`);
});

// Apagado limpio: cierra sesiones y mata procesos de agentes (sin huérfanos).
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[orch] ${signal} → cerrando sesiones y agentes…`);
  await registry.shutdownAll();
  await ptyRegistry.shutdownAll();
  wss.close();
  httpServer.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
