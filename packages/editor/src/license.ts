import { verifyAsync } from '@noble/ed25519';

/**
 * Licence keys: `pdfsdk1.<payload>.<signature>`, both base64url. The payload
 * is JSON (`LicensePayload`), signed with Ed25519 by `scripts/license.mjs`
 * using a private key that never leaves the vendor. The SDK checks the
 * signature offline with the public key below, so files and keys are never
 * sent anywhere.
 */
export const LICENSE_PREFIX = 'pdfsdk1';

/** Public half of the signing key (raw Ed25519, base64url). Changing it invalidates every issued key. */
export const LICENSE_PUBLIC_KEY = 'KItsUBAAklmZK_c7BRouWEg7U5tjBlPa1IPlCiZE5O0';

export interface LicensePayload {
  customer: string;
  /** Hostnames the key works on: `app.acme.com`, or `*.acme.com` for its subdomains. */
  domains: string[];
  plan: string;
  /** Last day the key is valid, `YYYY-MM-DD` (UTC). */
  expires: string;
  issued: string;
}

export type LicenseStatus = 'valid' | 'missing' | 'invalid' | 'expired' | 'wrong-domain';

export interface LicenseInfo {
  status: LicenseStatus;
  /** What the key says, when its signature checks out. */
  license?: LicensePayload;
  /** Why the editor runs as a trial, for the console and the host app. */
  message: string;
}

/** Local development works with any valid key, whatever domains it lists. */
const DEV_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1|.+\.localhost)$/;

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** True when `hostname` is `domain` or, for `*.domain`, one of its subdomains. */
export function matchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const pattern = domain.toLowerCase().trim();
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return host === pattern;
}

const trial = (status: LicenseStatus, message: string, license?: LicensePayload): LicenseInfo => ({
  status,
  message: `${message} The PDF SDK runs as a trial: pages and exported files carry a watermark.`,
  ...(license ? { license } : {}),
});

/**
 * Checks a licence key for the page's host. Never throws: anything but a
 * valid key for this host, today, is a trial.
 */
export async function checkLicense(
  key: string | undefined,
  hostname: string,
  today: Date = new Date(),
  publicKey: string = LICENSE_PUBLIC_KEY,
): Promise<LicenseInfo> {
  if (!key) return trial('missing', 'No licence key was passed (`licenseKey`).');
  const [prefix, payloadPart, signaturePart, ...rest] = key.trim().split('.');
  if (prefix !== LICENSE_PREFIX || !payloadPart || !signaturePart || rest.length) {
    return trial('invalid', 'The licence key is not in the expected format.');
  }
  let license: LicensePayload;
  try {
    const payload = fromBase64Url(payloadPart);
    const ok = await verifyAsync(fromBase64Url(signaturePart), payload, fromBase64Url(publicKey));
    if (!ok) return trial('invalid', 'The licence key is not genuine.');
    license = JSON.parse(new TextDecoder().decode(payload)) as LicensePayload;
  } catch {
    return trial('invalid', 'The licence key could not be read.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(license.expires) || today.toISOString().slice(0, 10) > license.expires) {
    return trial('expired', `The licence key for ${license.customer} expired on ${license.expires}.`, license);
  }
  if (!DEV_HOST.test(hostname) && !license.domains.some((domain) => matchesDomain(hostname, domain))) {
    return trial('wrong-domain', `The licence key for ${license.customer} does not cover ${hostname}.`, license);
  }
  return { status: 'valid', license, message: `Licensed to ${license.customer} (${license.plan}) until ${license.expires}.` };
}
