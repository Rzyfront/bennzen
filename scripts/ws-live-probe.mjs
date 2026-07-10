// Replica EXACTA de lo que hace el navegador contra el orquestador VIVO (4319).
// Crea una sección pty, escucha created + term-data, escribe input, cierra.
import { WebSocket } from 'ws';
const URL = process.env.WS ?? 'ws://localhost:4319';
const agent = process.argv[2] ?? 'mock';
const sectionId = 'probe-' + agent;
const log = (...a) => console.log('[ws]', ...a);

const ws = new WebSocket(URL);
let termBytes = 0, gotCreated = false, gotSnapshot = false;

ws.on('open', () => log('conectado a', URL));
ws.on('error', (e) => { console.error('WS ERROR:', e.message); process.exit(1); });
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'snapshot') { gotSnapshot = true; log('snapshot:', m.sessions.length, 'sesiones'); return; }
  if (m.t === 'created') { gotCreated = true; log('CREATED', JSON.stringify(m)); return; }
  if (m.t === 'term-data') { termBytes += m.data.length; process.stdout.write(m.data); return; }
  if (m.t === 'speak') { log('SPEAK →', JSON.stringify(m.text)); return; }
  if (m.t === 'error') { log('ERROR del orquestador:', JSON.stringify(m)); return; }
  log('msg:', m.t);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(400);
  log('>>> create pty', agent);
  ws.send(JSON.stringify({ t: 'create', sectionId, agent, mode: 'yolo', cwd: '/tmp/vab-test', kind: 'pty', cols: 100, rows: 30 }));
  await sleep(4000);
  log(`>>> term-input "echo hola-desde-ws\\r"`);
  ws.send(JSON.stringify({ t: 'term-input', sectionId, data: agent === 'mock' ? 'echo hola-desde-ws\r' : 'di hola\r' }));
  await sleep(5000);
  log('>>> close');
  ws.send(JSON.stringify({ t: 'close', sectionId }));
  await sleep(600);
  console.log('\n========== RESUMEN ==========');
  console.log('snapshot recibido:', gotSnapshot);
  console.log('created recibido :', gotCreated);
  console.log('term-data bytes  :', termBytes);
  ws.close();
  process.exit(gotCreated && termBytes > 0 ? 0 : 2);
})();
