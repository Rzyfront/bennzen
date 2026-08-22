// Halo y constelación de partículas de BENNZEN.
// Soporta tanto el modo circular (orbe normal) como el modo columna vertical
// (cuando el panel de voz se minimiza a 55px).

const GOLD = '199, 210, 254'; // color cristalino índigo/hielo del logo
const GOLD_BRIGHT = '255, 255, 255'; // blanco puro radiante
const COUNT = 40; // partículas
const LINK = 0.34; // distancia de enlace en modo circular
const MAX_R = 0.47; // radio de confinamiento (disco) en modo circular

interface Particle {
  x: number; // 0..1 (normalizado)
  y: number; // 0..1 (normalizado)
  vx: number;
  vy: number;
  r: number; // radio base en px CSS
}

export class OrbParticles {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ps: Particle[] = [];
  private energy = 0; // suavizada 0..~1.5
  private w = 0;
  private h = 0;
  private isColumn = false;
  private dpr = 1;
  private raf = 0;
  private t = 0;

  constructor(private orb: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'orb-canvas';
    orb.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d no disponible');
    this.ctx = ctx;
    this.resize();
    this.seed();
    new ResizeObserver(() => this.resize()).observe(orb);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  private seed(): void {
    this.ps = [];
    for (let i = 0; i < COUNT; i++) {
      const dir = Math.random() * Math.PI * 2;
      const speed = 0.0004 + Math.random() * 0.0007;
      const big = Math.random() < 0.18;

      if (this.isColumn) {
        this.ps.push({
          x: 0.08 + Math.random() * 0.84,
          y: 0.02 + Math.random() * 0.96,
          vx: Math.cos(dir) * speed * 0.7,
          vy: Math.sin(dir) * speed * 1.4,
          r: big ? 1.8 + Math.random() * 1.2 : 0.7 + Math.random() * 0.9,
        });
      } else {
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.sqrt(Math.random()) * (MAX_R - 0.02);
        this.ps.push({
          x: 0.5 + Math.cos(ang) * rad,
          y: 0.5 + Math.sin(ang) * rad,
          vx: Math.cos(dir) * speed,
          vy: Math.sin(dir) * speed,
          r: big ? 2.0 + Math.random() * 1.4 : 0.8 + Math.random() * 1.0,
        });
      }
    }
  }

  private resize(): void {
    this.w = Math.max(30, this.orb.clientWidth || 0);
    this.h = Math.max(30, this.orb.clientHeight || 0);
    const wasColumn = this.isColumn;
    this.isColumn = this.w < 120 && this.h > 120;
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;

    if (wasColumn !== this.isColumn || this.ps.length === 0) {
      this.seed();
    }
  }

  private targetEnergy(): number {
    const cls = this.orb.classList;
    if (cls.contains('listening')) {
      const lvl = parseFloat(this.orb.style.getPropertyValue('--level')) || 0;
      return 0.25 + lvl * 1.6;
    }
    if (cls.contains('speaking')) {
      const lvl = parseFloat(this.orb.style.getPropertyValue('--level')) || 0;
      if (lvl > 0.01) return 0.3 + lvl * 1.8;
      return 0.5 + Math.sin(this.t * 0.18) * 0.14;
    }
    return 0;
  }

  private loop(): void {
    this.t++;
    const target = this.targetEnergy();
    this.energy += (target - this.energy) * 0.12;
    this.step();
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  }

  private step(): void {
    const e = this.energy;
    const speedMul = 0.5 + e * 5.5;
    const jitter = e * 0.0016;

    if (this.isColumn) {
      for (const p of this.ps) {
        p.x += p.vx * speedMul + (Math.random() - 0.5) * jitter;
        p.y += p.vy * speedMul + (Math.random() - 0.5) * jitter;

        // Rebote en bordes horizontales
        if (p.x < 0.08) {
          p.x = 0.08;
          p.vx = Math.abs(p.vx);
        } else if (p.x > 0.92) {
          p.x = 0.92;
          p.vx = -Math.abs(p.vx);
        }

        // Rebote en bordes verticales
        if (p.y < 0.02) {
          p.y = 0.02;
          p.vy = Math.abs(p.vy);
        } else if (p.y > 0.98) {
          p.y = 0.98;
          p.vy = -Math.abs(p.vy);
        }
      }
    } else {
      for (const p of this.ps) {
        p.x += p.vx * speedMul + (Math.random() - 0.5) * jitter;
        p.y += p.vy * speedMul + (Math.random() - 0.5) * jitter;
        const dx = p.x - 0.5;
        const dy = p.y - 0.5;
        const d = Math.hypot(dx, dy);
        if (d > MAX_R) {
          const nx = dx / d;
          const ny = dy / d;
          const dot = p.vx * nx + p.vy * ny;
          p.vx -= 2 * dot * nx;
          p.vy -= 2 * dot * ny;
          p.x = 0.5 + nx * MAX_R;
          p.y = 0.5 + ny * MAX_R;
        }
      }
    }
  }

  private draw(): void {
    const { ctx, dpr } = this;
    const W = this.w * dpr;
    const H = this.h * dpr;
    ctx.clearRect(0, 0, W, H);
    const e = this.energy;

    if (this.isColumn) {
      // Glow ambiental suave a lo largo de la columna
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(0, 0, 0, 0)');
      g.addColorStop(0.5, `rgba(${GOLD}, ${0.03 + e * 0.12})`);
      g.addColorStop(1, `rgba(${GOLD_BRIGHT}, ${0.07 + e * 0.22})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // Líneas de la constelación
      const linkDist = 58 * dpr;
      ctx.lineWidth = dpr * 0.75;
      for (let i = 0; i < this.ps.length; i++) {
        const a = this.ps[i];
        const ax = a.x * W;
        const ay = a.y * H;
        for (let j = i + 1; j < this.ps.length; j++) {
          const b = this.ps[j];
          const bx = b.x * W;
          const by = b.y * H;
          const d = Math.hypot(ax - bx, ay - by);
          if (d < linkDist) {
            const o = (1 - d / linkDist) * (0.07 + e * 0.45);
            ctx.strokeStyle = `rgba(${GOLD}, ${o})`;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          }
        }
      }

      // Estrellas / partículas
      const bright = 0.55 + e * 0.45;
      for (const p of this.ps) {
        const px = p.x * W;
        const py = p.y * H;
        const r = p.r * dpr * (1 + e * 0.45);
        ctx.fillStyle = `rgba(${GOLD_BRIGHT}, ${0.08 + e * 0.18})`;
        ctx.beginPath();
        ctx.arc(px, py, r * 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(${GOLD_BRIGHT}, ${bright})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Modo circular normal
      const s = Math.min(W, H);
      const cx = W / 2;
      const cy = H / 2;
      const coreR = s * (0.1 + e * 0.1);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3.6);
      g.addColorStop(0, `rgba(${GOLD_BRIGHT}, ${0.32 + e * 0.45})`);
      g.addColorStop(0.4, `rgba(${GOLD}, ${0.1 + e * 0.2})`);
      g.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      const link = LINK * s;
      ctx.lineWidth = dpr * 0.8;
      for (let i = 0; i < this.ps.length; i++) {
        const a = this.ps[i];
        const ax = cx + (a.x - 0.5) * s;
        const ay = cy + (a.y - 0.5) * s;
        for (let j = i + 1; j < this.ps.length; j++) {
          const b = this.ps[j];
          const bx = cx + (b.x - 0.5) * s;
          const by = cy + (b.y - 0.5) * s;
          const d = Math.hypot(ax - bx, ay - by);
          if (d < link) {
            const o = (1 - d / link) * (0.08 + e * 0.5);
            ctx.strokeStyle = `rgba(${GOLD}, ${o})`;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          }
        }
      }

      const bright = 0.5 + e * 0.5;
      for (const p of this.ps) {
        const px = cx + (p.x - 0.5) * s;
        const py = cy + (p.y - 0.5) * s;
        const r = p.r * dpr * (1 + e * 0.5);
        ctx.fillStyle = `rgba(${GOLD_BRIGHT}, ${0.08 + e * 0.16})`;
        ctx.beginPath();
        ctx.arc(px, py, r * 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(${GOLD_BRIGHT}, ${bright})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
