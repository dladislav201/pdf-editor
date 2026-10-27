import type { Annotation, Point, Rect, TextAnnotation } from './types';

/** Text layout shared by the viewer and the exporter so both put glyphs in the same place. */
export const TEXT_LINE_HEIGHT = 1.25;
export const TEXT_ASCENT = 0.8;

export type MeasureText = (text: string, fontSize: number) => number;

/** Rounds to 0.01 pt so stored coordinates stay short and free of float noise. */
export const round = (n: number): number => Math.round(n * 100) / 100;

export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: round(Math.min(a[0], b[0])),
    y: round(Math.min(a[1], b[1])),
    width: round(Math.abs(a[0] - b[0])),
    height: round(Math.abs(a[1] - b[1])),
  };
}

export function textLines(annotation: TextAnnotation): string[] {
  return annotation.text.split('\n');
}

/** Baseline y of each line, in PDF user space. */
export function textBaselines(annotation: TextAnnotation): number[] {
  const top = annotation.position[1];
  return textLines(annotation).map(
    (_, i) => top - annotation.fontSize * (TEXT_ASCENT + i * TEXT_LINE_HEIGHT),
  );
}

export function bounds(annotation: Annotation, measure: MeasureText): Rect {
  switch (annotation.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'rectangle':
    case 'image':
      return annotation.rect;
    case 'ink': {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const path of annotation.paths) {
        for (const [x, y] of path) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      const pad = annotation.strokeWidth / 2;
      return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
    }
    case 'text': {
      const lines = textLines(annotation);
      const width = Math.max(...lines.map((line) => measure(line, annotation.fontSize)), annotation.fontSize);
      const height = annotation.fontSize * (TEXT_ASCENT + (lines.length - 1) * TEXT_LINE_HEIGHT + 0.25);
      const [x, top] = annotation.position;
      return { x, y: top - height, width, height };
    }
  }
}

function inRect(rect: Rect, [x, y]: Point, tolerance: number): boolean {
  return (
    x >= rect.x - tolerance &&
    x <= rect.x + rect.width + tolerance &&
    y >= rect.y - tolerance &&
    y <= rect.y + rect.height + tolerance
  );
}

function distanceToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Where a line under or through text goes in a box of text (one segment):
 * how thick it is and the height of its middle. An underline sits at the
 * bottom of the box (below the descenders), a strike-out at the middle of
 * lower-case letters, as Acrobat draws them.
 */
export function textLine(type: 'underline' | 'strikeout', box: Rect): { y: number; width: number } {
  const width = Math.max(0.5, box.height / 14);
  return { y: type === 'underline' ? box.y + width / 2 : box.y + box.height * 0.42, width };
}

export function hitTest(annotation: Annotation, point: Point, tolerance: number, measure: MeasureText): boolean {
  switch (annotation.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return (annotation.segments ?? [annotation.rect]).some((rect) => inRect(rect, point, tolerance));
    case 'text':
      return inRect(bounds(annotation, measure), point, tolerance);
    case 'image':
      return inRect(annotation.rect, point, tolerance);
    case 'rectangle': {
      // Only the outline is grabbable, so content inside an empty frame stays clickable.
      const { rect } = annotation;
      const reach = tolerance + annotation.strokeWidth / 2;
      const inside =
        inRect(rect, point, reach) &&
        !inRect({ x: rect.x + reach, y: rect.y + reach, width: rect.width - reach * 2, height: rect.height - reach * 2 }, point, 0);
      return inside;
    }
    case 'ink': {
      const reach = tolerance + annotation.strokeWidth / 2;
      return annotation.paths.some((path) => {
        if (path.length === 1) return Math.hypot(point[0] - path[0]![0], point[1] - path[0]![1]) <= reach;
        for (let i = 1; i < path.length; i++) {
          if (distanceToSegment(point, path[i - 1]!, path[i]!) <= reach) return true;
        }
        return false;
      });
    }
  }
}

export function translate(annotation: Annotation, dx: number, dy: number): Annotation {
  switch (annotation.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'rectangle':
    case 'image': {
      const move = (rect: Rect): Rect => ({ ...rect, x: round(rect.x + dx), y: round(rect.y + dy) });
      if ('segments' in annotation && annotation.segments) {
        return { ...annotation, rect: move(annotation.rect), segments: annotation.segments.map(move) };
      }
      return { ...annotation, rect: move(annotation.rect) };
    }
    case 'ink':
      return { ...annotation, paths: annotation.paths.map((path) => path.map(([x, y]) => [round(x + dx), round(y + dy)] as Point)) };
    case 'text':
      return { ...annotation, position: [round(annotation.position[0] + dx), round(annotation.position[1] + dy)] };
  }
}
