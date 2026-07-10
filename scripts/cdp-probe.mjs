// Maneja Chrome headless vía CDP para capturar errores de consola/excepciones
// de la PWA real y simular el clic en "Crear sección" (pty). Sin añadir deps.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9222;
const PWA = process.env.PWA ?? 'http://localhost:5180';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/cdp-vab-${Date.now()}`,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

// Espera al endpoint de depuración.
let target;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/json`);
    const list = await r.json();
    target = list.find((t) => t.type === 'page');
    if (target?.webSocketDebuggerUrl) break;
  } catch {}
  await sleep(200);
}
if (!target) { console.error('Chrome DevTools no respondió'); cleanup(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));

const logs = [];
await new Promise((res) => ws.on('open', res));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? a.unserializableValue ?? JSON.stringify(a.preview ?? '')).join(' ');
    logs.push(`[console.${m.params.type}] ${txt}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const e = m.params.exceptionDetails;
    logs.push(`[EXCEPTION] ${e.exception?.description ?? e.text} @ ${e.url}:${e.lineNumber}`);
  } else if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (e.level === 'error' || e.level === 'warning') logs.push(`[log.${e.level}] ${e.text} ${e.url ?? ''}`);
  }
});

send('Runtime.enable');
send('Log.enable');
send('Page.enable');
await sleep(300);
send('Page.navigate', { url: PWA });
await sleep(3500); // carga + conexión WS

console.log('--- tras cargar la página ---');
// Lee estado de la app vía evaluación.
const evalExpr = (expr) => new Promise((resolve) => {
  const myId = ++id;
  const onMsg = (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id === myId) { ws.off('message', onMsg); resolve(m.result?.result); }
  };
  ws.on('message', onMsg);
  ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
});

const status = await evalExpr("document.querySelector('#status')?.textContent");
console.log('status:', status?.value);

// Elige pty y haz clic en Crear.
await evalExpr("document.querySelector('#kind').value='pty'");
await evalExpr("document.querySelector('#agent').value='mock'");
await evalExpr("document.querySelector('#create').click()");
await sleep(4000);

const sectionsHtml = await evalExpr("document.querySelector('#sections')?.innerHTML");
const termHidden = await evalExpr("document.querySelector('#term')?.hidden");
const termHasXterm = await evalExpr("!!document.querySelector('#term .xterm')");
const logHidden = await evalExpr("document.querySelector('#log')?.hidden");
console.log('lista de secciones HTML:', sectionsHtml?.value);
console.log('#term hidden:', termHidden?.value, '| tiene .xterm:', termHasXterm?.value, '| #log hidden:', logHidden?.value);

console.log('\n--- CONSOLA / ERRORES DEL NAVEGADOR ---');
if (logs.length === 0) console.log('(sin errores ni warnings)');
else logs.forEach((l) => console.log(l));

cleanup();
process.exit(0);
