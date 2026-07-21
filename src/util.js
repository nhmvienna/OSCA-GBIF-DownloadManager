import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

export function nowIso() {
  return new Date().toISOString();
}

export function isoAfter(ms) {
  return new Date(Date.now() + ms).toISOString();
}

export function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

export function jsonParse(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function jsonStringify(value) {
  return JSON.stringify(value ?? null);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function safeEqualText(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function clampString(value, max = 2000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
