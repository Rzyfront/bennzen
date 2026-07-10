// Prueba del modelo snapshot/persistencia (sin tembladera, nada se pierde).
// Verifica:
//   1. create + say  → el transcript se persiste server-side.
//   2. reconexión    → el cliente nuevo recibe la sesión COMPLETA por snapshot.
//   3. close (✕)     → snapshot queda vacío (agente liberado, sin huérfanos).
//
// Corre contra un orquestador en PORT=4321 (aislado del dev del usuario).
import { WebSocket } from 'ws';

const URL = 'ws://localhost:4321';
const SECTION = 'snap-1';
const TIMEOUT_MS = 15000;
const fail = (m) => { console.error(`FAIL ❌ ${m}`); process.exit(1); };
const timer = setTimeout(() => fail(`timeout ${TIMEOUT_MS}ms`), TIMEOUT_MS);

const once = (ws, pred) =>
  new Promise((res) => {
    const h = (raw) => {
      const m = JSON.parse(raw.toString());
      if (pred(m)) { ws.off('message', h); res(m); }
    };
    ws.on('message', h);
  });

// Conecta reintentando: el orquestador (tsx) tarda en compilar/levantar el WS.
const open = (url, retries = 100) =>
  new Promise((res, rej) => {
    const attempt = (left) => {
      const ws = new WebSocket(url);
      ws.on('open', () => res(ws));
      ws.on('error', () => {
        if (left <= 0) return rej(new Error(`no conecta a ${url}`));
        setTimeout(() => attempt(left - 1), 100);
      });
    };
    attempt(retries);
  });

// --- Cliente A: crea sesión y manda un mensaje --------------------------------
const a = await open(URL);
await once(a, (m) => m.t === 'snapshot'); // snapshot inicial (vacío)
a.send(JSON.stringify({ t: 'create', sectionId: SECTION, agent: 'mock', mode: 'yolo', cwd: '.' }));
await once(a, (m) => m.t === 'created' && m.sectionId === SECTION);

a.send(JSON.stringify({ t: 'say', sectionId: SECTION, text: 'hola persistencia' }));
await once(a, (m) => m.t === 'delta' && m.delta.type === 'done');
a.close();
console.log('[A] sesión creada + turno completo, desconecta (simula cerrar pestaña)');

// --- Cliente B: reconecta y debe recibir la sesión COMPLETA -------------------
const b = await open(URL);
const snap = await once(b, (m) => m.t === 'snapshot');
const sess = snap.sessions.find((s) => s.sectionId === SECTION);
if (!sess) fail('snapshot sin la sesión tras reconexión (¡se perdió!)');
if (!sess.transcript.some((e) => e.role === 'user' && e.text === 'hola persistencia'))
  fail('transcript no preservó el mensaje del usuario');
if (!sess.transcript.some((e) => e.role === 'agent' && e.text.length > 0))
  fail('transcript no preservó la respuesta del agente');
console.log(`[B] snapshot restauró sesión con ${sess.transcript.length} entradas ✅`);

// --- Cierre explícito (✕): la sesión desaparece del snapshot ------------------
b.send(JSON.stringify({ t: 'close', sectionId: SECTION }));
const after = await once(b, (m) => m.t === 'snapshot');
if (after.sessions.some((s) => s.sectionId === SECTION)) fail('close no eliminó la sesión');
console.log('[B] tras ✕ el snapshot quedó vacío (agente liberado) ✅');

clearTimeout(timer);
b.close();
console.log('PASS ✅ snapshot/persistencia OK');
process.exit(0);
