const STYLE_ID = 'pdfsdk-styles';

/**
 * Styles are injected at runtime so integrators don't need a CSS import.
 * Everything is scoped under `.pdfsdk-root`; theme tokens are CSS variables
 * that hosts can override on the container.
 */
const CSS = /* css */ `
.pdfsdk-root {
  --pdfsdk-bg: #eef0f3;
  --pdfsdk-surface: #ffffff;
  --pdfsdk-border: #dfe2e7;
  --pdfsdk-text: #1b1f24;
  --pdfsdk-muted: #69707a;
  --pdfsdk-hover: #f1f3f5;
  --pdfsdk-accent: #2f6fed;
  --pdfsdk-accent-soft: #e5eeff;
  --pdfsdk-page-shadow: 0 1px 3px rgba(16, 24, 40, 0.12), 0 1px 2px rgba(16, 24, 40, 0.06);
  --pdfsdk-radius: 8px;
  --pdfsdk-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;

  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--pdfsdk-bg);
  color: var(--pdfsdk-text);
  font: 13px/1.4 var(--pdfsdk-font);
  outline: none;
}
.pdfsdk-root[data-theme="dark"] {
  --pdfsdk-bg: #17191c;
  --pdfsdk-surface: #222529;
  --pdfsdk-border: #33373d;
  --pdfsdk-text: #e8eaed;
  --pdfsdk-muted: #9aa0a8;
  --pdfsdk-hover: #2c3035;
  --pdfsdk-accent: #6b9bff;
  --pdfsdk-accent-soft: #23314d;
  --pdfsdk-page-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
}
@media (prefers-color-scheme: dark) {
  .pdfsdk-root[data-theme="auto"] {
    --pdfsdk-bg: #17191c;
    --pdfsdk-surface: #222529;
    --pdfsdk-border: #33373d;
    --pdfsdk-text: #e8eaed;
    --pdfsdk-muted: #9aa0a8;
    --pdfsdk-hover: #2c3035;
    --pdfsdk-accent: #6b9bff;
    --pdfsdk-accent-soft: #23314d;
    --pdfsdk-page-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  }
}

.pdfsdk-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  padding: 6px 8px;
  background: var(--pdfsdk-surface);
  border-bottom: 1px solid var(--pdfsdk-border);
  user-select: none;
}
.pdfsdk-toolbar__sep {
  width: 1px;
  height: 20px;
  margin: 0 6px;
  background: var(--pdfsdk-border);
}
.pdfsdk-toolbar__spacer { flex: 1; }
.pdfsdk-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 32px;
  height: 32px;
  padding: 0 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.pdfsdk-btn:hover:not(:disabled) { background: var(--pdfsdk-hover); }
.pdfsdk-btn:focus-visible { outline: 2px solid var(--pdfsdk-accent); outline-offset: 1px; }
.pdfsdk-btn:disabled { opacity: 0.4; cursor: default; }
.pdfsdk-btn[aria-pressed="true"] { background: var(--pdfsdk-accent-soft); color: var(--pdfsdk-accent); }
.pdfsdk-btn svg { width: 18px; height: 18px; flex: none; }
.pdfsdk-btn--primary { background: var(--pdfsdk-accent); color: #fff; padding: 0 12px; }
.pdfsdk-btn--primary:hover:not(:disabled) { background: var(--pdfsdk-accent); filter: brightness(1.08); }
.pdfsdk-zoom-label, .pdfsdk-page-label {
  min-width: 52px;
  text-align: center;
  color: var(--pdfsdk-muted);
  font-variant-numeric: tabular-nums;
}
.pdfsdk-swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15);
}
.pdfsdk-btn[aria-pressed="true"] .pdfsdk-swatch {
  box-shadow: 0 0 0 2px var(--pdfsdk-surface), 0 0 0 4px var(--pdfsdk-accent);
}

.pdfsdk-viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.pdfsdk-pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 24px 16px;
  width: max-content;
  min-width: 100%;
  box-sizing: border-box;
}
.pdfsdk-page {
  position: relative;
  flex: none;
  background: #fff;
  box-shadow: var(--pdfsdk-page-shadow);
}
/* Trial (no valid licence key): a watermark over every page. */
.pdfsdk-root[data-license="trial"] .pdfsdk-page { container-type: inline-size; }
.pdfsdk-root[data-license="trial"] .pdfsdk-page::after {
  content: "PDF SDK · trial";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transform: rotate(-35deg);
  font: 700 11cqw/1 system-ui, sans-serif;
  color: rgba(220, 38, 38, 0.16);
  pointer-events: none;
  z-index: 5;
  white-space: nowrap;
}
.pdfsdk-page canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.pdfsdk-page__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  /* Fingers draw with the drawing tools; with Select and Edit text they scroll and zoom the document. */
  touch-action: none;
}
.pdfsdk-root[data-tool="select"] .pdfsdk-page__overlay,
.pdfsdk-root[data-tool="editText"] .pdfsdk-page__overlay { touch-action: pan-x pan-y pinch-zoom; }
/* Except on the page holding a selected annotation, so it can be dragged (tap it first). */
.pdfsdk-root[data-tool="select"] .pdfsdk-page__overlay:has(.pdfsdk-selection) { touch-action: none; }
.pdfsdk-root[data-tool="select"] .pdfsdk-page__overlay { cursor: default; }
.pdfsdk-root[data-tool="text"] .pdfsdk-page__overlay { cursor: text; }
.pdfsdk-root[data-tool="highlight"] .pdfsdk-page__overlay,
.pdfsdk-root[data-tool="rectangle"] .pdfsdk-page__overlay,
.pdfsdk-root[data-tool="ink"] .pdfsdk-page__overlay { cursor: crosshair; }
.pdfsdk-root[data-hover="annotation"] .pdfsdk-page__overlay { cursor: move; }
.pdfsdk-root[data-tool="editText"] .pdfsdk-page__overlay { cursor: default; }
.pdfsdk-root[data-tool="editText"][data-hover="paragraph"] .pdfsdk-page__overlay { cursor: text; }
.pdfsdk-root[data-tool="editText"][data-hover="readonly"] .pdfsdk-page__overlay { cursor: not-allowed; }
.pdfsdk-paragraph {
  fill: transparent;
  stroke: var(--pdfsdk-accent);
  stroke-width: 1px;
  vector-effect: non-scaling-stroke;
}
.pdfsdk-paragraph--hover { stroke-dasharray: 4 3; }
.pdfsdk-paragraph--selected { stroke-width: 1.5px; fill: color-mix(in srgb, var(--pdfsdk-accent) 7%, transparent); }
.pdfsdk-paragraph--readonly { stroke: var(--pdfsdk-muted); }
.pdfsdk-paragraph--overflow { stroke: #d93025; stroke-dasharray: none; fill: color-mix(in srgb, #d93025 6%, transparent); }
.pdfsdk-root[data-editing="text"] .pdfsdk-page__overlay { cursor: text; }
.pdfsdk-text-edit__selection rect { fill: var(--pdfsdk-accent); fill-opacity: 0.25; }
.pdfsdk-caret {
  stroke: var(--pdfsdk-accent);
  stroke-width: 1.5px;
  vector-effect: non-scaling-stroke;
}
.pdfsdk-caret--blink { animation: pdfsdk-blink 1.1s steps(1) infinite; }
@keyframes pdfsdk-blink { 50% { opacity: 0; } }
.pdfsdk-text-input {
  position: absolute;
  z-index: 3;
  width: 1px;
  height: 1em;
  margin: 0;
  padding: 0;
  border: 0;
  opacity: 0;
  resize: none;
  overflow: hidden;
  white-space: pre;
  pointer-events: none;
}
.pdfsdk-highlight { mix-blend-mode: multiply; }
.pdfsdk-selection {
  fill: none;
  stroke: var(--pdfsdk-accent);
  stroke-width: 1.5px;
  stroke-dasharray: 4 3;
  vector-effect: non-scaling-stroke;
  pointer-events: none;
}
.pdfsdk-handle {
  fill: var(--pdfsdk-surface);
  stroke: var(--pdfsdk-accent);
  stroke-width: 2px;
  cursor: nwse-resize;
  pointer-events: none;
}
.pdfsdk-root[data-hover="resize"] .pdfsdk-page__overlay { cursor: nwse-resize; }
.pdfsdk-root[data-tool="image"] .pdfsdk-page__overlay { cursor: copy; }
.pdfsdk-search { fill: #ffd400; fill-opacity: 0.35; mix-blend-mode: multiply; }
.pdfsdk-search--active { fill: #ff8a00; fill-opacity: 0.45; }
.pdfsdk-fields { position: absolute; inset: 0; pointer-events: none; }
/* Fields only take clicks with the Select tool; drawing tools draw over them. */
.pdfsdk-root[data-tool="select"] .pdfsdk-fields > * { pointer-events: auto; }
.pdfsdk-field {
  position: absolute;
  box-sizing: border-box;
  margin: 0;
  padding: 0 0.25em;
  border: 1px solid transparent;
  border-radius: 2px;
  /* Opaque, like Acrobat's field highlight, so the field's printed value doesn't show twice. */
  background: #e8efff;
  color: #000;
  font-family: Helvetica, Arial, sans-serif;
  line-height: 1.15;
  outline: none;
  resize: none;
}
.pdfsdk-field:hover { border-color: color-mix(in srgb, var(--pdfsdk-accent) 50%, transparent); }
.pdfsdk-field:focus, .pdfsdk-field:focus-visible { border-color: var(--pdfsdk-accent); background: #fff; }
.pdfsdk-field:disabled { background: #f1f1f1; color: #555; }
textarea.pdfsdk-field { padding-top: 0.15em; }
.pdfsdk-field--checkbox, .pdfsdk-field--radio { padding: 0; cursor: pointer; }
.pdfsdk-field--radio { border-radius: 50%; }
.pdfsdk-field[aria-checked="true"]::after {
  content: "";
  position: absolute;
  inset: 22%;
  background: #111;
  /* A tick for check boxes, a dot for radio buttons. */
  clip-path: polygon(14% 52%, 0 66%, 38% 100%, 100% 18%, 86% 4%, 38% 72%);
}
.pdfsdk-field--radio[aria-checked="true"]::after { clip-path: circle(42%); }
.pdfsdk-text-editor {
  position: absolute;
  z-index: 2;
  margin: 0;
  padding: 0;
  min-width: 40px;
  border: 1px dashed var(--pdfsdk-accent);
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.85);
  outline: none;
  resize: none;
  overflow: hidden;
  white-space: pre;
  line-height: 1.25;
}

.pdfsdk-message {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--pdfsdk-muted);
  text-align: center;
  pointer-events: none;
}
.pdfsdk-root [hidden] { display: none !important; }
`;

export function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
