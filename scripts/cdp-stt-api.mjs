// Demuestra que con STT='api' el navegador NO usa Web Speech sino que graba y
// hace POST /api/stt → proxy → proveedor. Levanta un proveedor falso (4399).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9225, PWA='http://localhost:5180';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

// Proveedor STT falso: recibe el audio reenviado por el proxy y devuelve texto.
let hits=0, sawContentType='';
const upstream=createServer((req,res)=>{let b=[];req.on('data',c=>b.push(c));req.on('end',()=>{hits++;sawContentType=req.headers['content-type']||'';res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({text:'transcrito-por-mi-api'}));});});
await new Promise(r=>upstream.listen(4399,r));

const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--remote-debugging-port=${PORT}`,`--user-data-dir=/tmp/cdp-stt-${Date.now()}`,'about:blank'],{stdio:'ignore'});
process.on('exit',()=>{try{chrome.kill('SIGKILL');}catch{};upstream.close();});
let target;for(let i=0;i<60;i++){try{const r=await fetch(`http://localhost:${PORT}/json`);const l=await r.json();target=l.find(t=>t.type==='page');if(target?.webSocketDebuggerUrl)break;}catch{} await sleep(200);}
const ws=new WebSocket(target.webSocketDebuggerUrl);let id=0;
await new Promise(r=>ws.on('open',r));
const ev=(expr)=>new Promise((resolve)=>{const myId=++id;const on=(raw)=>{const m=JSON.parse(raw.toString());if(m.id===myId){ws.off('message',on);resolve(m.result?.result?.value);}};ws.on('message',on);ws.send(JSON.stringify({id:myId,method:'Runtime.evaluate',params:{expression:expr,returnByValue:true}}));});
ws.send(JSON.stringify({id:++id,method:'Runtime.enable'}));
ws.send(JSON.stringify({id:++id,method:'Page.navigate',params:{url:PWA}}));
await sleep(2500);
// Configura STT=api (genérico → mi proveedor falso). TTS lo dejamos en navegador.
await ev(`localStorage.setItem('voice.config.v2', ${JSON.stringify(JSON.stringify({stt:'api',tts:'browser',lang:'es-ES',sttApi:{format:'generic',url:'http://localhost:4399/stt',key:'mi-key',model:'whisper-1'},ttsApi:{format:'openai',url:'',key:'',model:'tts-1',voice:'alloy'}}))})`);
ws.send(JSON.stringify({id:++id,method:'Page.navigate',params:{url:PWA}}));
await sleep(2500);
// Crea sección rpc para tener una activa (startTalk la exige) y ver el texto final.
await ev("document.querySelector('#kind').value='rpc'");
await ev("document.querySelector('#agent').value='mock'");
await ev("document.querySelector('#create').click()");
await sleep(1500);
// Push-to-talk: pointerdown → graba; tras 2s → pointerup → sube el audio.
await ev("document.querySelector('#talk').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
await sleep(400);
console.log('vhint al hablar (api):', JSON.stringify(await ev("document.querySelector('#vhint')?.textContent")));
await sleep(2000);
await ev("document.querySelector('#talk').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))");
await sleep(3000); // subida + transcripción
console.log('vhint tras soltar     :', JSON.stringify(await ev("document.querySelector('#vhint')?.textContent")));
console.log('log (texto final →say):', JSON.stringify(await ev("(document.querySelector('#log')?.textContent||'').slice(0,200)")));
console.log('');
console.log('==> proveedor STT falso recibió', hits, 'petición(es); content-type:', JSON.stringify(sawContentType));
console.log(hits>0 ? 'PASS ✅ el navegador usó la RUTA API (no Web Speech)' : 'FAIL ❌ no llegó al proveedor');
process.exit(0);
