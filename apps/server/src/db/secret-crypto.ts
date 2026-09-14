import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../env.ts';

const PREFIX = 'enc:v1';
let cachedKey: Buffer | null = null;

export function encryptSecretPayload(plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [PREFIX, nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
}

export function decryptSecretPayload(payload: string): string {
  if (!payload.startsWith(`${PREFIX}:`)) return payload;
  const [, , nonceText, tagText, ciphertextText] = payload.split(':');
  if (!nonceText || !tagText || !ciphertextText) throw new Error('Invalid encrypted secret payload.');

  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(nonceText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const source = config.secretsKey || readOrCreateKey();
  cachedKey = createHash('sha256').update(source).digest();
  return cachedKey;
}

function readOrCreateKey(): string {
  const path = join(config.dataDir, 'secrets.key');
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    const generated = randomBytes(32).toString('base64url');
    try {
      writeFileSync(path, generated, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return generated;
    } catch {
      return readFileSync(path, 'utf8').trim();
    }
  }
}