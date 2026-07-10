// Prueba aislada del teardown (no usa el puerto 4319; importa adaptadores directo).
// Uso: npx tsx scripts/teardown-test.ts [cwd]
import { execSync } from 'node:child_process';
import { OpenCodeAdapter } from '../orchestrator/adapters/opencode';
import { CodexAdapter } from '../orchestrator/adapters/codex';

const CWD = process.argv[2] ?? '.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (pattern: string): number => {
  try {
    return execSync(`pgrep -f ${JSON.stringify(pattern)} || true`).toString().trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

async function testOpenCode(): Promise<void> {
  console.log('\n=== OpenCode: server se cierra en shutdown ===');
  const oc = new OpenCodeAdapter();
  const { sessionId } = await oc.createSession({ cwd: CWD, mode: 'readonly' });
  let text = '';
  for await (const d of oc.send(sessionId, 'Responde solo: hola')) {
    if (d.type === 'text') text += d.text;
    if (d.type === 'error') console.log('  [error]', d.message);
  }
  console.log('  respuesta:', JSON.stringify(text.trim()));
  console.log('  opencode serve activos tras crear:', count('opencode serve --hostname'));
  await oc.shutdown();
  await sleep(900);
  const left = count('opencode serve --hostname');
  console.log(`  opencode serve tras shutdown: ${left} ${left === 0 ? '✅ sin huérfanos' : '⚠️ huérfano'}`);
}

async function testCodexMidFlight(): Promise<void> {
  console.log('\n=== Codex: close() mata el proceso en vuelo ===');
  const cx = new CodexAdapter();
  const handle = (await cx.createSession({ cwd: CWD, mode: 'readonly' })).sessionId;
  const it = cx.send(handle, 'Cuenta del 1 al 300 muy despacio, un numero por linea.')[Symbol.asyncIterator]();
  const pending = it.next(); // arranca el spawn
  await sleep(1800);
  const before = count('codex exec');
  console.log('  codex exec en vuelo:', before);
  await cx.close(handle);
  await sleep(900);
  const after = count('codex exec');
  console.log(`  codex exec tras close: ${after} ${after === 0 ? '✅ sin huérfanos' : '⚠️ huérfano'}`);
  await pending.catch(() => {});
}

async function main(): Promise<void> {
  await testOpenCode();
  await testCodexMidFlight();
  process.exit(0);
}

void main();
