import type { PdfEditor } from './editor';
import type { ToolName } from './types';

const ICONS = {
  select: '<path d="M4 4l7.07 17 2.51-7.39L21 11.07z"/>',
  editText: '<path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1"/><path d="M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5"/><path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"/><path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"/><path d="M9 7v10"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  rectangle: '<rect x="3" y="5" width="18" height="14" rx="2"/>',
  ink: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  zoomOut: '<path d="M5 12h14"/>',
  zoomIn: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  fitWidth: '<path d="M3 12h18"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/>',
  open: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  recognize: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8h8"/><path d="M7 12h10"/><path d="M7 16h6"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
} as const;

const TOOLS: { tool: ToolName; label: string; shortcut: string }[] = [
  { tool: 'select', label: 'Select', shortcut: 'V' },
  { tool: 'editText', label: 'Edit text', shortcut: 'E' },
  { tool: 'highlight', label: 'Highlight', shortcut: 'H' },
  { tool: 'rectangle', label: 'Rectangle', shortcut: 'R' },
  { tool: 'ink', label: 'Draw', shortcut: 'D' },
  { tool: 'text', label: 'Text', shortcut: 'T' },
];

export const PALETTE = ['#facc15', '#ef4444', '#22c55e', '#2f6fed', '#111827'];

function icon(name: keyof typeof ICONS): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function button(label: string, content: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'pdfsdk-btn';
  el.title = label;
  el.setAttribute('aria-label', label);
  el.innerHTML = content;
  el.addEventListener('click', onClick);
  return el;
}

function separator(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pdfsdk-toolbar__sep';
  return el;
}

/** The default toolbar. It only talks to the public editor API, so hosts can build their own. */
export function createToolbar(editor: PdfEditor, readOnly: boolean): { el: HTMLElement; destroy: () => void } {
  const el = document.createElement('div');
  el.className = 'pdfsdk-toolbar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', 'PDF editor');

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/pdf,.pdf';
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void editor.load(file).catch(() => undefined);
    fileInput.value = '';
  });
  el.append(fileInput, button('Open PDF', icon('open'), () => fileInput.click()));

  const toolButtons = new Map<ToolName, HTMLButtonElement>();
  const swatches = new Map<string, HTMLButtonElement>();
  let undoBtn: HTMLButtonElement | null = null;
  let redoBtn: HTMLButtonElement | null = null;
  let deleteBtn: HTMLButtonElement | null = null;

  if (!readOnly) {
    el.append(separator());
    for (const { tool, label, shortcut } of TOOLS) {
      const btn = button(`${label} (${shortcut})`, icon(tool), () => editor.setTool(tool));
      toolButtons.set(tool, btn);
      el.append(btn);
    }
    el.append(separator());
    for (const color of PALETTE) {
      const btn = button(`Color ${color}`, `<span class="pdfsdk-swatch" style="background:${color}"></span>`, () =>
        editor.setColor(color),
      );
      swatches.set(color, btn);
      el.append(btn);
    }
    el.append(separator());
    undoBtn = button('Undo (Ctrl+Z)', icon('undo'), () => editor.undo());
    redoBtn = button('Redo (Ctrl+Shift+Z)', icon('redo'), () => editor.redo());
    deleteBtn = button('Delete selected (Del)', icon('trash'), () => editor.deleteSelected());
    el.append(undoBtn, redoBtn, deleteBtn);
  }

  el.append(separator());
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'pdfsdk-zoom-label';
  zoomLabel.setAttribute('aria-live', 'polite');
  el.append(
    button('Zoom out', icon('zoomOut'), () => editor.zoomOut()),
    zoomLabel,
    button('Zoom in', icon('zoomIn'), () => editor.zoomIn()),
    button('Fit width', icon('fitWidth'), () => editor.setZoom('fit-width')),
  );

  el.append(separator());
  const pageLabel = document.createElement('span');
  pageLabel.className = 'pdfsdk-page-label';
  el.append(pageLabel);

  // Recognize text (OCR) of scanned pages; the label shows progress and the outcome.
  let recognizeBtn: HTMLButtonElement | null = null;
  let recognizing = false;
  let labelTimer = 0;
  if (!readOnly) {
    recognizeBtn = button('Recognize text in scanned pages (OCR)', `${icon('recognize')}<span>Recognize text</span>`, () => {
      recognizing = true;
      sync();
      editor
        .recognizeText()
        .then((pages) => setRecognizeLabel(pages.length ? `Recognized ${pages.length} page${pages.length > 1 ? 's' : ''}` : 'No scanned pages'))
        .catch(() => setRecognizeLabel('Recognition failed'))
        .finally(() => {
          recognizing = false;
          sync();
        });
    });
    el.append(separator(), recognizeBtn);
  }
  const setRecognizeLabel = (text: string, sticky = false) => {
    const label = recognizeBtn?.querySelector('span');
    if (!label) return;
    label.textContent = text;
    clearTimeout(labelTimer);
    if (!sticky) labelTimer = window.setTimeout(() => (label.textContent = 'Recognize text'), 4000);
  };

  const spacer = document.createElement('div');
  spacer.className = 'pdfsdk-toolbar__spacer';
  const downloadBtn = button('Download PDF', `${icon('download')}<span>Download</span>`, () => {
    void editor.download().catch(() => undefined);
  });
  downloadBtn.classList.add('pdfsdk-btn--primary');
  el.append(spacer, downloadBtn);

  const sync = () => {
    const tool = editor.getTool();
    for (const [name, btn] of toolButtons) btn.setAttribute('aria-pressed', String(name === tool));
    const color = editor.getColor();
    for (const [value, btn] of swatches) btn.setAttribute('aria-pressed', String(value === color));
    if (undoBtn) undoBtn.disabled = !editor.canUndo;
    if (redoBtn) redoBtn.disabled = !editor.canRedo;
    if (deleteBtn) deleteBtn.disabled = editor.getSelectedId() === null;
    zoomLabel.textContent = `${Math.round(editor.getZoom() * 100)}%`;
    const count = editor.pageCount;
    pageLabel.textContent = count ? `${editor.getPageIndex() + 1} / ${count}` : '–';
    downloadBtn.disabled = count === 0;
    if (recognizeBtn) recognizeBtn.disabled = count === 0 || recognizing;
  };

  const unsubscribers = (
    ['toolChange', 'colorChange', 'zoomChange', 'pageChange', 'historyChange', 'selectionChange', 'documentLoaded', 'annotationsChange'] as const
  ).map((event) => editor.on(event, sync));
  unsubscribers.push(
    editor.on('ocrProgress', ({ pageIndex, done, total }) => {
      if (pageIndex >= 0) setRecognizeLabel(`Reading page ${done + 1} of ${total}…`, true);
      // Started elsewhere (the host's own button): put the label back.
      else if (!recognizing) setRecognizeLabel('Recognize text', true);
    }),
  );
  sync();

  return {
    el,
    destroy: () => {
      for (const off of unsubscribers) off();
      clearTimeout(labelTimer);
      el.remove();
    },
  };
}
