/**
 * Font subsetting with HarfBuzz (`hb-subset`, compiled to WebAssembly). Keeps
 * only the glyphs for the given characters, composites and cmap included, so
 * an embedded fallback font costs a few kilobytes instead of hundreds.
 */
export interface Subsetter {
  subset(font: Uint8Array, chars: Iterable<string>): Uint8Array;
}

interface HarfBuzzExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, length: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_set_add(set: number, codepoint: number): void;
  hb_subset_or_fail(face: number, input: number): number;
}

const HB_MEMORY_MODE_WRITABLE = 2;

export async function createSubsetter(wasm: BufferSource): Promise<Subsetter> {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const hb = instance.exports as unknown as HarfBuzzExports;
  return {
    subset(font, chars) {
      const data = hb.malloc(font.length);
      new Uint8Array(hb.memory.buffer).set(font, data);
      const blob = hb.hb_blob_create(data, font.length, HB_MEMORY_MODE_WRITABLE, 0, 0);
      const face = hb.hb_face_create(blob, 0);
      hb.hb_blob_destroy(blob);
      const input = hb.hb_subset_input_create_or_fail();
      try {
        if (!input) throw new Error('Could not start font subsetting.');
        const unicodes = hb.hb_subset_input_unicode_set(input);
        for (const char of chars) hb.hb_set_add(unicodes, char.codePointAt(0)!);
        const subset = hb.hb_subset_or_fail(face, input);
        if (!subset) throw new Error('Could not subset the font.');
        const result = hb.hb_face_reference_blob(subset);
        const start = hb.hb_blob_get_data(result, 0);
        const bytes = new Uint8Array(hb.memory.buffer).slice(start, start + hb.hb_blob_get_length(result));
        hb.hb_blob_destroy(result);
        hb.hb_face_destroy(subset);
        return bytes;
      } finally {
        if (input) hb.hb_subset_input_destroy(input);
        hb.hb_face_destroy(face);
        hb.free(data);
      }
    },
  };
}
