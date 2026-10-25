import { generateKeyPairSync, sign } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { exportPdf } from './export';
import { LICENSE_PREFIX, checkLicense, matchesDomain, type LicensePayload } from './license';

// A throwaway key pair, issuing keys exactly as scripts/license.mjs does.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUBLIC = publicKey.export({ format: 'jwk' }).x!;
const issue = (payload: Partial<LicensePayload>, key = privateKey) => {
  const bytes = Buffer.from(
    JSON.stringify({ customer: 'Acme', domains: ['app.acme.com'], plan: 'business', expires: '2027-06-30', issued: '2026-10-25', ...payload }),
  );
  return `${LICENSE_PREFIX}.${bytes.toString('base64url')}.${sign(null, bytes, key).toString('base64url')}`;
};
const TODAY = new Date('2026-10-25T12:00:00Z');
const check = (key: string | undefined, host: string, today = TODAY) => checkLicense(key, host, today, PUBLIC);

describe('licence keys', () => {
  it('accepts a genuine key on its domain until it expires, and on localhost', async () => {
    const key = issue({});
    expect(await check(key, 'app.acme.com')).toMatchObject({ status: 'valid', license: { customer: 'Acme', plan: 'business' } });
    expect((await check(key, 'localhost')).status).toBe('valid');
    expect((await check(key, 'app.acme.com', new Date('2027-06-30T23:00:00Z'))).status).toBe('valid');
    expect((await check(key, 'app.acme.com', new Date('2027-07-01T00:00:00Z'))).status).toBe('expired');
  });

  it('runs as a trial without a key, with a forged or edited key, or on another domain', async () => {
    expect((await check(undefined, 'app.acme.com')).status).toBe('missing');
    expect((await check('not a key', 'app.acme.com')).status).toBe('invalid');
    expect((await check(issue({}), 'evil.com')).status).toBe('wrong-domain');
    // Signed with somebody else's key.
    expect((await check(issue({}, generateKeyPairSync('ed25519').privateKey), 'app.acme.com')).status).toBe('invalid');
    // A payload changed after signing (another domain, a later date).
    const [prefix, , signature] = issue({}).split('.');
    const forged = Buffer.from(JSON.stringify({ customer: 'Acme', domains: ['evil.com'], plan: 'business', expires: '2099-01-01', issued: '2026-10-25' }));
    const result = await check(`${prefix}.${forged.toString('base64url')}.${signature}`, 'evil.com');
    expect(result.status).toBe('invalid');
    expect(result.message).toContain('trial');
  });

  it('matches exact hosts and wildcard subdomains', () => {
    expect(matchesDomain('app.acme.com', 'app.acme.com')).toBe(true);
    expect(matchesDomain('eu.app.acme.com', '*.acme.com')).toBe(true);
    expect(matchesDomain('acme.com', '*.acme.com')).toBe(false);
    expect(matchesDomain('notacme.com', '*.acme.com')).toBe(false);
    expect(matchesDomain('APP.ACME.COM.', 'app.acme.com')).toBe(true);
  });

  it('stamps the trial watermark on every exported page', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 300]);
    doc.addPage([300, 400]);
    const plain = await exportPdf(await doc.save(), []);
    const stamped = await exportPdf(await doc.save(), [], { watermark: 'PDF SDK trial' });
    const contents = async (bytes: Uint8Array) => {
      const loaded = await PDFDocument.load(bytes);
      return loaded.getPages().map((page) => page.node.Contents()?.toString() ?? '');
    };
    expect((await contents(plain)).every((c) => !c.includes('Helvetica'))).toBe(true);
    const pages = await PDFDocument.load(stamped);
    expect(pages.getPageCount()).toBe(2);
    for (const page of pages.getPages()) expect(page.node.Resources()?.toString()).toContain('Helvetica-Bold');
  });
});
