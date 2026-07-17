// Caché LRU en memoria del TEXTO YA LIMPIO (salida del LLM de limpieza pre-TTS).
// Desacoplada la limpieza del TTS (endpoint /api/clean), un bloque de texto idéntico
// con el mismo modelo+prompt no debe re-llamar al LLM: es caro (tokens) y lento. En
// captura total (líneas/tablas/confirmaciones que se repiten) el ahorro es directo.
//
// Misma mecánica LRU que tts-cache.ts pero con valores string: acotada por nº de
// entradas y por total de caracteres (el que se alcance primero). El Map de JS
// conserva el orden de inserción, así que "tocar" una entrada = borrarla y
// re-insertarla al final; el más viejo queda primero (candidato a evicción).

const MAX_ENTRIES = 500;
const MAX_CHARS = 4 * 1024 * 1024; // ~4M caracteres

const store = new Map<string, string>();
let totalChars = 0;

/** Devuelve el texto limpio cacheado (marcándolo como reciente) o undefined. */
export function cleanCacheGet(key: string): string | undefined {
  const hit = store.get(key);
  if (hit === undefined) return undefined;
  store.delete(key); // re-insertar al final → queda como el más reciente
  store.set(key, hit);
  return hit;
}

/** Guarda un texto limpio, evictando los más viejos hasta respetar ambos topes. */
export function cleanCacheSet(key: string, clean: string): void {
  const prev = store.get(key);
  if (prev !== undefined) {
    totalChars -= prev.length; // reemplazo: descuenta los chars viejos
    store.delete(key);
  }
  store.set(key, clean);
  totalChars += clean.length;
  while (store.size > MAX_ENTRIES || totalChars > MAX_CHARS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    const e = store.get(oldest);
    if (e !== undefined) totalChars -= e.length;
    store.delete(oldest);
  }
}
