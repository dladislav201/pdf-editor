#!/usr/bin/env node
// Licence keys for @pdfsdk/editor (see packages/editor/src/license.ts).
//
//   node scripts/license.mjs keygen
//       Creates the signing key in ~/.pdfsdk/license-signing-key.pem (once) and
//       prints the public key to put in LICENSE_PUBLIC_KEY.
//   node scripts/license.mjs issue --customer "Acme Ltd" --domains "app.acme.com,*.acme.com" \
//       --plan business --expires 2027-10-31
//       Prints a key for that customer. `--key <file>` uses another signing key.
//
// The signing key must never be committed or shared: anyone with it can issue
// keys. Keep a backup somewhere safe (a password manager); losing it means
// shipping a new public key and reissuing every customer's key.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const PREFIX = 'pdfsdk1';
const DEFAULT_KEY = join(homedir(), '.pdfsdk', 'license-signing-key.pem');

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    key: { type: 'string', default: DEFAULT_KEY },
    customer: { type: 'string' },
    domains: { type: 'string' },
    plan: { type: 'string', default: 'business' },
    expires: { type: 'string' },
  },
});

const base64url = (bytes) => Buffer.from(bytes).toString('base64url');
const publicKeyOf = (privateKey) => createPublicKey(privateKey).export({ format: 'jwk' }).x;

function keygen() {
  if (existsSync(values.key)) {
    console.log(`Signing key already exists: ${values.key}`);
  } else {
    const { privateKey } = generateKeyPairSync('ed25519');
    mkdirSync(dirname(values.key), { recursive: true, mode: 0o700 });
    writeFileSync(values.key, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    console.log(`Created signing key: ${values.key} (back it up, never commit it)`);
  }
  console.log(`LICENSE_PUBLIC_KEY = '${publicKeyOf(createPrivateKey(readFileSync(values.key)))}'`);
}

function issue() {
  const { customer, domains, plan, expires } = values;
  if (!customer || !domains || !expires) {
    throw new Error('issue needs --customer, --domains and --expires (YYYY-MM-DD).');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new Error('--expires must be YYYY-MM-DD.');
  const payload = {
    customer,
    domains: domains.split(',').map((d) => d.trim()).filter(Boolean),
    plan,
    expires,
    issued: new Date().toISOString().slice(0, 10),
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  const signature = sign(null, bytes, createPrivateKey(readFileSync(values.key)));
  console.log(`${PREFIX}.${base64url(bytes)}.${base64url(signature)}`);
}

const command = positionals[0];
if (command === 'keygen') keygen();
else if (command === 'issue') issue();
else {
  console.error('Usage: node scripts/license.mjs keygen | issue --customer … --domains … --expires YYYY-MM-DD [--plan …]');
  process.exit(1);
}
