// Verificación E2E del tts-extractor: lanza la TUI real bajo PTY y alimenta su
// salida al EXTRACTOR REAL (per-agente). Imprime exactamente lo que se hablaría.
// Uso: npx tsx scripts/verify-extractor.ts <claude|codex|opencode> [prompt] [segundos]
import * as pty from 'node-pty';
import { TerminalExtractor } from '../orchestrator/tts-extractor';
import type { AgentKind } from '../shared/protocol';

const agent = (process.argv[2] ?? 'opencode') as AgentKind;
const prompt =
  process.argv[3] ?? 'Cuanto es dos mas dos? Contesta en una sola frase corta y natural.';
const secs = Number(process.argv[4] ?? 26);

const COLS = 100;
const ROWS = 30;
const cmd: Record<string, [string, string[]]> = {
  claude: ['claude', ['--dangerously-skip-permissions']],
  codex: ['codex', ['--dangerously-bypass-approvals-and-sandbox']],
  opencode: ['opencode', []],
  agy: ['agy', ['--dangerously-skip-permissions']],
  mock: ['bash', []],
};
const spec = cmd[agent];
if (!spec) {
  console.error('agente desconocido:', agent);
  process.exit(1);
}

const spoken: string[] = [];
const extractor = new TerminalExtractor(COLS, ROWS, agent, (text) => {
  spoken.push(text);
  console.log(`🔊 SPEAK> ${text}`);
});

const proc = pty.spawn(spec[0], spec[1], {
  name: 'xterm-color',
  cols: COLS,
  rows: ROWS,
  cwd: process.env.CWD ?? '/tmp',
  env: process.env,
});
proc.onData((d) => extractor.write(d));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(7000);
  if (process.env.PREENTER === '1') {
    proc.write('\r'); // acepta el prompt de confianza de directorio (codex en dir nuevo)
    await sleep(4000);
  }
  extractor.noteInput(prompt);
  proc.write(prompt);
  await sleep(200);
  proc.write('\r'); // Enter discreto (mismo fix que la app)
  await sleep(secs * 1000);

  console.log(`\n===== ${agent}: ${spoken.length} frase(s) habladas =====`);
  spoken.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  console.log(`===== fin (${agent}) =====`);

  try {
    proc.kill('SIGTERM');
  } catch {
    /* ya salió */
  }
  await sleep(300);
  try {
    proc.kill('SIGKILL');
  } catch {
    /* ya salió */
  }
  process.exit(0);
})();

setTimeout(
  () => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ya salió */
    }
    process.exit(0);
  },
  (secs + 14) * 1000,
);
