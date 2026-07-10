// Prueba un CLI REAL bajo node-pty (sin WS, directo) para ver qué emite.
// Uso: node scripts/pty-real-probe.mjs <agent> [cwd]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pty = require('node-pty');

const agent = process.argv[2] ?? 'claude';
const cwd = process.argv[3] ?? '/tmp/vab-test';
const bin = { claude: 'claude', codex: 'codex', opencode: 'opencode' }[agent] ?? agent;
const args = agent === 'claude' ? ['--dangerously-skip-permissions']
  : agent === 'codex' ? ['--dangerously-bypass-approvals-and-sandbox'] : [];

console.log(`[probe] spawn ${bin} ${args.join(' ')}  (cwd=${cwd})`);
let out = '';
let p;
try {
  p = pty.spawn(bin, args, { name: 'xterm-color', cols: 100, rows: 30, cwd, env: process.env });
} catch (e) { console.log('SPAWN FAIL:', e.message); process.exit(1); }

p.onData((d) => { out += d; process.stdout.write(d); });
p.onExit(({ exitCode, signal }) => console.log(`\n[probe] EXIT code=${exitCode} signal=${signal}`));

// A los 4s, manda un prompt; a los 12s cierra.
setTimeout(() => { console.log('\n[probe] >>> escribiendo: di hola\\r'); p.write('di hola\r'); }, 4000);
setTimeout(() => { console.log(`\n[probe] total bytes recibidos: ${out.length}`); try { p.kill(); } catch {} process.exit(0); }, 12000);
