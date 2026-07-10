// Captura visual del rebrand BENNZEN vía CDP (sin spawnear agentes reales).
// Inyecta cards de ejemplo de los 4 agentes y activa el orbe para la foto.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9223;
const PWA = process.env.PWA ?? 'http://localhost:5181';
const OUT = process.env.OUT ?? '/tmp/bennzen-cards.png';
const MODAL = process.env.MODAL === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=2',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/cdp-shot-${Date.now()}`,
  '--window-size=1280,820', 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

let target;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/json`);
    target = (await r.json()).find((t) => t.type === 'page');
    if (target?.webSocketDebuggerUrl) break;
  } catch {}
  await sleep(200);
}
if (!target) { console.error('DevTools no respondió'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const logs = [];
await new Promise((res) => ws.on('open', res));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.method === 'Runtime.exceptionThrown') {
    const e = m.params.exceptionDetails;
    logs.push(`[EXCEPTION] ${e.exception?.description ?? e.text}`);
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    logs.push(`[error] ${m.params.entry.text}`);
  }
});
const cmd = (method, params = {}) => new Promise((resolve) => {
  const myId = ++id;
  const onMsg = (raw) => { const m = JSON.parse(raw.toString()); if (m.id === myId) { ws.off('message', onMsg); resolve(m.result); } };
  ws.on('message', onMsg);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const evalJs = (expr) => cmd('Runtime.evaluate', { expression: expr, returnByValue: true });

await cmd('Runtime.enable');
await cmd('Log.enable');
await cmd('Page.enable');
await cmd('Page.navigate', { url: PWA });
await sleep(1500);

// Siembra perfiles ANTES de que la app los lea (loadProfiles corre en init), luego recarga.
await evalJs(`localStorage.setItem('bennzen.profiles.v1', JSON.stringify([
  { id:'p1', name:'Claude · monorepo', agent:'claude', mode:'safe-auto', kind:'pty', cwd:'~/dev/app' },
  { id:'p2', name:'Codex · scripts',  agent:'codex',  mode:'yolo',      kind:'rpc', cwd:'~/scripts' }
])); 'seeded';`);
await cmd('Page.reload');
await sleep(3500);

// Inyecta cards de los 4 agentes (réplica EXACTA del DOM que produce render()).
// Los logos se sirven en dev desde la raíz de Vite (pwa/) en /assets/agents/*.
const inject = `
const LOGO = { claude:'/assets/agents/claude.png', codex:'/assets/agents/codex.webp', opencode:'/assets/agents/opencode.png' };
const agents = [['claude','yolo','pty',true],['codex','readonly','rpc',false],['opencode','safe-auto','pty',true],['mock','safe-auto','rpc',true]];
const list = document.querySelector('#sections');
list.innerHTML = '';
agents.forEach(([agent,mode,kind,ready],i) => {
  const li = document.createElement('li');
  li.className = i===0 ? 'card active' : 'card';
  li.dataset.agent = agent;
  let avatar;
  if (LOGO[agent]) { avatar = document.createElement('img'); avatar.className='card-avatar'; avatar.src=LOGO[agent]; avatar.alt=agent; }
  else { avatar = document.createElement('span'); avatar.className='card-avatar card-avatar-fallback'; avatar.textContent=agent.slice(0,1); }
  const main = document.createElement('span'); main.className='card-main';
  const title = document.createElement('span'); title.className='card-title'; title.textContent=agent;
  const sub = document.createElement('span'); sub.className='card-sub';
  const k = document.createElement('span'); k.className='kind'; k.textContent = kind==='pty'?'⌨ TUI':'💬 chat';
  sub.append(k, document.createTextNode(' · '+mode));
  main.append(title, sub);
  const status = document.createElement('span'); status.className = ready?'card-status ready':'card-status';
  const x = document.createElement('button'); x.className='x'; x.textContent='✕';
  li.append(avatar, main, status, x);
  list.appendChild(li);
});
// Orbe en estado 'listening' con nivel alto → partículas agitadas y brillantes para la foto.
const orb = document.querySelector('#orb'); orb.className='orb listening'; orb.style.setProperty('--level','0.7');
${MODAL ? "document.querySelector('#new-section').click();" : ''}
'ok';`;
const r = await evalJs(inject);
console.log('inject:', r?.result?.value, MODAL ? '(modal abierto)' : '');
await sleep(1200); // deja correr la animación de partículas

const shot = await cmd('Page.captureScreenshot', { format: 'png' });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('captura →', OUT);
console.log(logs.length ? logs.join('\n') : '(sin errores de consola)');
cleanup();
process.exit(0);
