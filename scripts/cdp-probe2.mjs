// Camino completo en navegador real: crea pty con agente REAL (claude), escribe
// vía #text+Enter, y verifica que el TUI se renderiza y la entrada llega al PTY.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9223;
const PWA = 'http://localhost:5180';
const AGENT = process.argv[2] ?? 'claude';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,`--user-data-dir=/tmp/cdp-vab2-${Date.now()}`,'about:blank'],{stdio:'ignore'});
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);
let target;
for (let i=0;i<60;i++){ try{ const r=await fetch(`http://localhost:${PORT}/json`); const l=await r.json(); target=l.find(t=>t.type==='page'); if(target?.webSocketDebuggerUrl)break;}catch{} await sleep(200);}
if(!target){console.error('no devtools');cleanup();process.exit(1);}
const ws=new WebSocket(target.webSocketDebuggerUrl); let id=0;
const logs=[];
await new Promise(r=>ws.on('open',r));
ws.on('message',(raw)=>{const m=JSON.parse(raw.toString());
  if(m.method==='Runtime.exceptionThrown'){const e=m.params.exceptionDetails;logs.push(`[EXCEPTION] ${e.exception?.description??e.text}`);}
  else if(m.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(m.params.type)){logs.push(`[console.${m.params.type}] ${(m.params.args||[]).map(a=>a.value??a.description??'').join(' ')}`);}
});
const evalExpr=(expr)=>new Promise((resolve)=>{const myId=++id;const onMsg=(raw)=>{const m=JSON.parse(raw.toString());if(m.id===myId){ws.off('message',onMsg);resolve(m.result?.result?.value);}};ws.on('message',onMsg);ws.send(JSON.stringify({id:myId,method:'Runtime.evaluate',params:{expression:expr,returnByValue:true}}));});
ws.send(JSON.stringify({id:++id,method:'Runtime.enable'}));
ws.send(JSON.stringify({id:++id,method:'Page.enable'}));
await sleep(300);
ws.send(JSON.stringify({id:++id,method:'Page.navigate',params:{url:PWA}}));
await sleep(3000);
console.log('status:', await evalExpr("document.querySelector('#status')?.textContent"));
// crea pty con agente real
await evalExpr("document.querySelector('#kind').value='pty'");
await evalExpr(`document.querySelector('#agent').value='${AGENT}'`);
await evalExpr("document.querySelector('#mode').value='yolo'");
await evalExpr("document.querySelector('#cwd').value='/tmp/vab-test'");
await evalExpr("document.querySelector('#create').click()");
console.log(`creando pty ${AGENT}…`);
await sleep(6000); // arranque del CLI real + render TUI
let rendered = await evalExpr("(document.querySelector('#term .xterm-rows')?.innerText||'').replace(/\\n+/g,' | ').slice(0,400)");
console.log('TUI renderizado en navegador (primeros 400 chars):\n  ', JSON.stringify(rendered));
// escribe vía #text + Enter (ruta submit → termInput)
await evalExpr("(()=>{const i=document.querySelector('#text');i.value='di hola en una palabra';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()");
console.log('enviado "di hola" vía #text+Enter');
await sleep(7000);
rendered = await evalExpr("(document.querySelector('#term .xterm-rows')?.innerText||'').replace(/\\n+/g,' | ').slice(-500)");
console.log('TUI tras enviar (últimos 500 chars):\n  ', JSON.stringify(rendered));
console.log('vhint:', await evalExpr("document.querySelector('#vhint')?.textContent"));
console.log('\n--- errores navegador ---'); logs.length?logs.forEach(l=>console.log(l)):console.log('(ninguno)');
// cierra la sección para no dejar el CLI vivo
await evalExpr("document.querySelector('#sections .x')?.click()");
await sleep(800);
cleanup(); process.exit(0);
