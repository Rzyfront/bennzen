// node-pty trae prebuilds cuyo `spawn-helper` (macOS/Linux) a veces pierde el
// bit de ejecución al extraerse → `pty.spawn` muere con "posix_spawnp failed".
// Este postinstall restaura +x en cualquier spawn-helper presente. Idempotente.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const base = join('node_modules', 'node-pty', 'prebuilds');
if (existsSync(base)) {
  for (const dir of readdirSync(base)) {
    const helper = join(base, dir, 'spawn-helper');
    if (existsSync(helper)) {
      try {
        chmodSync(helper, 0o755);
        console.log(`[fix-node-pty] +x ${helper}`);
      } catch (e) {
        console.warn(`[fix-node-pty] no pude chmod ${helper}: ${e.message}`);
      }
    }
  }
}
