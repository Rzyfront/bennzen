// Diagnóstico fino: ¿qué agente envía el navegador al crear? Lee el valor del
// select justo antes del clic y la etiqueta de la sección creada.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9224, PWA='http://localhost:5180';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=/tmp/cdp-vab3-${Date.now()}`,'about:blank'],{stdio:'ignore'});
process.on('exit',()=>{try{chrome.kill('SIGKILL');}catch{}});
let target; for(let i=0;i<60;i++){try{const r=await fetch(`http://localhost:${PORT}/json`);const l=await r.json();target=l.find(t=>t.type==='page');if(target?.webSocketDebuggerUrl)break;}catch{} await sleep(200);}
const ws=new WebSocket(target.webSocketDebuggerUrl);let id=0;
await new Promise(r=>ws.on('open',r));
const ev=(expr)=>new Promise((resolve)=>{const myId=++id;const on=(raw)=>{const m=JSON.parse(raw.toString());if(m.id===myId){ws.off('message',on);resolve(m.result?.result?.value);}};ws.on('message',on);ws.send(JSON.stringify({id:myId,method:'Runtime.evaluate',params:{expression:expr,returnByValue:true}}));});
ws.send(JSON.stringify({id:++id,method:'Runtime.enable'}));
ws.send(JSON.stringify({id:++id,method:'Page.navigate',params:{url:PWA}}));
await sleep(3000);
await ev("document.querySelector('#kind').value='pty'");
await ev("document.querySelector('#agent').value='claude'");
console.log('valor #agent justo antes del clic:', await ev("document.querySelector('#agent').value"));
console.log('opciones #agent:', await ev("[...document.querySelector('#agent').options].map(o=>o.value).join(',')"));
await ev("document.querySelector('#create').click()");
await sleep(2500);
console.log('etiqueta de la sección creada:', await ev("document.querySelector('#sections .label')?.textContent"));
await sleep(4000);
console.log('TUI:', JSON.stringify(await ev("(document.querySelector('#term .xterm-rows')?.innerText||'').replace(/\\n+/g,'|').slice(0,200)")));
await ev("document.querySelector('#sections .x')?.click()");
await sleep(600);
process.exit(0);
