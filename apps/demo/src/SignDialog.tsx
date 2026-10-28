import { liftInk, readInk, type InkPhoto } from '@pdfsdk/editor';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from './i18n';
import { Icon } from './icons';

export interface Signature {
  /** Transparent PNG, trimmed to the ink. */
  src: string;
  width: number;
  height: number;
}

type Mode = 'draw' | 'type' | 'upload';

const INKS = [
  { name: 'black', value: '#1b1b1f' },
  { name: 'blue', value: '#1d3fbf' },
] as const;
const FONTS = [
  { name: 'script', family: '"Dancing Script", cursive' },
  { name: 'hand', family: '"Caveat", cursive' },
  { name: 'formal', family: '"Mrs Saint Delafield", cursive' },
] as const;
const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Caveat:wght@500&family=Dancing+Script:wght@500&family=Mrs+Saint+Delafield&display=swap';
let fontsLoading: Promise<void> | undefined;

/** The handwriting fonts load with this dialog, not with every page of the site. */
function loadFonts(): Promise<void> {
  fontsLoading ??= new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONTS_URL;
    link.onload = () => void Promise.all(FONTS.map((f) => document.fonts.load(`120px ${f.family}`))).then(() => resolve(), () => resolve());
    link.onerror = () => resolve();
    document.head.append(link);
  });
  return fontsLoading;
}

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

/** A photo or scan of a signature or stamp on paper, read for lifting its ink (at most 1600 px across). */
async function readPhoto(file: File): Promise<InkPhoto> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return readInk({ width: canvas.width, height: canvas.height, rgba: data });
}

/** The ink of a photo on a transparent background: the paper and its shadows go, the ink stays. */
function lifted(photo: InkPhoto, strength: number, color: string | null): Signature | null {
  const ink = liftInk(photo, { strength, color });
  if (!ink) return null;
  const canvas = document.createElement('canvas');
  canvas.width = ink.width;
  canvas.height = ink.height;
  canvas.getContext('2d')!.putImageData(new ImageData(ink.rgba as Uint8ClampedArray<ArrayBuffer>, ink.width, ink.height), 0, 0);
  return { src: canvas.toDataURL('image/png'), width: ink.width, height: ink.height };
}

export function SignDialog({ onPlace, onClose }: { onPlace: (signature: Signature) => void; onClose: () => void }) {
  const s = useI18n().t.sign;
  const [mode, setMode] = useState<Mode>('draw');
  const [ink, setInk] = useState<string>(INKS[0].value);
  const [name, setName] = useState('');
  const [font, setFont] = useState(0);
  const [drawn, setDrawn] = useState(false);
  const [photo, setPhoto] = useState<InkPhoto | null>(null);
  const [photoError, setPhotoError] = useState(false);
  const [strength, setStrength] = useState(0.5);
  // The photo's own colours (a stamp stays blue), or one ink.
  const [photoInk, setPhotoInk] = useState<string | null>(null);
  // The slider stays smooth while the picture catches up.
  const deferredStrength = useDeferredValue(strength);
  const uploaded = useMemo(() => (photo ? lifted(photo, deferredStrength, photoInk) : null), [photo, deferredStrength, photoInk]);
  const [saved] = useState(loadSaved);
  const pad = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  // A typed signature is drawn in a handwriting font: wait for it.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => void loadFonts().then(() => setFontsReady(true)), []);

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
  const ready = mode === 'draw' ? drawn : mode === 'type' ? !!name.trim() && fontsReady : !!uploaded;

  const place = (signature: Signature | null) => {
    if (!signature) return;
    remember(signature);
    onPlace(signature);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={s.title} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__card">
        <div className="modal__art">
          <div className="modal__paper">
            {mode === 'type' && name ? (
              <span style={{ fontFamily: FONTS[font]!.family, color: ink }}>{name}</span>
            ) : mode === 'upload' && uploaded ? (
              <img src={uploaded.src} alt="" />
            ) : (
              <span className="modal__line">{s.signHere}</span>
            )}
          </div>
          <p>{s.private}</p>
        </div>
        <div className="modal__body">
          <div className="modal__head">
            <h2>{s.title}</h2>
            <button type="button" className="pill pill--icon" aria-label={s.close} onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>

          <div className="group modal__tabs">
            {(['draw', 'type', 'upload'] as const).map((m) => (
              <button key={m} type="button" className="pill" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {s[m]}
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
              {!drawn && <span className="sign-pad__hint">{s.drawHint}</span>}
              <button
                type="button"
                className="pill sign-pad__clear"
                onClick={() => {
                  const c = pad.current;
                  c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
                  setDrawn(false);
                }}
              >
                {s.clear}
              </button>
            </div>
          )}

          {mode === 'type' && (
            <div className="sign-type">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={s.name} aria-label={s.name} />
              <div className="group">
                {FONTS.map((f, i) => (
                  <button key={f.name} type="button" className="pill" aria-pressed={font === i} onClick={() => setFont(i)} style={{ fontFamily: f.family, fontSize: 18 }}>
                    {name.trim().split(' ')[0] || s.fonts[f.name]}
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
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  // A format the browser can't draw (HEIC on a desktop, say) says so instead of doing nothing.
                  try {
                    setPhoto(await readPhoto(file));
                    setPhotoError(false);
                  } catch {
                    setPhotoError(true);
                  }
                }}
              />
              {photo ? (
                <>
                  {/* Phones have no preview beside the dialog: the result shows here, on a checkerboard. */}
                  {uploaded && <img className="sign-upload__preview narrow-only" src={uploaded.src} alt="" />}
                  <label className="sign-upload__strength">
                    <span>{s.cleanup}</span>
                    <input type="range" min={0} max={1} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
                  </label>
                  {!uploaded && <p className="dialog__error">{s.noInk}</p>}
                  <button type="button" className="pill" onClick={() => upload.current?.click()}>
                    <Icon name="image" /> {s.another}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="pill pill--ink" onClick={() => upload.current?.click()}>
                    <Icon name="upload" /> {s.chooseImage}
                  </button>
                  <p>{s.imageHint}</p>
                </>
              )}
              {photoError && <p className="dialog__error">{s.imageError}</p>}
            </div>
          )}

          {mode === 'upload' && photo && (
            <div className="group modal__inks" aria-label={s.ink}>
              <button type="button" className="pill pill--icon" aria-label={s.inks.original} title={s.inks.original} aria-pressed={photoInk === null} onClick={() => setPhotoInk(null)}>
                <span className="swatch swatch--photo" />
              </button>
              {INKS.map((c) => (
                <button key={c.value} type="button" className="pill pill--icon" aria-label={s.inks[c.name]} aria-pressed={photoInk === c.value} onClick={() => setPhotoInk(c.value)}>
                  <span className="swatch" style={{ background: c.value }} />
                </button>
              ))}
            </div>
          )}
          {mode !== 'upload' && (
            <div className="group modal__inks" aria-label={s.ink}>
              {INKS.map((c) => (
                <button key={c.value} type="button" className="pill pill--icon" aria-label={s.inks[c.name]} aria-pressed={ink === c.value} onClick={() => setInk(c.value)}>
                  <span className="swatch" style={{ background: c.value }} />
                </button>
              ))}
            </div>
          )}

          {saved.length > 0 && (
            <div className="modal__saved">
              <span>{s.saved}</span>
              {saved.map((signature) => (
                <button key={signature.src} type="button" className="saved-sign" onClick={() => place(signature)} aria-label={s.useSaved}>
                  <img src={signature.src} alt="" />
                </button>
              ))}
            </div>
          )}

          <div className="modal__foot">
            <button type="button" className="pill" onClick={onClose}>
              {s.cancel}
            </button>
            <button type="button" className="pill pill--ink" disabled={!ready} onClick={() => place(current())}>
              {s.place}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
