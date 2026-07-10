// Smoke del proxy de voz con config por CABECERAS (localStorage → x-voice-*).
// Levanta un "proveedor" falso local y verifica que el orquestador:
//   - reenvía STT al endpoint indicado en x-voice-url y devuelve {text}.
//   - reenvía TTS y devuelve los bytes de audio.
//   - incluye cabeceras CORS (necesarias para el navegador 5180→4321).
// Requiere el orquestador en PORT=4321.
import { createServer } from 'node:http';

const ORCH = 'http://localhost:4321';
const UPSTREAM_PORT = 4322;
const fail = (m) => { console.error(`FAIL ❌ ${m}`); process.exit(1); };

// --- Proveedor falso ----------------------------------------------------------
let sttSawAuth = '';
const upstream = createServer((req, res) => {
  let body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    if (req.url === '/stt') {
      sttSawAuth = req.headers['authorization'] ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'transcrito-ok' }));
    } else if (req.url === '/tts') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.from([0x49, 0x44, 0x33, 0x99])); // bytes "audio" arbitrarios
    } else {
      res.writeHead(404); res.end();
    }
  });
});

const waitOrch = async () => {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${ORCH}/api/voice-config`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  fail('orquestador no responde en 4321');
};

await new Promise((r) => upstream.listen(UPSTREAM_PORT, r));
await waitOrch();

// --- STT por cabeceras --------------------------------------------------------
const sttRes = await fetch(`${ORCH}/api/stt`, {
  method: 'POST',
  headers: {
    'Content-Type': 'audio/webm',
    'x-voice-format': 'generic',
    'x-voice-url': `http://localhost:${UPSTREAM_PORT}/stt`,
    'x-voice-key': 'secret-123',
  },
  body: Buffer.from([1, 2, 3, 4]),
});
if (!sttRes.ok) fail(`STT status ${sttRes.status}`);
if (!sttRes.headers.get('access-control-allow-origin')) fail('STT sin cabecera CORS');
const sttJson = await sttRes.json();
if (sttJson.text !== 'transcrito-ok') fail(`STT texto inesperado: ${JSON.stringify(sttJson)}`);
if (sttSawAuth !== 'Bearer secret-123') fail(`STT no reenvió el Authorization (vio: ${JSON.stringify(sttSawAuth)})`);
console.log('[1] STT: reenvió a x-voice-url, Bearer correcto, {text} OK, CORS OK ✅');

// --- TTS por cabeceras --------------------------------------------------------
const ttsRes = await fetch(`${ORCH}/api/tts`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-voice-format': 'generic',
    'x-voice-url': `http://localhost:${UPSTREAM_PORT}/tts`,
    'x-voice-key': 'secret-123',
    'x-voice-tts-voice': 'nova',
  },
  body: JSON.stringify({ text: 'hola' }),
});
if (!ttsRes.ok) fail(`TTS status ${ttsRes.status}`);
if (!ttsRes.headers.get('access-control-allow-origin')) fail('TTS sin cabecera CORS');
const audio = Buffer.from(await ttsRes.arrayBuffer());
if (audio.length !== 4) fail(`TTS audio inesperado (${audio.length} bytes)`);
console.log('[2] TTS: reenvió a x-voice-url, devolvió audio, CORS OK ✅');

// --- Sin config y sin .env → 503 ---------------------------------------------
const none = await fetch(`${ORCH}/api/tts`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'x' }),
});
if (none.status !== 503) fail(`esperaba 503 sin config, vino ${none.status}`);
console.log('[3] Sin cabeceras ni .env → 503 (fallback vacío) ✅');

upstream.close();
console.log('PASS ✅ proxy de voz (config por cabeceras) OK');
process.exit(0);
