// Smoke test del modo PTY + proxy de voz (puerto aislado 4321).
// Verifica:
//   1. GET /api/voice-config responde (sin .env → stt/tts false).
//   2. create kind:'pty' (agent mock = bash) → la TUI/شell arranca.
//   3. term-input 'echo <marca>\r' → vuelve por term-data.
//   4. la extracción puede emitir 'speak' (informativo, best-effort).
//   5. term-resize no rompe.
//   6. close → snapshot sin la sesión (PTY liberado, sin huérfanos).
import { WebSocket } from 'ws';

const HTTP = 'http://localhost:4321';
const WSURL = 'ws://localhost:4321';
const SECTION = 'pty-1';
const MARK = 'VAB-marker-9182';
const TIMEOUT_MS = 20000;
const fail = (m) => { console.error(`FAIL ❌ ${m}`); process.exit(1); };
const timer = setTimeout(() => fail(`timeout ${TIMEOUT_MS}ms`), TIMEOUT_MS);

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

const fetchRetry = async (url, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`no responde ${url}`);
};

// --- 1) /api/voice-config -----------------------------------------------------
const cfgRes = await fetchRetry(`${HTTP}/api/voice-config`);
const cfg = await cfgRes.json();
if (typeof cfg.stt !== 'boolean' || typeof cfg.tts !== 'boolean' || !cfg.lang)
  fail(`/api/voice-config con forma inesperada: ${JSON.stringify(cfg)}`);
console.log(`[1] /api/voice-config → ${JSON.stringify(cfg)} ✅`);

// --- 2) create pty + 3) input/output -----------------------------------------
const ws = await open(WSURL);
const onMsg = (pred) =>
  new Promise((res) => {
    const h = (raw) => {
      const m = JSON.parse(raw.toString());
      if (pred(m)) { ws.off('message', h); res(m); }
    };
    ws.on('message', h);
  });

let term = '';
let spoke = '';
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'term-data' && m.sectionId === SECTION) term += m.data;
  if (m.t === 'speak' && m.sectionId === SECTION) spoke += m.text + ' ';
});

await onMsg((m) => m.t === 'snapshot');
ws.send(JSON.stringify({ t: 'create', sectionId: SECTION, agent: 'mock', mode: 'yolo', cwd: '.', kind: 'pty', cols: 80, rows: 24 }));
await onMsg((m) => m.t === 'created' && m.sectionId === SECTION && m.kind === 'pty');
console.log('[2] sección pty creada (bash bajo PTY) ✅');

// Espera a que el shell imprima su prompt, luego manda un comando.
await new Promise((r) => setTimeout(r, 800));
ws.send(JSON.stringify({ t: 'term-input', sectionId: SECTION, data: `echo ${MARK}\r` }));

// Espera la salida.
for (let i = 0; i < 60 && !term.includes(MARK); i++) await new Promise((r) => setTimeout(r, 100));
if (!term.includes(MARK)) fail(`no llegó la salida del PTY por term-data (term=${JSON.stringify(term.slice(-200))})`);
console.log(`[3] term-input → term-data contiene "${MARK}" ✅`);

// --- 4) resize ----------------------------------------------------------------
ws.send(JSON.stringify({ t: 'term-resize', sectionId: SECTION, cols: 100, rows: 30 }));
await new Promise((r) => setTimeout(r, 300));
console.log('[4] term-resize sin romper ✅');
console.log(`[~] speak (best-effort): ${spoke ? JSON.stringify(spoke.trim().slice(0, 80)) : '(ninguno)'}`);

// --- 6) close -----------------------------------------------------------------
ws.send(JSON.stringify({ t: 'close', sectionId: SECTION }));
const snap = await onMsg((m) => m.t === 'snapshot');
if (snap.sessions.some((s) => s.sectionId === SECTION)) fail('close no liberó la sesión pty');
console.log('[6] close → snapshot sin la sesión (PTY liberado) ✅');

clearTimeout(timer);
ws.close();
console.log('PASS ✅ PTY + voice-proxy OK');
process.exit(0);
