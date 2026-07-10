// Captura eventos `speak` (prosa extraída) de una sesión claude PTY real.
// Si NO llegan speak tras la respuesta del agente → el extractor no sirve para TUIs.
import { WebSocket } from 'ws';
const ws = new WebSocket(process.env.WS ?? 'ws://localhost:4319');
const sectionId = 'speak-probe';
const speaks = []; let termBytes = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'term-data') termBytes += m.data.length;
  if (m.t === 'speak') { speaks.push(m.text); console.log(`\n>>> SPEAK: ${JSON.stringify(m.text)}\n`); }
  if (m.t === 'error') console.log('ERR:', m.message);
});
ws.on('open', async () => {
  ws.send(JSON.stringify({ t:'create', sectionId, agent:'claude', mode:'yolo', cwd:'/tmp/vab-test', kind:'pty', cols:100, rows:30 }));
  await sleep(6000); // arranque TUI
  console.log(`[tras arranque] term-data=${termBytes}B, speaks=${speaks.length}`);
  ws.send(JSON.stringify({ t:'term-input', sectionId, data:'responde solo con: hola rafael como estas\r' }));
  console.log('>>> prompt enviado, esperando respuesta…');
  await sleep(20000); // claude procesa + responde
  console.log(`\n========= RESUMEN =========`);
  console.log(`term-data total: ${termBytes}B`);
  console.log(`eventos speak  : ${speaks.length}`);
  speaks.forEach((s,i)=>console.log(`  [${i}] ${JSON.stringify(s.slice(0,120))}`));
  ws.send(JSON.stringify({ t:'close', sectionId }));
  await sleep(800); ws.close(); process.exit(0);
});
