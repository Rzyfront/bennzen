// Halo de partículas (constelación) para el orbe de voz de BENNZEN.
//
// Reemplaza el halo CSS estático por un campo de partículas DORADAS (color de
// marca) que se conectan con líneas finas —como una constelación— y se AGITAN
// con la voz: en reposo derivan lento; al escuchar (mic) o hablar (TTS) suben
// de energía → más velocidad, más brillo y un núcleo pulsante (eco del centro
// del logo BENNZEN).
//
// Desacople: el componente LEE el estado del propio #orb (la clase
// `listening`/`speaking` y la variable CSS `--level` que ya alimenta MicMeter),
// así no toca la lógica de voz de main.ts. Solo hay que instanciarlo una vez.

const GOLD = '216, 184, 115'; // --accent
const GOLD_BRIGHT = '245, 228, 182'; // --accent-bright
const COUNT = 38; // partículas
const LINK = 0.34; // distancia de enlace (fracción del lado del lienzo)
const MAX_R = 0.47; // radio de confinamiento (disco) en espacio normalizado

interface Particle {
  x: number; // 0..1 (fracción del lado)
  y: number;
  vx: number;
  vy: number;
  r: number; // radio base en px CSS
}

export class OrbParticles {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ps: Particle[] = [];
  private energy = 0; // suavizada 0..~1.5
  private size = 0; // lado del lienzo en px CSS
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
    this.seed();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(orb);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  /** Distribuye las partículas dentro del disco con velocidades suaves. */
  private seed(): void {
    this.ps = [];
    for (let i = 0; i < COUNT; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * (MAX_R - 0.02);
      const dir = Math.random() * Math.PI * 2;
      const speed = 0.0004 + Math.random() * 0.0007;
      const big = Math.random() < 0.18;
      this.ps.push({
        x: 0.5 + Math.cos(ang) * rad,
        y: 0.5 + Math.sin(ang) * rad,
        vx: Math.cos(dir) * speed,
        vy: Math.sin(dir) * speed,
        r: big ? 2.0 + Math.random() * 1.4 : 0.8 + Math.random() * 1.0,
      });
    }
  }

  /** Ajusta el backing-store al tamaño real y al DPR (nitidez). */
  private resize(): void {
    // clientWidth ignora el transform de `.orb.speaking` → tamaño de layout estable.
    this.size = Math.max(40, this.orb.clientWidth || 0);
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.size * this.dpr);
    this.canvas.height = Math.round(this.size * this.dpr);
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
  }

  /** Energía objetivo según el estado de voz del orbe. */
  private targetEnergy(): number {
    const cls = this.orb.classList;
    if (cls.contains('listening')) {
      const lvl = parseFloat(this.orb.style.getPropertyValue('--level')) || 0;
      return 0.25 + lvl * 1.6; // piso audible + nivel real del micrófono
    }
    if (cls.contains('speaking')) {
      const lvl = parseFloat(this.orb.style.getPropertyValue('--level')) || 0;
      // ApiTts publica el nivel real del audio → el orbe reacciona a la voz del
      // agente. Sin nivel (TTS de navegador, no analizable) → agitación animada.
      if (lvl > 0.01) return 0.3 + lvl * 1.8;
      return 0.5 + Math.sin(this.t * 0.18) * 0.14;
    }
    return 0; // idle → deriva lenta
  }

  private loop(): void {
    this.t++;
    const target = this.targetEnergy();
    this.energy += (target - this.energy) * 0.12; // suavizado (inercia)
    this.step();
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Mueve las partículas y las confina al disco (reflexión en el borde). */
  private step(): void {
    const e = this.energy;
    const speedMul = 0.5 + e * 5.5; // a más energía, más agitación
    const jitter = e * 0.0016;
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
        p.vx -= 2 * dot * nx; // refleja la velocidad hacia dentro
        p.vy -= 2 * dot * ny;
        p.x = 0.5 + nx * MAX_R;
        p.y = 0.5 + ny * MAX_R;
      }
    }
  }

  private draw(): void {
    const { ctx, dpr } = this;
    const s = this.size * dpr;
    ctx.clearRect(0, 0, s, s);
    const e = this.energy;

    // Núcleo central (eco del centro del logo): glow que pulsa con la energía.
    const cx = s / 2;
    const cy = s / 2;
    const coreR = s * (0.1 + e * 0.1);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3.6);
    g.addColorStop(0, `rgba(${GOLD_BRIGHT}, ${0.32 + e * 0.45})`);
    g.addColorStop(0.4, `rgba(${GOLD}, ${0.1 + e * 0.2})`);
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);

    // Líneas de la constelación (más brillantes con la energía).
    const link = LINK * s;
    ctx.lineWidth = dpr * 0.8;
    for (let i = 0; i < this.ps.length; i++) {
      const a = this.ps[i];
      const ax = a.x * s;
      const ay = a.y * s;
      for (let j = i + 1; j < this.ps.length; j++) {
        const b = this.ps[j];
        const bx = b.x * s;
        const by = b.y * s;
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

    // Partículas: glow + núcleo del punto.
    const bright = 0.5 + e * 0.5;
    for (const p of this.ps) {
      const px = p.x * s;
      const py = p.y * s;
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
