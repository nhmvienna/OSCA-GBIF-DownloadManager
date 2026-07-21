import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { assertLiveGbifConfig, config } from './config.js';

function basicAuth() {
  return `Basic ${Buffer.from(`${config.gbifUsername}:${config.gbifPassword}`).toString('base64')}`;
}

async function checkedFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': 'gbif-download-manager/0.1.2',
      Accept: 'application/json',
      ...(options.headers || {})
    },
    signal: options.signal || AbortSignal.timeout(120_000)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GBIF ${response.status} ${response.statusText} for ${response.url}: ${body.slice(0, 1000)}`);
  }
  return response;
}

export function gbifQueryUrl(endpoint, queryString, extra = {}) {
  const params = new URLSearchParams(queryString);
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return `${config.gbifApiBase}${endpoint}?${params.toString()}`;
}

export async function resolvePredicate(queryString) {
  const response = await checkedFetch(
    gbifQueryUrl('/occurrence/download/request/predicate', queryString, { format: 'DWCA' })
  );
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`GBIF returned a non-JSON predicate: ${text.slice(0, 1000)}`);
  }
  return parsed;
}

export async function getExpectedCount(queryString) {
  const response = await checkedFetch(gbifQueryUrl('/occurrence/search', queryString, { limit: 1 }));
  const data = await response.json();
  if (!Number.isSafeInteger(data.count) || data.count < 0) {
    throw new Error('GBIF search response did not contain a valid count');
  }
  return data.count;
}

function normalizePredicateResponse(value) {
  if (value && typeof value === 'object' && value.predicate) {
    return { predicate: value.predicate, checklistKey: value.checklistKey || null };
  }
  return { predicate: value, checklistKey: null };
}

export async function submitDownload(predicateResponse) {
  assertLiveGbifConfig();
  const { predicate, checklistKey } = normalizePredicateResponse(predicateResponse);
  const body = {
    notificationAddresses: [config.gbifEmail],
    sendNotification: false,
    format: 'DWCA',
    predicate
  };
  if (checklistKey) body.checklistKey = checklistKey;

  const response = await checkedFetch(`${config.gbifApiBase}/occurrence/download/request`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/json',
      Accept: 'text/plain'
    },
    body: JSON.stringify(body)
  });
  const key = (await response.text()).trim().replace(/^"|"$/g, '');
  if (!/^\d{7,}-\d{15,}$/.test(key)) {
    throw new Error(`GBIF returned an unexpected download key: ${key}`);
  }
  return key;
}

export async function getDownloadStatus(key) {
  const response = await checkedFetch(`${config.gbifApiBase}/occurrence/download/${encodeURIComponent(key)}`);
  return response.json();
}

export async function cancelDownload(key) {
  assertLiveGbifConfig();
  const response = await fetch(`${config.gbifApiBase}/occurrence/download/request/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { Authorization: basicAuth(), 'User-Agent': 'gbif-download-manager/0.1.2' },
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    const body = await response.text().catch(() => '');
    throw new Error(`Unable to cancel GBIF download ${key}: ${response.status} ${body.slice(0, 500)}`);
  }
}

export function extractStatusFields(data) {
  const status = String(data.status || data.downloadStatus || '').toUpperCase();
  const downloadUrl = data.downloadLink || data.downloadUrl || null;
  const doi = data.doi || data.doiUrl || null;
  const countCandidates = [data.totalRecords, data.recordCount, data.total];
  const reportedCount = countCandidates.find((value) => Number.isSafeInteger(value) && value >= 0) ?? null;
  const available = typeof data.available === 'boolean' ? data.available : null;
  const size = Number.isSafeInteger(data.size) && data.size >= 0 ? data.size : null;
  return { status, downloadUrl, doi, reportedCount, available, size };
}

export function artifactUrlCandidates(key, reportedUrl = null) {
  const encodedKey = encodeURIComponent(key);
  const apiBase = config.gbifApiBase.replace(/\/$/, '');
  const apiOrigin = new URL(apiBase).origin;
  return [...new Set([
    reportedUrl,
    // Current GBIF guide uses the unversioned public redirect endpoint.
    `${apiOrigin}/occurrence/download/request/${encodedKey}.zip`,
    // The OpenAPI endpoint is versioned and accepts the key with or without the suffix.
    `${apiBase}/occurrence/download/request/${encodedKey}.zip`,
    `${apiBase}/occurrence/download/request/${encodedKey}`
  ].filter(Boolean))];
}

export class ArtifactUnavailableError extends Error {
  constructor(message, attempts) {
    super(message);
    this.name = 'ArtifactUnavailableError';
    this.attempts = attempts;
  }
}

export async function downloadToFile(urlOrUrls, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
  const attempts = [];

  for (const url of urls) {
    fs.rmSync(destination, { force: true });
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': 'gbif-download-manager/0.1.2', Accept: 'application/zip, application/octet-stream' },
        redirect: 'follow',
        signal: AbortSignal.timeout(24 * 60 * 60 * 1000)
      });
    } catch (error) {
      attempts.push({ url, error: error.message });
      continue;
    }

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      attempts.push({
        url,
        finalUrl: response.url,
        status: response.status,
        statusText: response.statusText,
        body: body.slice(0, 500)
      });
      continue;
    }

    try {
      await pipeline(response.body, fs.createWriteStream(destination, { flags: 'wx' }));
      return {
        contentLength: Number.parseInt(response.headers.get('content-length') || '', 10) || null,
        finalUrl: response.url,
        requestedUrl: url,
        attempts
      };
    } catch (error) {
      fs.rmSync(destination, { force: true });
      attempts.push({ url, finalUrl: response.url, error: error.message });
    }
  }

  const summary = attempts.map((attempt) => {
    if (attempt.status) return `${attempt.status} ${attempt.url}`;
    return `${attempt.error || 'unknown error'} ${attempt.url}`;
  }).join('; ');
  throw new ArtifactUnavailableError(`GBIF artifact is not available yet: ${summary}`, attempts);
}
