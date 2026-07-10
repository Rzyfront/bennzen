// Smoke test del orquestador por WebSocket.
// Uso: node scripts/smoke.mjs <agent> <mode> "<prompt>" [cwd]
//   ej: node scripts/smoke.mjs codex readonly "Responde solo: hola" /tmp
import { WebSocket } from 'ws';

const [, , agent = 'mock', mode = 'yolo', prompt = 'hola mundo', cwd = '.'] = process.argv;
const ws = new WebSocket('ws://localhost:4319');
const sectionId = `smoke-${agent}`;
let text = '';
const TIMEOUT_MS = 60000;

const timer = setTimeout(() => {
  console.error(`TIMEOUT tras ${TIMEOUT_MS}ms`);
  process.exit(2);
}, TIMEOUT_MS);

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'create', sectionId, agent, mode, cwd }));
});

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'created') {
    console.log(`[created] ${agent} → ${m.agentSessionId}`);
    ws.send(JSON.stringify({ t: 'say', sectionId, text: prompt }));
  } else if (m.t === 'delta') {
    const d = m.delta;
    if (d.type === 'text') {
      text += d.text;
      process.stdout.write(d.text);
    } else if (d.type === 'tool') {
      console.log(`\n[tool] ${d.name}`);
    } else if (d.type === 'error') {
      console.log(`\n[delta-error] ${d.message}`);
    } else if (d.type === 'done') {
      clearTimeout(timer);
      console.log(`\n--- DONE --- (${text.trim().length} chars)`);
      console.log(text.trim().length > 0 ? 'PASS ✅' : 'SIN TEXTO ⚠️');
      ws.close();
      process.exit(0);
    }
  } else if (m.t === 'error') {
    clearTimeout(timer);
    console.error(`\n[error] ${m.message}`);
    ws.close();
    process.exit(1);
  }
});

ws.on('error', (e) => {
  console.error('WS ERROR:', e.message);
  process.exit(4);
});
