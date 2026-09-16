// Guardia de regresión: el scrollback pty solo viaja en el snapshot INICIAL.
// Verifica:
//   (a) el snapshot inicial de conexión incluye la clave scrollback en sesiones pty
//       (o sesiones vacías si no hay ninguna viva);
//   (b) los snapshots de BROADCAST (tras create/close) NO incluyen scrollback
//       en sesiones pty (los términos vivos ya reciben term-data).
//
// Uso (orquestador aislado, NUNCA el del usuario):
//   PORT=4321 npx tsx orchestrator/server.ts &
//   node scripts/pty-guard-check.mjs 4321
//   # matar después el orquestador aislado
//
// Puerto por argv[2] o env PORT, default 4319. Sin dependencias (WebSocket global Node 22+).

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4319);
const WSURL = `ws://localhost:${PORT}`;
const TIMEOUT_MS = 20000;
const SECTION = `guard-${Date.now()}`;

const fail = (m) => {
  console.error(`FAIL ❌ ${m}`);
  process.exit(1);
};
const timer = setTimeout(() => fail(`timeout ${TIMEOUT_MS}ms esperando mensajes de ${WSURL}`), TIMEOUT_MS);
const pass = (m) => console.log(`${m} ✅`);

if (typeof WebSocket !== 'function') fail('sin WebSocket global (se requiere Node 22+)');

const open = (url) =>
  new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => res(ws), { once: true });
    ws.addEventListener('error', () => rej(new Error(`no conecta a ${url}`)), { once: true });
  });

// Resuelve con el próximo mensaje que cumpla pred; los demás se ignoran.
const nextMsg = (ws, pred) =>
  new Promise((res) => {
    const h = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return; // ignora no-JSON
      }
      if (pred(m)) {
        ws.removeEventListener('message', h);
        res(m);
      }
    };
    ws.addEventListener('message', h);
  });
const nextSnapshot = (ws) => nextMsg(ws, (m) => m.t === 'snapshot');

const hasScrollbackKey = (s) => Object.hasOwn(s, 'scrollback');
const ptySessions = (snap) => (snap.sessions ?? []).filter((s) => s.kind === 'pty');

// --- (a1) snapshot inicial en orquestador (casi seguro) vacío -----------------
const ws = await open(WSURL).catch((e) => fail(e.message));
const s0 = await nextSnapshot(ws);
const s0pty = ptySessions(s0);
if (s0pty.some((s) => !hasScrollbackKey(s))) fail('snapshot inicial: sesión pty sin clave scrollback');
pass(`[a1] snapshot inicial con ${s0pty.length} sesión(es) pty, todas con scrollback`);

// --- create pty mock → broadcast SIN scrollback --------------------------------
ws.send(
  JSON.stringify({
    t: 'create',
    sectionId: SECTION,
    agent: 'mock',
    mode: 'yolo',
    cwd: '.',
    kind: 'pty',
    cols: 80,
    rows: 24,
  }),
);
await nextMsg(ws, (m) => m.t === 'created' && m.sectionId === SECTION && m.kind === 'pty');
const s1 = await nextSnapshot(ws); // broadcast post-create
const s1pty = ptySessions(s1);
if (!s1pty.some((s) => s.sectionId === SECTION)) fail('broadcast post-create no incluye la sección creada');
if (s1pty.some(hasScrollbackKey)) fail('broadcast post-create incluye la clave scrollback en pty');
pass('[b1] broadcast post-create incluye la sección y SIN scrollback');

// --- (a2) segunda conexión: su snapshot inicial SÍ trae scrollback -------------
const ws2 = await open(WSURL).catch((e) => fail(e.message));
const s2 = await nextSnapshot(ws2);
const ours = ptySessions(s2).find((s) => s.sectionId === SECTION);
if (!ours) fail('snapshot inicial (2ª conexión) no incluye la sesión pty viva');
if (!hasScrollbackKey(ours) || typeof ours.scrollback !== 'string')
  fail('snapshot inicial (2ª conexión): scrollback ausente o no es string');
pass('[a2] snapshot inicial (2ª conexión) incluye scrollback de la sesión viva');
ws2.close();

// --- close → broadcast SIN scrollback ------------------------------------------
ws.send(JSON.stringify({ t: 'close', sectionId: SECTION }));
const s3 = await nextSnapshot(ws); // broadcast post-close
const s3pty = ptySessions(s3);
if (s3pty.some((s) => s.sectionId === SECTION)) fail('broadcast post-close aún incluye la sección cerrada');
if (s3pty.some(hasScrollbackKey)) fail('broadcast post-close incluye la clave scrollback en pty');
pass('[b2] broadcast post-close sin la sección y SIN scrollback');

clearTimeout(timer);
ws.close();
console.log('PASS 🎉 scrollback solo en snapshot inicial; broadcasts limpios.');
