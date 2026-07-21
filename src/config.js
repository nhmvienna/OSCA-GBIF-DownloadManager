import path from 'node:path';

function intEnv(name, fallback, { min = Number.MIN_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return parsed;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const dataDir = process.env.DATA_DIR || path.resolve('data');

export const config = Object.freeze({
  host: process.env.HOST || '0.0.0.0',
  port: intEnv('PORT', 3000, { min: 1 }),
  dataDir,
  databasePath: process.env.DATABASE_PATH || path.join(dataDir, 'manager.sqlite'),
  artifactDir: process.env.ARTIFACT_DIR || path.join(dataDir, 'artifacts'),

  appUsername: process.env.APP_USERNAME || '',
  appPassword: process.env.APP_PASSWORD || '',

  gbifUsername: process.env.GBIF_USERNAME || '',
  gbifPassword: process.env.GBIF_PASSWORD || '',
  gbifEmail: process.env.GBIF_EMAIL || '',
  gbifApiBase: process.env.GBIF_API_BASE || 'https://api.gbif.org/v1',

  pollIntervalMs: intEnv('GBIF_POLL_INTERVAL_SECONDS', 60, { min: 5 }) * 1000,
  attemptTimeoutMs: intEnv('GBIF_ATTEMPT_TIMEOUT_HOURS', 12, { min: 1 }) * 60 * 60 * 1000,
  retryIntervalMs: intEnv('GBIF_RETRY_INTERVAL_SECONDS', 3600, { min: 60 }) * 1000,
  retentionMs: intEnv('ARTIFACT_RETENTION_DAYS', 30, { min: 1 }) * 24 * 60 * 60 * 1000,
  workerTickMs: intEnv('WORKER_TICK_SECONDS', 1, { min: 1 }) * 1000,
  maxConcurrentLiveJobs: intEnv('MAX_CONCURRENT_LIVE_JOBS', 1, { min: 1 }),
  replayDurationMs: intEnv('REPLAY_DURATION_SECONDS', 8, { min: 0 }) * 1000,
  replayVerifySha256: boolEnv('REPLAY_VERIFY_SHA256', false),
  maxAttempts: intEnv('MAX_ATTEMPTS', 0, { min: 0 }),
  keepInvalidArtifacts: boolEnv('KEEP_INVALID_ARTIFACTS', false),

  maxZipEntryBytes: intEnv('MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES', 20 * 1024 ** 3, { min: 1 }),
  maxZipTotalBytes: intEnv('MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES', 50 * 1024 ** 3, { min: 1 }),
  maxZipCompressionRatio: intEnv('MAX_ZIP_COMPRESSION_RATIO', 1000, { min: 1 })
});

export function assertLiveGbifConfig() {
  const missing = [];
  if (!config.gbifUsername) missing.push('GBIF_USERNAME');
  if (!config.gbifPassword) missing.push('GBIF_PASSWORD');
  if (!config.gbifEmail) missing.push('GBIF_EMAIL');
  if (missing.length) {
    throw new Error(`Missing live-download configuration: ${missing.join(', ')}`);
  }
}
