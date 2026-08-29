import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type http from 'node:http';
import type { ProjectConfig } from '../shared/protocol';

const execFileAsync = promisify(execFile);
const PROJECTS_FILE = path.resolve(process.cwd(), '.projects.json');

/** Abre el explorador de archivos nativo del SO (Finder en macOS, Explorer en Windows, Zenity/Kdialog en Linux). */
export async function openNativeDirectoryPicker(): Promise<{
  path: string | null;
  name?: string;
  cancelled: boolean;
  error?: string;
}> {
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      // macOS: Usamos execFile con sentencias AppleScript limpias
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        'set chosenFolder to (choose folder with prompt "Selecciona la carpeta de tu proyecto Bennzen:")',
        '-e',
        'POSIX path of chosenFolder',
      ]);
      const chosen = stdout ? stdout.trim() : '';
      if (!chosen) return { path: null, cancelled: true };
      const normalized = chosen.endsWith('/') && chosen.length > 1 ? chosen.slice(0, -1) : chosen;
      const name = path.basename(normalized);
      return { path: normalized, name, cancelled: false };
    } else if (platform === 'win32') {
      // Windows PowerShell FolderBrowserDialog
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = "Selecciona la carpeta de tu proyecto Bennzen"
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          $dialog.SelectedPath
        }
      `;
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', psScript]);
      const chosen = stdout ? stdout.trim() : '';
      if (!chosen) return { path: null, cancelled: true };
      const normalized = chosen.endsWith('\\') && chosen.length > 3 ? chosen.slice(0, -1) : chosen;
      const name = path.basename(normalized);
      return { path: normalized, name, cancelled: false };
    } else {
      // Linux: Zenity / Kdialog
      try {
        const { stdout } = await execFileAsync('zenity', [
          '--file-selection',
          '--directory',
          '--title=Selecciona la carpeta de tu proyecto Bennzen',
        ]);
        const chosen = stdout ? stdout.trim() : '';
        if (chosen) return { path: chosen, name: path.basename(chosen), cancelled: false };
      } catch {
        try {
          const { stdout } = await execFileAsync('kdialog', [
            '--getexistingdirectory',
            '~',
            'Selecciona la carpeta de tu proyecto Bennzen',
          ]);
          const chosen = stdout ? stdout.trim() : '';
          if (chosen) return { path: chosen, name: path.basename(chosen), cancelled: false };
        } catch {
          return { path: null, cancelled: false, error: 'No se encontró zenity ni kdialog para abrir el diálogo del sistema.' };
        }
      }
      return { path: null, cancelled: true };
    }
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    if (
      err?.code === 1 ||
      msg.includes('User canceled') ||
      msg.includes('user cancel') ||
      msg.includes('-128')
    ) {
      return { path: null, cancelled: true };
    }
    console.warn('[fs-picker] Error al abrir explorador del SO:', err);
    return { path: null, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Convierte un nombre arbitrario en un slug seguro para ID de proyecto. */
export function slugifyProjectId(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `project-${Date.now().toString(36)}`;
}

/** Carga los proyectos guardados. Inicializa con Bennzen si no existe. */
export function loadProjects(): ProjectConfig[] {
  if (!fs.existsSync(PROJECTS_FILE)) {
    // Inicialización por defecto: el proyecto actual
    const defaultProject: ProjectConfig = {
      id: 'bennzen',
      name: 'Bennzen (Proyecto actual)',
      path: process.cwd(),
      tag: 'Principal',
      createdAt: Date.now(),
    };
    try {
      fs.writeFileSync(PROJECTS_FILE, JSON.stringify([defaultProject], null, 2), 'utf-8');
      return [defaultProject];
    } catch {
      return [defaultProject];
    }
  }

  try {
    const raw = fs.readFileSync(PROJECTS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ProjectConfig[];
    return [];
  } catch (err) {
    console.warn('[projects] Error leyendo .projects.json:', err);
    return [];
  }
}

/** Guarda o actualiza un proyecto. */
export function saveProject(
  config: Partial<ProjectConfig> & { name: string; path: string },
): ProjectConfig {
  const projects = loadProjects();
  const id = config.id?.trim() || slugifyProjectId(config.name);

  // Resuelve tilde '~' y normaliza la ruta absoluta
  let resolvedPath = config.path.trim();
  if (resolvedPath.startsWith('~')) {
    resolvedPath = path.join(os.homedir(), resolvedPath.slice(1));
  } else if (!path.isAbsolute(resolvedPath)) {
    resolvedPath = path.resolve(process.cwd(), resolvedPath);
  }

  const project: ProjectConfig = {
    id,
    name: config.name.trim(),
    path: resolvedPath,
    tag: config.tag?.trim() || undefined,
    createdAt: config.createdAt || Date.now(),
  };

  const idx = projects.findIndex((p) => p.id === id);
  if (idx >= 0) {
    projects[idx] = project;
  } else {
    projects.push(project);
  }

  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf-8');
  console.log(`[projects] Proyecto guardado: ${project.name} (${project.id}) → ${project.path}`);
  return project;
}

/** Elimina un proyecto por ID. */
export function deleteProject(id: string): boolean {
  const projects = loadProjects();
  const filtered = projects.filter((p) => p.id !== id);
  if (filtered.length === projects.length) return false;

  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(filtered, null, 2), 'utf-8');
  console.log(`[projects] Proyecto eliminado: ${id}`);
  return true;
}

/** Explora subdirectorios del host para autocompletado o navegación de carpetas. */
export function listDirectories(targetDir?: string): {
  current: string;
  parent: string | null;
  exists: boolean;
  dirs: string[];
} {
  let dir = targetDir?.trim() || process.cwd();
  if (dir.startsWith('~')) {
    dir = path.join(os.homedir(), dir.slice(1));
  } else if (!path.isAbsolute(dir)) {
    dir = path.resolve(process.cwd(), dir);
  }

  if (!fs.existsSync(dir)) {
    return {
      current: dir,
      parent: path.dirname(dir),
      exists: false,
      dirs: [],
    };
  }

  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      return {
        current: dir,
        parent: path.dirname(dir),
        exists: true,
        dirs: [],
      };
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const parent = path.dirname(dir);
    return {
      current: dir,
      parent: parent !== dir ? parent : null,
      exists: true,
      dirs,
    };
  } catch (err) {
    console.warn(`[projects] No se pudo leer directorio ${dir}:`, err);
    return {
      current: dir,
      parent: path.dirname(dir),
      exists: false,
      dirs: [],
    };
  }
}

function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin ?? '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-voice-*',
  };
}

function sendJson(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...corsHeaders(req),
  });
  res.end(payload);
}

/** Handler HTTP REST para /api/projects y /api/fs/directories */
export async function handleProjectsHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return true;
  }

  // 1. Selector nativo de carpetas del SO
  if (pathname === '/api/fs/pick-directory' && req.method === 'POST') {
    const result = await openNativeDirectoryPicker();
    sendJson(req, res, 200, result);
    return true;
  }

  // 2. Exploración de directorios locales
  if (pathname === '/api/fs/directories' && req.method === 'GET') {
    const dirQuery = url.searchParams.get('dir') || undefined;
    const result = listDirectories(dirQuery);
    sendJson(req, res, 200, result);
    return true;
  }

  // 3. Listado de proyectos
  if (pathname === '/api/projects' && req.method === 'GET') {
    const projects = loadProjects();
    sendJson(req, res, 200, projects);
    return true;
  }

  // 4. Crear / actualizar proyecto
  if (pathname === '/api/projects' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') {
      sendJson(req, res, 400, { error: 'Body JSON requerido' });
      return true;
    }

    const payload = body as Partial<ProjectConfig> & { name?: string; path?: string };
    if (!payload.name?.trim() || !payload.path?.trim()) {
      sendJson(req, res, 400, { error: 'Nombre y Ruta de directorio son obligatorios' });
      return true;
    }

    try {
      const saved = saveProject({
        id: payload.id,
        name: payload.name,
        path: payload.path,
        tag: payload.tag,
      });
      sendJson(req, res, 200, saved);
    } catch (err) {
      sendJson(req, res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // 5. Eliminar proyecto: DELETE /api/projects/:id
  const deleteMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(deleteMatch[1]);
    const deleted = deleteProject(id);
    if (!deleted) {
      sendJson(req, res, 404, { error: `Proyecto '${id}' no encontrado` });
      return true;
    }
    sendJson(req, res, 200, { ok: true });
    return true;
  }

  return false;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 512 * 1024) {
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
