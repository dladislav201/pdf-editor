/**
 * Clean-ups for Tesseract's ukr+eng output. With both scripts loaded, Latin
 * look-alikes creep into Cyrillic text ("TOBAPUCTBO", "Ha", "Ne 1"); inside a
 * Cyrillic line such words are mapped back, while real Latin words (BASF,
 * ADBLUE, an IBAN) contain letters with no Cyrillic twin and stay as they are.
 */
const LOOKALIKE: Record<string, string> = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', I: 'І', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
  a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у', n: 'п', u: 'и', r: 'г',
};

const count = (text: string, script: RegExp) => (text.match(script) ?? []).length;
const CYRILLIC = /\p{Script=Cyrillic}/gu;
const LATIN = /\p{Script=Latin}/gu;

/** Fixes one word given whether its line is mostly Cyrillic. */
export function fixWord(word: string, cyrillicLine: boolean): string {
  // The numero sign comes out as "Ne"/"No" (or Cyrillic "Мо") before a number or a code.
  let fixed = word.replace(/^(Ne|No|N°|Na|Мо|Ио)(?=[\dA-ZА-ЯІЇЄҐ]|$)/u, '№');
  const letters = [...fixed].filter((c) => /\p{L}/u.test(c));
  const twinsOnly = letters.length > 0 && letters.every((c) => /\p{Script=Cyrillic}/u.test(c) || c in LOOKALIKE);
  if (count(fixed, LATIN) > 0 && twinsOnly && (count(fixed, CYRILLIC) > 0 || cyrillicLine)) {
    fixed = [...fixed].map((c) => LOOKALIKE[c] ?? c).join('');
  }
  return fixed;
}

/** Fixes the words of one line. */
export function fixLine(words: string[]): string[] {
  const joined = words.join(' ');
  const cyrillicLine = count(joined, CYRILLIC) > count(joined, LATIN);
  return words.map((w) => fixWord(w, cyrillicLine));
}

/**
 * Low-confidence words on scans are mostly logos, stamp traces and specks
 * read as letters. Dropping them costs very little real text.
 */
export function isNoise(text: string, confidence: number): boolean {
  if (confidence < 35) return true;
  // Punctuation-only fragments with middling confidence are almost always specks.
  return confidence < 60 && !/[\p{L}\p{N}]/u.test(text);
}
