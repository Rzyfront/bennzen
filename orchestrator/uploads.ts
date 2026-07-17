// Adjuntar imágenes al chat con la estrategia "ruta-en-prompt": el cliente sube
// la imagen (base64), aquí la escribimos en un archivo temporal y devolvemos su
// ruta absoluta. Luego el cliente inyecta esa ruta en el prompt (say/term-input),
// que es como los CLIs con visión (Claude Code) reciben imágenes.
//
// Módulo puro y testeable: solo toca el sistema de archivos temporal; no conoce
// WebSockets ni el protocolo. El server (server.ts) lo cablea al mensaje
// 'upload-image' y a la limpieza de secciones.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** Raíz de todos los adjuntos temporales, bajo el tmpdir del sistema. */
const UPLOADS_ROOT = path.join(os.tmpdir(), 'bennzen-uploads');

/** Tope de tamaño por imagen (bytes ya decodificados): ~10 MB. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * MIME permitidos → extensión de archivo. La ruta real deriva SIEMPRE de aquí
 * (no del nombre del cliente), así que un MIME no listado se rechaza de plano.
 */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Reduce el `sectionId` (viene del cliente, NO es de fiar) a un segmento de ruta
 * seguro: solo [A-Za-z0-9_-]. Evita path traversal (`../`, rutas absolutas, etc.)
 * al construir el directorio del adjunto. Debe usarse igual en save y en cleanup.
 */
function safeSeg(sectionId: string): string {
  return sectionId.replace(/[^A-Za-z0-9_-]/g, '') || 'default';
}

/**
 * Guarda una imagen en un archivo temporal y devuelve su ruta absoluta.
 *
 * @param sectionId  sección a la que pertenece (aísla el directorio).
 * @param name       nombre original — SOLO para mostrar; NO se usa en la ruta.
 * @param mime       tipo MIME; debe estar en {png, jpeg, gif, webp}.
 * @param base64     contenido en base64 SIN el prefijo `data:...;base64,`.
 * @throws Error si el MIME no está permitido o la imagen supera el tope.
 */
export function saveImage(
  sectionId: string,
  name: string,
  mime: string,
  base64: string,
): { path: string } {
  const ext = MIME_EXT[mime];
  if (!ext) {
    throw new Error(
      `Tipo de imagen no soportado: ${mime}. Permitidos: PNG, JPEG, GIF, WebP.`,
    );
  }

  // Decodifica y valida tamaño ANTES de tocar el disco.
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_BYTES) {
    const mb = (buffer.length / (1024 * 1024)).toFixed(1);
    throw new Error(`Imagen demasiado grande: ${mb} MB (máximo 10 MB).`);
  }

  // Directorio por sección. El nombre real es un UUID + extensión del MIME:
  // ignoramos `name` del cliente para evitar path traversal (../, rutas, etc.).
  const dir = path.join(UPLOADS_ROOT, safeSeg(sectionId));
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(filePath, buffer);

  return { path: filePath };
}

/**
 * Borra recursivamente el directorio de una sección (al cerrarla). Ignora
 * errores: si no existe o falla el borrado, no es fatal.
 */
export function cleanupSection(sectionId: string): void {
  const dir = path.join(UPLOADS_ROOT, safeSeg(sectionId));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Directorio ausente o sin permisos — no es crítico, seguimos.
  }
}

/**
 * Barrido total al arrancar: borra `os.tmpdir()/bennzen-uploads` entero para no
 * arrastrar adjuntos de ejecuciones anteriores. Ignora errores.
 */
export function cleanupAllUploads(): void {
  try {
    fs.rmSync(UPLOADS_ROOT, { recursive: true, force: true });
  } catch {
    // Nada que limpiar o borrado fallido — irrelevante en el arranque.
  }
}
