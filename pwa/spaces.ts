import type { AgentKind, PermMode, SectionKind } from '../shared/protocol';

// ---- Espacios: modelo de datos en localStorage (Fase 1) --------------------
// Patrón una-clave-por-concepto, versionadas. La clave legacy de orden global
// (`bennzen.section-order`) solo se lee para la migración y NUNCA se borra
// (downgrade seguro: la app vieja la sigue usando).

export const SPACES_KEY = 'bennzen.spaces.v1';
export const ACTIVE_SPACE_KEY = 'bennzen.active-space.v1';
export const SECTION_SPACE_KEY = 'bennzen.section-space.v1';
export const SECTION_CONFIG_KEY = 'bennzen.section-config.v1';
export const SECTION_ORDER_V1_KEY = 'bennzen.section-order.v1';
export const SPACE_ACTIVE_KEY = 'bennzen.space-active.v1';
/** Clave legacy (orden global): solo lectura para la migración, nunca se borra. */
export const LEGACY_ORDER_KEY = 'bennzen.section-order';

/** Vista «Todas» (default cuando no hay espacio activo). */
export const ALL_VIEW = 'all';
/** Bucket de orden para secciones sin espacio (destino de la migración legacy). */
export const UNASSIGNED_BUCKET = 'unassigned';

export interface Space {
  id: string;
  name: string;
  createdAt: number;
  /** Tono HSL elegido en la paleta (ausente = auto: el menos usado). */
  color?: number;
}

/** Datos mínimos para recrear una sesión fresca tras reinicio del orquestador. */
export interface SectionConfig {
  agent: AgentKind;
  mode: PermMode;
  kind: SectionKind;
  cwd: string;
  cols?: number;
  rows?: number;
}

/** Orden por bucket: bucket = spaceId | 'all' | 'unassigned'. */
export type SpaceOrders = Record<string, string[]>;
/** Membresía: sectionId → spaceId (ausente = sin espacio). */
export type SectionSpaceMap = Record<string, string>;
export type SectionConfigMap = Record<string, SectionConfig>;
/** Última sección activa por vista: spaceId | 'all' → sectionId. */
export type SpaceActiveMap = Record<string, string>;

// ---- Lectura defensiva (mismo patrón que main.ts) --------------------------

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function loadRecord<T>(key: string): Record<string, T> {
  const val = loadJson<unknown>(key, {});
  return typeof val === 'object' && val !== null && !Array.isArray(val)
    ? (val as Record<string, T>)
    : {};
}

function loadStringMap(key: string): Record<string, string> {
  const raw = loadRecord<unknown>(key);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

// ---- Espacios ---------------------------------------------------------------

export function loadSpaces(): Space[] {
  const val = loadJson<unknown>(SPACES_KEY, []);
  if (!Array.isArray(val)) return [];
  return val
    .filter(
      (s): s is Space =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as Space).id === 'string' &&
        (s as Space).id !== '' &&
        typeof (s as Space).name === 'string',
    )
    .map((s): Space => {
      const out: Space = { id: s.id, name: s.name, createdAt: s.createdAt };
      if (typeof s.color === 'number' && Number.isFinite(s.color)) {
        out.color = ((Math.round(s.color) % 360) + 360) % 360;
      }
      return out;
    });
}

export function saveSpaces(spaces: Space[]): void {
  localStorage.setItem(SPACES_KEY, JSON.stringify(spaces));
}

/**
 * Paleta pastel limitada: un tono suave por familia para que todos se vean
 * bien sobre el fondo oscuro (el tab los aplica apagados + anillo vivo).
 */
export const SPACE_PALETTE: readonly number[] = [350, 25, 42, 85, 150, 175, 200, 228, 265, 310];

/** Tono efectivo: el guardado si es válido, si no el menos usado de la paleta. */
export function resolveSpaceColor(space: Space, all: Space[]): number {
  if (typeof space.color === 'number' && Number.isFinite(space.color)) {
    return ((Math.round(space.color) % 360) + 360) % 360;
  }
  const used = new Map<number, number>();
  for (const s of all) {
    if (typeof s.color === 'number' && Number.isFinite(s.color)) {
      const h = ((Math.round(s.color) % 360) + 360) % 360;
      used.set(h, (used.get(h) ?? 0) + 1);
    }
  }
  let h = 0;
  for (let i = 0; i < space.id.length; i++) h = (h * 31 + space.id.charCodeAt(i)) >>> 0;
  const start = h % SPACE_PALETTE.length;
  let best = SPACE_PALETTE[start];
  let bestUsed = used.get(best) ?? 0;
  for (let k = 1; k < SPACE_PALETTE.length; k++) {
    const cand = SPACE_PALETTE[(start + k) % SPACE_PALETTE.length];
    const u = used.get(cand) ?? 0;
    if (u < bestUsed) {
      best = cand;
      bestUsed = u;
    }
  }
  return best;
}

// ---- Espacio activo ----------------------------------------------------------

export function loadActiveSpace(): string {
  const val = loadJson<unknown>(ACTIVE_SPACE_KEY, ALL_VIEW);
  return typeof val === 'string' && val !== '' ? val : ALL_VIEW;
}

export function saveActiveSpace(spaceId: string): void {
  localStorage.setItem(ACTIVE_SPACE_KEY, JSON.stringify(spaceId));
}

// ---- Membresía sección → espacio ----------------------------------------------

export function loadSectionSpace(): SectionSpaceMap {
  return loadStringMap(SECTION_SPACE_KEY);
}

export function saveSectionSpace(map: SectionSpaceMap): void {
  localStorage.setItem(SECTION_SPACE_KEY, JSON.stringify(map));
}

/** Espacio de una sección (`undefined` = sin espacio, visible solo en «Todas»). */
export function getSpaceOf(
  sectionId: string,
  map: SectionSpaceMap = loadSectionSpace(),
): string | undefined {
  return map[sectionId];
}

/** Asigna una sección a un espacio; `null`/`undefined` la deja sin espacio. */
export function setSpaceOf(sectionId: string, spaceId: string | null | undefined): void {
  const map = loadSectionSpace();
  if (spaceId) map[sectionId] = spaceId;
  else delete map[sectionId];
  saveSectionSpace(map);
}

/** Olvida la membresía de una sección (al cerrarla con ✕). */
export function removeSpaceOf(sectionId: string): void {
  setSpaceOf(sectionId, undefined);
}

// ---- Config restaurable por sección --------------------------------------------

function isSectionConfig(v: unknown): v is SectionConfig {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.agent === 'string' &&
    typeof c.mode === 'string' &&
    (c.kind === 'rpc' || c.kind === 'pty') &&
    typeof c.cwd === 'string'
  );
}

export function loadSectionConfigs(): SectionConfigMap {
  const raw = loadRecord<unknown>(SECTION_CONFIG_KEY);
  const out: SectionConfigMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isSectionConfig(v)) out[k] = v;
  }
  return out;
}

export function saveSectionConfigs(map: SectionConfigMap): void {
  localStorage.setItem(SECTION_CONFIG_KEY, JSON.stringify(map));
}

/** Crea o refresca la config de una sección (createSection + cada snapshot). */
export function saveSectionConfig(sectionId: string, config: SectionConfig): void {
  const map = loadSectionConfigs();
  map[sectionId] = config;
  saveSectionConfigs(map);
}

/** Purga la config guardada. Solo la llama closeSection() (cierre explícito). */
export function removeSectionConfig(sectionId: string): void {
  const map = loadSectionConfigs();
  if (map[sectionId] === undefined) return;
  delete map[sectionId];
  saveSectionConfigs(map);
}

/** Purga conjunta al cerrar con ✕: config restaurable + membresía del id. */
export function purgeSectionData(sectionId: string): void {
  removeSectionConfig(sectionId);
  removeSpaceOf(sectionId);
}

/**
 * IDs restaurables: configs guardadas cuyos IDs no están vivos en el servidor.
 * `vivos` = IDs presentes en el último snapshot.
 */
export function getRestorableIds(vivos: Iterable<string>): string[] {
  const alive = new Set(vivos);
  return Object.keys(loadSectionConfigs()).filter((id) => !alive.has(id));
}

// ---- Orden por bucket + migración legacy ---------------------------------------

export function loadSpaceOrders(): SpaceOrders {
  migrateLegacyOrderOnce();
  const raw = loadRecord<unknown>(SECTION_ORDER_V1_KEY);
  const out: SpaceOrders = {};
  for (const [bucket, ids] of Object.entries(raw)) {
    if (Array.isArray(ids)) out[bucket] = ids.filter((id): id is string => typeof id === 'string');
  }
  return out;
}

export function saveSpaceOrders(orders: SpaceOrders): void {
  localStorage.setItem(SECTION_ORDER_V1_KEY, JSON.stringify(orders));
}

export function getOrderBucket(bucket: string): string[] {
  return loadSpaceOrders()[bucket] ?? [];
}

export function saveOrderBucket(bucket: string, ids: string[]): void {
  const orders = loadSpaceOrders();
  orders[bucket] = [...ids];
  saveSpaceOrders(orders);
}

/**
 * Migración one-time del orden global legacy al bucket `unassigned`.
 * Idempotente: si la clave v1 ya existe no hace nada. La clave legacy NO se
 * borra (downgrade seguro). Devuelve true si migró en esta llamada.
 */
export function migrateLegacyOrderOnce(): boolean {
  try {
    if (localStorage.getItem(SECTION_ORDER_V1_KEY) !== null) return false;
    const legacy = loadJson<unknown>(LEGACY_ORDER_KEY, []);
    const ids = Array.isArray(legacy)
      ? legacy.filter((id): id is string => typeof id === 'string')
      : [];
    const orders: SpaceOrders = { [UNASSIGNED_BUCKET]: ids };
    localStorage.setItem(SECTION_ORDER_V1_KEY, JSON.stringify(orders));
    return true;
  } catch {
    return false;
  }
}

// Se ejecuta al importar el módulo: recargar con datos legacy migra sin pérdida.
migrateLegacyOrderOnce();

// ---- Última sección activa por vista --------------------------------------------

export function loadSpaceActive(): SpaceActiveMap {
  return loadStringMap(SPACE_ACTIVE_KEY);
}

export function saveSpaceActive(map: SpaceActiveMap): void {
  localStorage.setItem(SPACE_ACTIVE_KEY, JSON.stringify(map));
}

export function getSpaceActive(view: string): string | undefined {
  return loadSpaceActive()[view];
}

export function setSpaceActive(view: string, sectionId: string): void {
  const map = loadSpaceActive();
  map[view] = sectionId;
  saveSpaceActive(map);
}
