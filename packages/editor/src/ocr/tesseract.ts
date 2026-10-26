import type { OcrEngine } from './recognize';
import type { Raster, RecognizedWord } from './types';

/** Encodes a raster into something Tesseract.js accepts (a PNG Blob in browsers, a Buffer in Node). */
export type EncodeImage = (raster: Raster) => Promise<unknown>;

export interface TesseractPaths {
  workerPath?: string;
  corePath?: string;
  langPath: string;
}

interface TesseractWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  symbols?: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[];
}
interface TesseractLine {
  words: TesseractWord[];
  baseline: { y0: number; y1: number };
  rowAttributes?: { row_height?: number };
  bbox: { y0: number; y1: number };
}
interface TesseractBlock {
  paragraphs: { lines: TesseractLine[] }[];
}

type TesseractModule = typeof import('tesseract.js');
type Worker = Awaited<ReturnType<TesseractModule['createWorker']>>;

const NUMERIC = '0123456789.,- ';

/**
 * Adapter from Tesseract.js to the pipeline's `OcrEngine`. One Tesseract
 * worker is reused; `terminate()` frees it.
 */
export class TesseractEngine implements OcrEngine {
  private worker: Promise<Worker> | null = null;

  constructor(
    private readonly load: () => Promise<TesseractModule>,
    private readonly encode: EncodeImage,
    private readonly paths: TesseractPaths,
    readonly languages: string[] = ['ukr', 'eng'],
  ) {}

  private start(): Promise<Worker> {
    this.worker ??= this.load().then((tesseract) =>
      tesseract.createWorker(this.languages, tesseract.OEM.LSTM_ONLY, {
        ...this.paths,
        gzip: true,
        // Models come from our own assets; the browser's HTTP cache keeps them.
        cacheMethod: 'none',
        workerBlobURL: false,
      }),
    );
    return this.worker;
  }

  async recognize(image: Raster, mode: { layout: 'page' | 'block'; numeric?: boolean }): Promise<RecognizedWord[]> {
    const worker = await this.start();
    await worker.setParameters({
      tessedit_pageseg_mode: (mode.layout === 'page' ? '3' : '6') as never,
      tessedit_char_whitelist: mode.numeric ? NUMERIC : '',
    });
    const { data } = await worker.recognize((await this.encode(image)) as never, {}, { blocks: true });
    const words: RecognizedWord[] = [];
    let line = 0;
    for (const block of (data.blocks ?? []) as unknown as TesseractBlock[]) {
      for (const paragraph of block.paragraphs) {
        for (const textLine of paragraph.lines) {
          const lineHeight = textLine.rowAttributes?.row_height ?? textLine.bbox.y1 - textLine.bbox.y0;
          const baseline = (textLine.baseline.y0 + textLine.baseline.y1) / 2;
          for (const word of textLine.words) {
            if (!word.text.trim()) continue;
            const symbols = (word.symbols ?? []).map((s) => ({ text: s.text, confidence: s.confidence, box: { ...s.bbox } }));
            words.push({ text: word.text, confidence: word.confidence, box: { ...word.bbox }, baseline, lineHeight, line, symbols });
          }
          line++;
        }
      }
    }
    return words;
  }

  async terminate(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    await (await worker)?.terminate();
  }
}
