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
  touch-action: none;
}
.pdfsdk-root[data-tool="select"] .pdfsdk-page__overlay { cursor: default; }
.pdfsdk-root[data-tool="text"] .pdfsdk-page__overlay { cursor: text; }
.pdfsdk-root[data-tool="highlight"] .pdfsdk-page__overlay,
.pdfsdk-root[data-tool="rectangle"] .pdfsdk-page__overlay,
.pdfsdk-root[data-tool="ink"] .pdfsdk-page__overlay { cursor: crosshair; }
.pdfsdk-root[data-hover="annotation"] .pdfsdk-page__overlay { cursor: move; }
.pdfsdk-highlight { mix-blend-mode: multiply; }
.pdfsdk-selection {
  fill: none;
  stroke: var(--pdfsdk-accent);
  stroke-width: 1.5px;
  stroke-dasharray: 4 3;
  vector-effect: non-scaling-stroke;
  pointer-events: none;
}
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
