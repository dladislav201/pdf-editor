import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from './icons';

export interface Signature {
  /** Transparent PNG, trimmed to the ink. */
  src: string;
  width: number;
  height: number;
}

type Mode = 'draw' | 'type' | 'upload';

const INKS = [
  { name: 'Black', value: '#1b1b1f' },
  { name: 'Blue', value: '#1d3fbf' },
];
const FONTS = [
  { name: 'Script', family: '"Dancing Script", cursive' },
  { name: 'Hand', family: '"Caveat", cursive' },
  { name: 'Formal', family: '"Mrs Saint Delafield", cursive' },
];
const SAVED_KEY = 'signatures';
const MAX_SAVED = 3;

function loadSaved(): Signature[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]') as Signature[];
  } catch {
    return [];
  }
}
function remember(signature: Signature): void {
  try {
    const list = [signature, ...loadSaved().filter((s) => s.src !== signature.src)].slice(0, MAX_SAVED);
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
  } catch {
    // Not remembered; it still gets placed.
  }
}

/** The canvas cut down to its ink (plus a little room), as a transparent PNG. */
function trim(canvas: HTMLCanvasElement): Signature | null {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! < 12) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  const w = x1 - x0 + 1 + pad * 2;
  const h = y1 - y0 + 1 + pad * 2;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')!.drawImage(canvas, x0 - pad, y0 - pad, w, h, 0, 0, w, h);
  return { src: out.toDataURL('image/png'), width: w, height: h };
}

/** A photo or scan of a signature on paper: the paper becomes transparent, the ink stays. */
async function fromImage(file: File): Promise<Signature | null> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
    // Light paper fades out; ink keeps its colour, its edge softly transparent.
    const alpha = Math.max(0, Math.min(1, (215 - lum) / 90));
    px[i + 3] = Math.round(px[i + 3]! * alpha);
  }
  ctx.putImageData(image, 0, 0);
  return trim(canvas);
}

export function SignDialog({ onPlace, onClose }: { onPlace: (signature: Signature) => void; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('draw');
  const [ink, setInk] = useState(INKS[0]!.value);
  const [name, setName] = useState('');
  const [font, setFont] = useState(0);
  const [drawn, setDrawn] = useState(false);
  const [uploaded, setUploaded] = useState<Signature | null>(null);
  const [saved] = useState(loadSaved);
  const pad = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const upload = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    addEventListener('keydown', close);
    return () => removeEventListener('keydown', close);
  }, [onClose]);

  // The drawing pad at the screen's resolution.
  useEffect(() => {
    const canvas = pad.current;
    if (!canvas || mode !== 'draw') return;
    const ratio = devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.clientHeight * ratio;
    setDrawn(false);
  }, [mode]);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = event.currentTarget.width / box.width;
    return { x: (event.clientX - box.left) * ratio, y: (event.clientY - box.top) * ratio };
  };
  const stroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!last.current) return;
    const ctx = event.currentTarget.getContext('2d')!;
    const p = point(event);
    const ratio = event.currentTarget.width / event.currentTarget.getBoundingClientRect().width;
    ctx.strokeStyle = ink;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // A little thinner when moving fast, like a pen.
    const speed = Math.hypot(p.x - last.current.x, p.y - last.current.y) / ratio;
    ctx.lineWidth = Math.max(1.6, 3.2 - speed * 0.05) * ratio;
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.quadraticCurveTo(last.current.x, last.current.y, (last.current.x + p.x) / 2, (last.current.y + p.y) / 2);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    setDrawn(true);
  };

  const typed = (): Signature | null => {
    if (!name.trim()) return null;
    const canvas = document.createElement('canvas');
    const size = 120;
    const ctx = canvas.getContext('2d')!;
    ctx.font = `${size}px ${FONTS[font]!.family}`;
    canvas.width = Math.ceil(ctx.measureText(name).width + size);
    canvas.height = Math.ceil(size * 1.8);
    ctx.font = `${size}px ${FONTS[font]!.family}`;
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.fillText(name, size / 2, canvas.height / 2);
    return trim(canvas);
  };

  const current = (): Signature | null => {
    if (mode === 'draw') return drawn && pad.current ? trim(pad.current) : null;
    if (mode === 'type') return typed();
    return uploaded;
  };
  const ready = mode === 'draw' ? drawn : mode === 'type' ? !!name.trim() : !!uploaded;

  const place = (signature: Signature | null) => {
    if (!signature) return;
    remember(signature);
    onPlace(signature);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Add your signature" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__card">
        <div className="modal__art">
          <div className="modal__paper">
            {mode === 'type' && name ? (
              <span style={{ fontFamily: FONTS[font]!.family, color: ink }}>{name}</span>
            ) : mode === 'upload' && uploaded ? (
              <img src={uploaded.src} alt="" />
            ) : (
              <span className="modal__line">Sign here</span>
            )}
          </div>
          <p>Your signature stays in this browser. Nothing is uploaded.</p>
        </div>
        <div className="modal__body">
          <div className="modal__head">
            <h2>Add your signature</h2>
            <button type="button" className="pill pill--icon" aria-label="Close" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>

          <div className="group modal__tabs">
            {(['draw', 'type', 'upload'] as const).map((m) => (
              <button key={m} type="button" className="pill" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === 'draw' ? 'Draw' : m === 'type' ? 'Type' : 'Upload'}
              </button>
            ))}
          </div>

          {mode === 'draw' && (
            <div className="sign-pad">
              <canvas
                ref={pad}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  last.current = point(e);
                }}
                onPointerMove={stroke}
                onPointerUp={() => (last.current = null)}
                onPointerCancel={() => (last.current = null)}
              />
              {!drawn && <span className="sign-pad__hint">Draw with your mouse, trackpad or finger</span>}
              <button
                type="button"
                className="pill sign-pad__clear"
                onClick={() => {
                  const c = pad.current;
                  c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
                  setDrawn(false);
                }}
              >
                Clear
              </button>
            </div>
          )}

          {mode === 'type' && (
            <div className="sign-type">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" />
              <div className="group">
                {FONTS.map((f, i) => (
                  <button key={f.name} type="button" className="pill" aria-pressed={font === i} onClick={() => setFont(i)} style={{ fontFamily: f.family, fontSize: 18 }}>
                    {name.trim().split(' ')[0] || f.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {mode === 'upload' && (
            <div className="sign-upload">
              <input
                ref={upload}
                type="file"
                accept="image/png,image/jpeg"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) setUploaded(await fromImage(file));
                  e.target.value = '';
                }}
              />
              <button type="button" className="pill pill--ink" onClick={() => upload.current?.click()}>
                <Icon name="upload" /> Choose an image
              </button>
              <p>A photo of your signature on white paper works best: the paper turns transparent.</p>
            </div>
          )}

          {mode !== 'upload' && (
            <div className="group modal__inks" aria-label="Ink colour">
              {INKS.map((c) => (
                <button key={c.value} type="button" className="pill pill--icon" aria-label={c.name} aria-pressed={ink === c.value} onClick={() => setInk(c.value)}>
                  <span className="swatch" style={{ background: c.value }} />
                </button>
              ))}
            </div>
          )}

          {saved.length > 0 && (
            <div className="modal__saved">
              <span>Saved</span>
              {saved.map((s) => (
                <button key={s.src} type="button" className="saved-sign" onClick={() => place(s)} aria-label="Use a saved signature">
                  <img src={s.src} alt="" />
                </button>
              ))}
            </div>
          )}

          <div className="modal__foot">
            <button type="button" className="pill" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="pill pill--ink" disabled={!ready} onClick={() => place(current())}>
              Place signature
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
