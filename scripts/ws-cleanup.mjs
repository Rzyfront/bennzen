import { WebSocket } from 'ws';
const ws = new WebSocket('ws://localhost:4319');
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'snapshot') {
    const ids = m.sessions.map(s => s.sectionId);
    console.log('sesiones vivas:', ids.length, m.sessions.map(s=>`${s.agent}/${s.kind}`).join(', ') || '(ninguna)');
    for (const id of ids) ws.send(JSON.stringify({ t: 'close', sectionId: id }));
    setTimeout(() => { console.log('cerradas'); ws.close(); process.exit(0); }, 1500);
  }
});
ws.on('error', (e) => { console.error('err', e.message); process.exit(1); });
