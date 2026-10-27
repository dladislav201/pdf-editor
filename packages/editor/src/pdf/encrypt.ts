import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  PDFString,
  type PDFObject,
  type PDFRef,
} from 'pdf-lib';

/**
 * Encryption of a whole PDF with a password to open it: the standard
 * security handler, revision 6 (PDF 2.0, AES-256), which Acrobat, Preview,
 * Chrome and pdf.js all open. Built on Web Crypto, so it runs in browsers
 * and Node alike.
 */

const encoder = new TextEncoder();
/** Every permission granted (bits 1–2 must be 0): the password protects opening, not use. */
const ALL_PERMISSIONS = -4;

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const buffer = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;

async function digest(algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512', data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, buffer(data)));
}

/** AES-CBC with PKCS#7 padding: what strings and streams are encrypted with (IV first). */
async function aesCbc(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', buffer(key), 'AES-CBC', false, ['encrypt']);
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: buffer(iv) }, cryptoKey, buffer(data)));
}

/** AES-CBC without padding, for data a multiple of 16 bytes long: Web Crypto always pads, so the padding block is dropped. */
async function aesCbcNoPadding(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return (await aesCbc(key, iv, data)).subarray(0, data.length);
}

/**
 * A password as the handler takes it: UTF-8, at most 127 bytes, normalized
 * as the standard asks (NFKC, in place of SASLprep) or as Apple's PDFKit
 * does (NFD: "ü" as "u" and a combining mark).
 */
function passwordBytes(password: string, form: 'NFKC' | 'NFD'): Uint8Array {
  return encoder.encode(password.normalize(form)).subarray(0, 127);
}

/** Algorithm 2.B of ISO 32000-2: the hash a password is checked and its key made with. */
async function hash(password: Uint8Array, salt: Uint8Array, userKey: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
  let k = await digest('SHA-256', concat(password, salt, userKey));
  let e: Uint8Array = new Uint8Array();
  for (let round = 0; round < 64 || e[e.length - 1]! > round - 32; round++) {
    const block = concat(password, k, userKey);
    const k1 = new Uint8Array(block.length * 64);
    for (let i = 0; i < 64; i++) k1.set(block, i * block.length);
    e = await aesCbcNoPadding(k.subarray(0, 16), k.subarray(16, 32), k1);
    // The first 16 bytes as a number mod 3 is the sum of the bytes mod 3 (256 ≡ 1).
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i]!;
    k = await digest(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3] as 'SHA-256', e);
  }
  return k.subarray(0, 32);
}

/** The encryption dictionary's values for a file key, a password to open and one to change permissions. */
async function securityValues(fileKey: Uint8Array, user: Uint8Array, owner: Uint8Array) {
  const [userValidation, userKeySalt, ownerValidation, ownerKeySalt] = [random(8), random(8), random(8), random(8)];
  const zero = new Uint8Array(16);
  const U = concat(await hash(user, userValidation), userValidation, userKeySalt);
  const UE = await aesCbcNoPadding(await hash(user, userKeySalt), zero, fileKey);
  const O = concat(await hash(owner, ownerValidation, U), ownerValidation, ownerKeySalt);
  const OE = await aesCbcNoPadding(await hash(owner, ownerKeySalt, U), zero, fileKey);
  // Permissions (low byte first), then "T" for encrypted metadata and "adb", sealed with the file key (ECB = CBC on one block, zero IV).
  const perms = new Uint8Array(16);
  new DataView(perms.buffer).setInt32(0, ALL_PERMISSIONS, true);
  perms.set([0xff, 0xff, 0xff, 0xff], 4);
  perms.set(encoder.encode('Tadb'), 8);
  perms.set(random(4), 12);
  const Perms = await aesCbcNoPadding(fileKey, zero, perms);
  return { U, UE, O, OE, Perms };
}

export interface EncryptOptions {
  /** Needed to open the file. Once open, everything is allowed: printing, copying, editing. */
  password: string;
}

/**
 * Returns `bytes` encrypted so they open only with the password: every
 * string and stream of the file is encrypted with AES-256 under a random
 * key, which only the password unlocks. Object streams are written out as
 * plain objects first (their contents would otherwise be encrypted twice).
 */
export async function encryptPdf(bytes: Uint8Array, options: EncryptOptions): Promise<Uint8Array> {
  if (!options.password) throw new Error('A password is needed to protect the PDF.');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const context = doc.context;
  if (context.trailerInfo.Encrypt) throw new Error('The PDF is protected already.');
  const fileKey = random(32);

  const encryptBytes = async (data: Uint8Array) => {
    const iv = random(16);
    return concat(iv, await aesCbc(fileKey, iv, data));
  };
  /** The object with its strings encrypted (in place where it can be changed). */
  const encryptObject = async (object: PDFObject): Promise<PDFObject> => {
    if (object instanceof PDFString || object instanceof PDFHexString) {
      return PDFHexString.of([...(await encryptBytes(object.asBytes()))].map((b) => b.toString(16).padStart(2, '0')).join(''));
    }
    if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) object.set(key, await encryptObject(value));
    } else if (object instanceof PDFArray) {
      for (let i = 0; i < object.size(); i++) object.set(i, await encryptObject(object.get(i)));
    }
    return object;
  };

  for (const [ref, object] of context.enumerateIndirectObjects() as [PDFRef, PDFObject][]) {
    if (object instanceof PDFStream) {
      const type = object.dict.lookupMaybe(PDFName.of('Type'), PDFName)?.decodeText();
      // pdf-lib reads the objects out of object and cross-reference streams; written plainly, those go.
      if (type === 'ObjStm' || type === 'XRef') {
        context.delete(ref);
        continue;
      }
      await encryptObject(object.dict);
      const contents = await encryptBytes(object.getContents());
      context.assign(ref, PDFRawStream.of(object.dict, contents));
    } else {
      context.assign(ref, await encryptObject(object));
    }
  }

  // The password opens the file as the user password, as the standard has it, and as the owner
  // password the way Preview and Safari spell it: a viewer tries both, so it opens everywhere.
  const values = await securityValues(fileKey, passwordBytes(options.password, 'NFKC'), passwordBytes(options.password, 'NFD'));
  const hex = (data: Uint8Array) => PDFHexString.of([...data].map((b) => b.toString(16).padStart(2, '0')).join(''));
  const encrypt = context.obj({
    Filter: 'Standard',
    V: 5,
    R: 6,
    Length: 256,
    CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 } },
    StmF: 'StdCF',
    StrF: 'StdCF',
    P: PDFNumber.of(ALL_PERMISSIONS),
    EncryptMetadata: true,
    U: hex(values.U),
    UE: hex(values.UE),
    O: hex(values.O),
    OE: hex(values.OE),
    Perms: hex(values.Perms),
  });
  context.trailerInfo.Encrypt = context.register(encrypt);
  // The file identifier isn't encrypted; a protected file must have one.
  const id = hex(random(16));
  context.trailerInfo.ID = context.obj([id, id]);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}
