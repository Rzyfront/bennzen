// Toast mínimo transitorio (Fase 5): avisos no bloqueantes bottom-right para
// acciones de espacios. Sin dependencias: apilado máx. 3 (la más vieja se
// descarta), auto-dismiss 3.5s, clic descarta antes.
const DISMISS_MS = 3500;
const MAX_STACK = 3;

let stack: HTMLElement | null = null;

function getStack(): HTMLElement {
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  return stack;
}

/** Muestra un aviso transitorio. `duration` ≤ 0 = persiste hasta clic. */
export function toast(msg: string, opts?: { duration?: number }): void {
  const host = getStack();
  while (host.children.length >= MAX_STACK) host.firstElementChild?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  const ms = opts?.duration ?? DISMISS_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const dismiss = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    el.remove();
  };
  el.addEventListener('click', dismiss);
  host.appendChild(el);
  if (ms > 0) timer = setTimeout(dismiss, ms);
}
