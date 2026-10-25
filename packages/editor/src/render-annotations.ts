import { bounds, textBaselines, textLines, type MeasureText } from './geometry';
import type { PageView } from './page-view';
import type { Annotation, Point } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const TEXT_FONT_FAMILY = 'pdfsdk-text, Helvetica, Arial, sans-serif';

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

export function pathData(points: Point[]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
}

/** Builds the SVG for one annotation, in PDF user space. */
export function annotationElement(annotation: Annotation): SVGElement {
  switch (annotation.type) {
    case 'highlight': {
      // One group with group opacity, so overlapping line boxes don't darken where they touch.
      const group = svg('g', { class: 'pdfsdk-highlight', fill: annotation.color, opacity: annotation.opacity });
      for (const { x, y, width, height } of annotation.segments ?? [annotation.rect]) {
        group.append(svg('rect', { x, y, width, height }));
      }
      return group;
    }
    case 'rectangle': {
      const { x, y, width, height } = annotation.rect;
      return svg('rect', {
        x, y, width, height,
        fill: 'none',
        stroke: annotation.color,
        'stroke-width': annotation.strokeWidth,
      });
    }
    case 'ink': {
      const group = svg('g', {
        fill: 'none',
        stroke: annotation.color,
        'stroke-width': annotation.strokeWidth,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
      for (const path of annotation.paths) {
        // A single tap becomes a zero-length segment, which round caps draw as a dot.
        const points = path.length === 1 ? [path[0]!, path[0]!] : path;
        group.append(svg('path', { d: pathData(points) }));
      }
      return group;
    }
    case 'image': {
      const { x, y, width, height } = annotation.rect;
      // The user-space group is flipped; flip the picture back so it's upright.
      return svg('image', {
        href: annotation.src,
        width,
        height,
        transform: `matrix(1 0 0 -1 ${x} ${y + height})`,
        preserveAspectRatio: 'none',
      });
    }
    case 'text': {
      const group = svg('g', {
        fill: annotation.color,
        'font-family': TEXT_FONT_FAMILY,
        'font-size': annotation.fontSize,
      });
      const baselines = textBaselines(annotation);
      textLines(annotation).forEach((line, i) => {
        // The user-space group is flipped vertically; flip each line back so glyphs are upright.
        const text = svg('text', {
          transform: `translate(${annotation.position[0]} ${baselines[i]}) scale(1 -1)`,
        });
        text.setAttribute('xml:space', 'preserve');
        text.textContent = line;
        group.append(text);
      });
      return group;
    }
  }
}

/** Where a picture's resize handle sits: its bottom-right corner, in user space. */
export function resizeHandle(annotation: { rect: { x: number; y: number; width: number } }): Point {
  return [annotation.rect.x + annotation.rect.width, annotation.rect.y];
}

export function renderPageAnnotations(
  view: PageView,
  annotations: readonly Annotation[],
  selectedId: string | null,
  measure: MeasureText,
): void {
  view.content.replaceChildren(
    ...annotations.map((annotation) => {
      const el = annotationElement(annotation);
      el.dataset.annotationId = annotation.id;
      return el;
    }),
  );

  const selected = annotations.find((a) => a.id === selectedId);
  if (!selected) {
    view.chrome.replaceChildren();
    return;
  }
  const box = bounds(selected, measure);
  const pad = 3;
  const a = view.pdfToOverlay([box.x, box.y]);
  const b = view.pdfToOverlay([box.x + box.width, box.y + box.height]);
  const frame = svg('rect', {
    class: 'pdfsdk-selection',
    x: Math.min(a[0], b[0]) - pad,
    y: Math.min(a[1], b[1]) - pad,
    width: Math.abs(a[0] - b[0]) + pad * 2,
    height: Math.abs(a[1] - b[1]) + pad * 2,
  });
  if (selected.type !== 'image') {
    view.chrome.replaceChildren(frame);
    return;
  }
  // Pictures resize from their bottom-right corner.
  const [hx, hy] = view.pdfToOverlay(resizeHandle(selected));
  view.chrome.replaceChildren(frame, svg('circle', { class: 'pdfsdk-handle', cx: hx, cy: hy, r: 6 }));
}
