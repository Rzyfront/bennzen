// Sistema de partículas ambientales para el estado vacío (sin sección activa).
// - Partículas solitarias en el espacio (sin conexiones entre ellas).
// - Animación de succión/vórtice hacia el centro (~3s) simulando que algo se las traga.
// - Animación de emergencia desde el centro cuando se cierra la última sección.

const COLOR = '199, 210, 254';       // índigo/hielo cristalino (coherente con el logo y el orbe)
const COLOR_BRIGHT = '255, 255, 255'; // blanco puro radiante
const COUNT = 60;                     // número de partículas solitarias
const BASE_SPEED = 0.00032;           // velocidad de vagabundeo normalizada
const COLLAPSE_DURATION = 1000;       // ms para la succión (1.0s exacto)
const EXPAND_DURATION = 1000;         // ms para la emergencia y dispersión (1.0s exacto)

type AnimPhase = 'idle' | 'collapsing' | 'expanding';

interface Dot {
  x: number;          // posición normalizada 0..1
  y: number;
  vx: number;         // velocidad de vagabundeo
  vy: number;
  r: number;          // radio base en px CSS
  phase: number;      // fase para destello/twinkle
  // Variables para la animación de colapso/expansión
  ox: number;         // origen
  oy: number;
  dist0: number;      // distancia inicial al centro (0.5, 0.5)
  angle0: number;     // ángulo inicial relativo al centro
  swirl: number;      // sentido y magnitud de giro
  destDist: number;   // distancia objetivo en expansión
  destAngle: number;  // ángulo objetivo en expansión
}

export class LogParticles {
  private ctx: CanvasRenderingContext2D;
  private dots: Dot[] = [];
  private w = 0;
  private h = 0;
  private dpr = 1;
  private raf = 0;
  private phase: AnimPhase = 'idle';
  private animStart = 0;
  private alive = true;
  private opacity = 1;
  private t = 0;
  private onCollapseEnd?: () => void;
  private onExpandEnd?: () => void;
  private container: HTMLElement;
  private _ro: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement, container?: HTMLElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d no disponible');
    this.ctx = ctx;
    this.container = container || (canvas.parentElement as HTMLElement) || document.body;
    canvas.hidden = false;
    this.resize();
    this.seed();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.container);
    this._ro.observe(this.canvas);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose(): void {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this._ro.disconnect();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.hidden = true;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  // ─── Animaciones ──────────────────────────────────────────────────

  /**
   * Succión hacia el centro (~3 segundos).
   * Las partículas aceleran y espiralan hacia la singularidad central como
   * si algo en el medio se las tragara. Retorna una promesa al concluir.
   */
  collapse(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.alive) { resolve(); return; }
      this.phase = 'collapsing';
      this.animStart = performance.now();
      this.onCollapseEnd = resolve;

      for (const d of this.dots) {
        d.ox = d.x;
        d.oy = d.y;
        const dx = d.x - 0.5;
        const dy = d.y - 0.5;
        d.dist0 = Math.hypot(dx, dy);
        d.angle0 = Math.atan2(dy, dx);
        // Factor de giro espiral: proporcional a la distancia con sentido armónico
        d.swirl = (d.x > 0.5 ? 1 : -1) * (1.8 + Math.random() * 2.2);
      }
    });
  }

  /**
   * Emergencia desde el centro de todo (~2.4s).
   * Al cerrar la última sección, todas las partículas nacen del centro
   * y se expanden radialmente hacia el espacio exterior hasta repoblarlo.
   */
  expand(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.alive) { resolve(); return; }
      this.phase = 'expanding';
      this.animStart = performance.now();
      this.opacity = 0;
      this.onExpandEnd = resolve;

      for (let i = 0; i < this.dots.length; i++) {
        const d = this.dots[i];
        d.ox = 0.5;
        d.oy = 0.5;
        d.x = 0.5;
        d.y = 0.5;
        // Distribución radial alrededor del centro
        const angle = (i / this.dots.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
        const dist = 0.08 + Math.random() * 0.42;
        d.destAngle = angle;
        d.destDist = dist;
        d.swirl = (Math.random() - 0.5) * 1.5;

        // Nuevas velocidades residuales para cuando termine de expandirse
        const dir = Math.random() * Math.PI * 2;
        const speed = BASE_SPEED * (0.8 + Math.random() * 1.2);
        d.vx = Math.cos(dir) * speed;
        d.vy = Math.sin(dir) * speed;
      }
    });
  }

  // ─── Internos ─────────────────────────────────────────────────────

  private seed(): void {
    this.dots = [];
    for (let i = 0; i < COUNT; i++) {
      const dir = Math.random() * Math.PI * 2;
      const speed = BASE_SPEED * (0.7 + Math.random() * 1.3);
      const isLarge = Math.random() < 0.18;
      this.dots.push({
        x: 0.04 + Math.random() * 0.92,
        y: 0.04 + Math.random() * 0.92,
        vx: Math.cos(dir) * speed,
        vy: Math.sin(dir) * speed,
        r: isLarge ? 1.6 + Math.random() * 1.1 : 0.65 + Math.random() * 0.75,
        phase: Math.random() * Math.PI * 2,
        ox: 0.5,
        oy: 0.5,
        dist0: 0,
        angle0: 0,
        swirl: 1,
        destDist: 0,
        destAngle: 0,
      });
    }
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.w = Math.max(30, Math.round(rect.width || this.container.clientWidth || this.canvas.clientWidth || 0));
    this.h = Math.max(30, Math.round(rect.height || this.container.clientHeight || this.canvas.clientHeight || 0));
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  private loop(): void {
    if (!this.alive) return;
    this.t++;
    this.update();
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  }

  private update(): void {
    const now = performance.now();

    // 1. Fase de succión / "algo se las traga en el medio"
    if (this.phase === 'collapsing') {
      const elapsed = now - this.animStart;
      const progress = Math.min(1, elapsed / COLLAPSE_DURATION);

      // Succión no-lineal: arranca suave con atracción gravitacional y acelera con fuerza al final
      const easePull = Math.pow(progress, 2.2);

      // Desvanecimiento suave en el tramo final cuando ya han entrado al vórtice
      this.opacity = progress < 0.82 ? 1 : Math.max(0, 1 - (progress - 0.82) / 0.18);

      for (const d of this.dots) {
        // Radio hacia el centro disminuyendo con aceleración
        const curDist = Math.max(0, d.dist0 * (1 - easePull));
        // Aceleración angular espiral (efecto remolino / agujero negro)
        const angle = d.angle0 + d.swirl * (easePull * 4.2 + 0.1 / (curDist + 0.05));

        d.x = 0.5 + Math.cos(angle) * curDist;
        d.y = 0.5 + Math.sin(angle) * curDist;
      }

      if (progress >= 1) {
        this.phase = 'idle';
        this.opacity = 0;
        this.onCollapseEnd?.();
        this.onCollapseEnd = undefined;
      }
      return;
    }

    // 2. Fase de emergencia / brote desde el centro
    if (this.phase === 'expanding') {
      const elapsed = now - this.animStart;
      const progress = Math.min(1, elapsed / EXPAND_DURATION);

      // Expansión explosiva con desaceleración elástica (ease-out cubic)
      const easeOut = 1 - Math.pow(1 - progress, 3);

      // Aparecen rápidamente en el primer 20%
      this.opacity = progress < 0.25 ? progress / 0.25 : 1;

      for (const d of this.dots) {
        const curDist = d.destDist * easeOut;
        const angle = d.destAngle + d.swirl * (1 - easeOut) * 1.5;

        d.x = 0.5 + Math.cos(angle) * curDist;
        d.y = 0.5 + Math.sin(angle) * curDist;
      }

      if (progress >= 1) {
        this.phase = 'idle';
        this.opacity = 1;
        this.onExpandEnd?.();
        this.onExpandEnd = undefined;
      }
      return;
    }

    // 3. Fase idle: partículas solitarias vagando libremente por todo el espacio
    this.opacity = 1;
    for (const d of this.dots) {
      d.x += d.vx;
      d.y += d.vy;

      // Rebote suave en los límites
      if (d.x < 0.03) { d.x = 0.03; d.vx = Math.abs(d.vx); }
      else if (d.x > 0.97) { d.x = 0.97; d.vx = -Math.abs(d.vx); }
      if (d.y < 0.03) { d.y = 0.03; d.vy = Math.abs(d.vy); }
      else if (d.y > 0.97) { d.y = 0.97; d.vy = -Math.abs(d.vy); }
    }
  }

  private draw(): void {
    const { ctx, dpr } = this;
    const W = this.w * dpr;
    const H = this.h * dpr;
    ctx.clearRect(0, 0, W, H);

    if (this.opacity <= 0.001) return;

    const alpha = this.opacity;
    const cx = W / 2;
    const cy = H / 2;

    // ── Vórtice / singularidad en el centro durante la succión ───────
    if (this.phase === 'collapsing') {
      const now = performance.now();
      const progress = Math.min(1, (now - this.animStart) / COLLAPSE_DURATION);

      // Resplandor del núcleo vórtice que se las traga
      const coreIntensity = progress < 0.85
        ? Math.sin(progress * Math.PI * 0.9)
        : 1 - (progress - 0.85) / 0.15;

      const vortexR = Math.min(W, H) * (0.04 + 0.16 * coreIntensity);

      // Halo de atracción gravitacional
      const gVortex = ctx.createRadialGradient(cx, cy, 0, cx, cy, vortexR * 2.2);
      gVortex.addColorStop(0, `rgba(${COLOR_BRIGHT}, ${0.35 * coreIntensity * alpha})`);
      gVortex.addColorStop(0.3, `rgba(${COLOR}, ${0.2 * coreIntensity * alpha})`);
      gVortex.addColorStop(0.7, `rgba(${COLOR}, ${0.05 * coreIntensity * alpha})`);
      gVortex.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = gVortex;
      ctx.beginPath();
      ctx.arc(cx, cy, vortexR * 2.2, 0, Math.PI * 2);
      ctx.fill();

      // Disco de acreción giratorio en el centro
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(progress * 14);
      ctx.strokeStyle = `rgba(${COLOR_BRIGHT}, ${0.45 * coreIntensity * alpha})`;
      ctx.lineWidth = 1.8 * dpr;
      ctx.beginPath();
      ctx.arc(0, 0, vortexR * 0.45, 0, Math.PI * 1.6);
      ctx.stroke();
      ctx.restore();

      // Centro de succión oscuro ("se las traga")
      if (progress > 0.25 && progress < 0.92) {
        ctx.fillStyle = `rgba(15, 17, 26, ${0.85 * coreIntensity * alpha})`;
        ctx.beginPath();
        ctx.arc(cx, cy, vortexR * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── Onda de choque expansiva al emerger del centro ──────────────
    if (this.phase === 'expanding') {
      const now = performance.now();
      const progress = Math.min(1, (now - this.animStart) / EXPAND_DURATION);
      if (progress < 0.6) {
        const ringT = progress / 0.6;
        const ringR = Math.min(W, H) * 0.45 * ringT;
        const ringAlpha = (1 - ringT) * alpha;

        ctx.strokeStyle = `rgba(${COLOR}, ${0.38 * ringAlpha})`;
        ctx.lineWidth = (3 - ringT * 2) * dpr;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
        ctx.stroke();

        // Destello central al nacer
        const gFlash = ctx.createRadialGradient(cx, cy, 0, cx, cy, ringR * 0.5);
        gFlash.addColorStop(0, `rgba(${COLOR_BRIGHT}, ${0.5 * ringAlpha})`);
        gFlash.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = gFlash;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── Resplandor ambiental de fondo ───────────────────────────────
    const ambientR = Math.min(W, H) * 0.45;
    const gAmbient = ctx.createRadialGradient(cx, cy, 0, cx, cy, ambientR);
    gAmbient.addColorStop(0, `rgba(${COLOR}, ${0.03 * alpha})`);
    gAmbient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gAmbient;
    ctx.fillRect(0, 0, W, H);

    // ── Partículas solitarias (sin conexiones entre ellas) ──────────
    for (const d of this.dots) {
      const px = d.x * W;
      const py = d.y * H;
      // Destello suave individual
      const twinkle = 1 + 0.22 * Math.sin(this.t * 0.05 + d.phase);
      const r = d.r * dpr * twinkle;

      // Halo exterior suave difuso
      ctx.fillStyle = `rgba(${COLOR}, ${0.16 * alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, r * 4.2, 0, Math.PI * 2);
      ctx.fill();

      // Halo intermedio
      ctx.fillStyle = `rgba(${COLOR}, ${0.38 * alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, r * 2.1, 0, Math.PI * 2);
      ctx.fill();

      // Núcleo luminoso radiante blanco puro
      ctx.fillStyle = `rgba(${COLOR_BRIGHT}, ${0.95 * alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
