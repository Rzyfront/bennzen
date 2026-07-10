// Diagnóstico: lanza la TUI real de un CLI bajo PTY, le manda un prompt trivial,
// y vuelca cada línea RENDERIZADA con su primer glifo (U+XXXX). Sirve para
// descubrir qué marca usa cada agente para su prosa (lo que el tts-extractor
// necesita en ASSISTANT_MARK). No adivina: observa la salida real.
//
// Uso: node scripts/capture-tui.mjs <claude|codex|opencode|mock> [prompt] [segundos]
import * as pty from 'node-pty';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');

const agent = process.argv[2] ?? 'opencode';
const prompt = process.argv[3] ?? 'Responde unicamente con la frase: el zorro veloz salta.';
const secs = Number(process.argv[4] ?? 22);

const COLS = 100, ROWS = 30;
const cmd = {
  claude: ['claude', ['--dangerously-skip-permissions']],
  codex: ['codex', ['--dangerously-bypass-approvals-and-sandbox']],
  opencode: ['opencode', []],
  mock: ['bash', []],
}[agent];
if (!cmd) { console.error('agente desconocido:', agent); process.exit(1); }

const cwd = process.env.CWD ?? '/tmp';
const proc = pty.spawn(cmd[0], cmd[1], { name: 'xterm-color', cols: COLS, rows: ROWS, cwd, env: process.env });
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });

let raw = '';
proc.onData((d) => { raw += d; term.write(d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(7000);            // deja arrancar la TUI (claude/codex tardan)
  proc.write(prompt);           // teclea el prompt
  await sleep(200);
  proc.write('\r');             // Enter como escritura SEPARADA (fix de envío)
  await sleep(secs * 1000);     // deja responder

  // Vuelca el buffer renderizado: por cada línea no vacía, primer glifo + code point.
  const buf = term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.baseY + ROWS; i++) {
    const line = buf.getLine(i)?.translateToString(true);
    if (line === undefined) continue;
    const t = line.replace(/\s+$/, '');
    if (!t.trim()) continue;
    const first = [...t.trimStart()][0] ?? '';
    const cp = first ? 'U+' + first.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') : '----';
    out.push(`${cp} ${JSON.stringify(first)} | ${t}`);
  }
  console.log(`\n===== ${agent} — líneas renderizadas (glifo inicial | texto) =====`);
  console.log(out.join('\n'));
  console.log(`\n===== ${agent} — fin (${out.length} líneas) =====`);

  // Respaldo para apps de pantalla alterna: vuelca el RAW (sin ANSI) por si el
  // buffer renderizado quedó vacío al restaurar pantalla.
  if (out.length < 2) {
    // eslint-disable-next-line no-control-regex
    const plain = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    console.log(`\n===== ${agent} — RAW sin ANSI (respaldo, últimos 2500) =====`);
    console.log(plain.slice(-2500));
    console.log(`\n===== ${agent} — fin RAW =====`);
  }

  try { proc.kill('SIGTERM'); } catch {}
  await sleep(300);
  try { proc.kill('SIGKILL'); } catch {}
  process.exit(0);
})();

setTimeout(() => { try { proc.kill('SIGKILL'); } catch {}; process.exit(0); }, (secs + 12) * 1000);
