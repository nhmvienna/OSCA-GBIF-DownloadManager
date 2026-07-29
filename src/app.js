import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { config } from './config.js';
import { Store } from './db.js';
import { canonicalizeGbifSearchUrl } from './query.js';
import { Worker } from './worker.js';
import { renderUi } from './ui.js';
import { nowIso, safeEqualText } from './util.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.artifactDir, { recursive: true });

if (Boolean(config.appUsername) !== Boolean(config.appPassword)) {
  throw new Error('APP_USERNAME and APP_PASSWORD must either both be set or both be empty');
}

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
const store = new Store(config.databasePath);
const worker = new Worker(store, app.log);

app.addHook('onRequest', async (request, reply) => {
  if (!config.appUsername || !config.appPassword || request.url === '/health') return;
  const header = request.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    reply.header('WWW-Authenticate', 'Basic realm="GBIF Download Manager"');
    return reply.code(401).send({ error: 'Authentication required' });
  }
  let credentials = '';
  try { credentials = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch {}
  const separator = credentials.indexOf(':');
  const username = separator >= 0 ? credentials.slice(0, separator) : '';
  const password = separator >= 0 ? credentials.slice(separator + 1) : '';
  if (!safeEqualText(username, config.appUsername) || !safeEqualText(password, config.appPassword)) {
    reply.header('WWW-Authenticate', 'Basic realm="GBIF Download Manager"');
    return reply.code(401).send({ error: 'Invalid credentials' });
  }
});

app.get('/health', async () => ({ ok: true, time: nowIso() }));
app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(renderUi()));
app.get('/openapi.yaml', async (_request, reply) => {
  const spec = fs.readFileSync(new URL('./openapi.yaml', import.meta.url), 'utf8');
  return reply.type('application/yaml; charset=utf-8').send(spec);
});

function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    originalUrl: row.original_url,
    canonicalUrl: row.canonical_url,
    queryHash: row.query_hash,
    requestedMode: row.requested_mode,
    sourceMode: row.source_mode,
    status: row.status,
    expectedCount: row.expected_count,
    gbifReportedCount: row.gbif_reported_count,
    artifactId: row.artifact_id,
    fixtureArtifactId: row.fixture_artifact_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    nextActionAt: row.next_action_at,
    error: row.error_message,
    replayed: row.source_mode === 'FIXTURE',
    downloadUrl: row.status === 'READY' && row.artifact_id && !row.artifact_deleted_at ? `/api/jobs/${row.id}/download` : null
  };
}

function createJobWithRaceSafeDedup(jobInput) {
  try {
    return { job: store.createJob(jobInput), deduplicated: false };
  } catch (error) {
    const uniqueQueryConflict = /UNIQUE constraint failed: jobs\.query_hash|idx_jobs_one_active_query/i.test(error.message || '');
    const active = uniqueQueryConflict ? store.findActiveJob(jobInput.queryHash) : null;
    if (active) return { job: store.getJob(active.id), deduplicated: true };
    throw error;
  }
}

app.post('/api/jobs', async (request, reply) => {
  const { url, mode = 'auto', fixtureArtifactId = null } = request.body || {};
  if (!url) return reply.code(400).send({ error: 'url is required' });
  if (!['auto', 'live', 'replay'].includes(mode)) return reply.code(400).send({ error: 'mode must be auto, live or replay' });

  let query;
  try { query = canonicalizeGbifSearchUrl(url); }
  catch (error) { return reply.code(400).send({ error: error.message }); }

  const active = store.findActiveJob(query.queryHash);
  if (active) {
    return reply.code(200).send({ job: publicJob(store.getJob(active.id)), deduplicated: true, alreadyRunning: true });
  }

  let fixture = null;
  if (mode === 'auto') fixture = store.getFixture(query.queryHash);
  if (mode === 'replay') {
    if (fixtureArtifactId) {
      const artifact = store.getArtifact(fixtureArtifactId);
      if (artifact && !artifact.deleted_at && artifact.validation_status === 'VALID') {
        fixture = { artifact_id: artifact.id };
      }
    } else {
      fixture = store.getFixture(query.queryHash);
    }
    if (!fixture) return reply.code(409).send({ error: 'No valid replay fixture is available for this query' });
  }
  const created = createJobWithRaceSafeDedup({
    id: crypto.randomUUID(),
    originalUrl: query.originalUrl,
    canonicalUrl: query.canonicalUrl,
    queryString: query.queryString,
    queryHash: query.queryHash,
    requestedMode: mode,
    sourceMode: fixture ? 'FIXTURE' : 'LIVE',
    status: 'QUEUED',
    fixtureArtifactId: fixture?.artifact_id || null,
    createdAt: nowIso(),
    nextActionAt: nowIso()
  });
  return reply.code(created.deduplicated ? 200 : 202).send({
    job: publicJob(created.job),
    deduplicated: created.deduplicated,
    alreadyRunning: created.deduplicated,
    fixtureMatched: Boolean(fixture)
  });
});

app.get('/api/jobs', async (request) => {
  const limit = Math.min(Number.parseInt(request.query?.limit || '200', 10) || 200, 1000);
  const offset = Math.max(Number.parseInt(request.query?.offset || '0', 10) || 0, 0);
  return { jobs: store.listJobs({ limit, offset }) };
});

app.get('/api/jobs/:id', async (request, reply) => {
  const job = store.getJobDetails(request.params.id);
  if (!job) return reply.code(404).send({ code: 'JOB_NOT_FOUND', error: 'Job not found' });
  return job;
});

app.post('/api/jobs/:id/retry', async (request, reply) => {
  try {
    const job = store.retryJobNow(request.params.id);
    if (!job) return reply.code(404).send({ code: 'JOB_NOT_FOUND', error: 'Job not found' });
    return { job: publicJob(job) };
  } catch (error) {
    if (['JOB_NOT_RETRYABLE', 'ACTIVE_JOB_EXISTS'].includes(error.code)) {
      return reply.code(409).send({ code: error.code, error: error.message });
    }
    throw error;
  }
});

app.delete('/api/jobs/:id', async (request, reply) => {
  try {
    const job = store.deleteJob(request.params.id);
    if (!job) return reply.code(404).send({ code: 'JOB_NOT_FOUND', error: 'Job not found' });
    return {
      deleted: true,
      id: job.id,
      code: 'JOB_DELETED',
      downstreamStatus: 'FAILED',
      message: 'The download job was deleted. Downstream imports must be marked failed and may be retried.'
    };
  } catch (error) {
    if (error.code === 'JOB_STILL_RUNNING') return reply.code(409).send({ code: error.code, error: error.message });
    throw error;
  }
});

app.get('/api/jobs/:id/download', async (request, reply) => {
  const job = store.getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  if (job.status !== 'READY' || !job.artifact_id) return reply.code(409).send({ error: 'Job is not ready' });
  const artifact = store.getArtifact(job.artifact_id);
  if (!artifact || artifact.deleted_at || !fs.existsSync(artifact.file_path)) return reply.code(410).send({ error: 'Artifact has expired or is missing' });

  reply.header('Content-Type', 'application/zip');
  reply.header('Content-Length', artifact.size_bytes);
  reply.header('Content-Disposition', `attachment; filename="${path.basename(artifact.original_filename)}"`);
  reply.header('ETag', `"sha256-${artifact.sha256}"`);
  reply.header('X-Artifact-Replayed', job.source_mode === 'FIXTURE' ? 'true' : 'false');
  reply.header('X-Artifact-Id', artifact.id);
  return reply.send(fs.createReadStream(artifact.file_path));
});

app.post('/api/jobs/:id/fixture', async (request, reply) => {
  const job = store.getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  if (job.status !== 'READY' || !job.artifact_id) return reply.code(409).send({ error: 'Only ready jobs can become fixtures' });
  const artifact = store.getArtifact(job.artifact_id);
  if (!artifact || artifact.validation_status !== 'VALID' || artifact.deleted_at) {
    return reply.code(409).send({ error: 'Artifact is not a valid active archive' });
  }
  const fixture = store.setFixture({ queryHash: job.query_hash, canonicalUrl: job.canonical_url, artifactId: artifact.id });
  store.addEvent(job.id, 'FIXTURE_ASSIGNED', 'Artifact pinned and assigned as fixture for this query', { artifactId: artifact.id });
  return { fixture };
});

app.delete('/api/jobs/:id/fixture', async (request, reply) => {
  const job = store.getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  return { removed: store.deleteFixture(job.query_hash) };
});

app.post('/api/jobs/:id/replay', async (request, reply) => {
  const sourceJob = store.getJob(request.params.id);
  if (!sourceJob) return reply.code(404).send({ error: 'Job not found' });
  if (sourceJob.status !== 'READY' || !sourceJob.artifact_id) return reply.code(409).send({ error: 'Source job is not ready' });
  const artifact = store.getArtifact(sourceJob.artifact_id);
  if (!artifact || artifact.validation_status !== 'VALID' || artifact.deleted_at) return reply.code(409).send({ error: 'Source artifact is unavailable' });
  const active = store.findActiveJob(sourceJob.query_hash);
  if (active) return { job: publicJob(store.getJob(active.id)), deduplicated: true, alreadyRunning: true };

  const created = createJobWithRaceSafeDedup({
    id: crypto.randomUUID(),
    originalUrl: sourceJob.original_url,
    canonicalUrl: sourceJob.canonical_url,
    queryString: sourceJob.query_string,
    queryHash: sourceJob.query_hash,
    requestedMode: 'replay',
    sourceMode: 'FIXTURE',
    status: 'QUEUED',
    fixtureArtifactId: artifact.id,
    createdAt: nowIso(),
    nextActionAt: nowIso()
  });
  return reply.code(created.deduplicated ? 200 : 202).send({
    job: publicJob(created.job),
    deduplicated: created.deduplicated,
    alreadyRunning: created.deduplicated
  });
});

app.post('/api/artifacts/:id/pin', async (request, reply) => {
  const pinned = Boolean(request.body?.pinned);
  const existingArtifact = store.getArtifact(request.params.id);
  if (!existingArtifact) return reply.code(404).send({ error: 'Artifact not found' });
  if (pinned && existingArtifact.validation_status !== 'VALID') {
    return reply.code(409).send({ error: 'Only valid artifacts can be pinned' });
  }
  if (!pinned && store.isArtifactMapped(request.params.id)) {
    return reply.code(409).send({ error: 'Remove the query fixture mapping before unpinning this artifact' });
  }
  const artifact = store.pinArtifact(request.params.id, {
    pinned,
    label: request.body?.label || null,
    description: request.body?.description || null,
    expiresAt: pinned ? null : new Date(Date.now() + config.retentionMs).toISOString()
  });
  if (!artifact) return reply.code(404).send({ error: 'Artifact not found' });
  return { artifact };
});

app.get('/api/artifacts', async (request) => {
  const limit = Math.min(Number.parseInt(request.query?.limit || '200', 10) || 200, 1000);
  return { artifacts: store.listArtifacts({ limit }) };
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
});

app.addHook('onClose', async () => {
  const stopped = await worker.stop();
  if (stopped) store.close();
});

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    try { await app.close(); } finally { process.exit(0); }
  });
}

worker.start();
await app.listen({ host: config.host, port: config.port });
