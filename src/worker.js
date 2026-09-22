import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import {
  artifactUrlCandidates,
  cancelDownload,
  GbifAuthenticationError,
  downloadToFile,
  extractStatusFields,
  getDownloadStatus,
  getExpectedCount,
  resolvePredicate,
  submitDownload
} from './gbif.js';
import { validateDwca } from './zip.js';
import { isoAfter, jsonParse, nowIso, sha256File, sleep } from './util.js';

const TERMINAL_GBIF_FAILURES = new Set(['FAILED', 'KILLED', 'CANCELLED']);
const GBIF_IN_PROGRESS = new Set(['PREPARING', 'RUNNING', 'SUSPENDED']);

export class Worker {
  constructor(store, logger = console) {
    this.store = store;
    this.logger = logger;
    this.id = `worker-${process.pid}-${crypto.randomUUID()}`;
    this.timer = null;
    this.cleanupTimer = null;
    this.running = false;
    this.stopping = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => this.logger.error(error)), config.workerTickMs);
    this.cleanupTimer = setInterval(() => this.cleanup().catch((error) => this.logger.error(error)), 60 * 60 * 1000);
    this.tick().catch((error) => this.logger.error(error));
    this.cleanup().catch((error) => this.logger.error(error));
  }

  async stop({ timeoutMs = 5000 } = {}) {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.timer = null;
    this.cleanupTimer = null;
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline) await sleep(50);
    return !this.running;
  }

  async tick() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const job = this.store.claimDueJob(this.id);
      if (!job) return;
      try {
        await this.process(job);
      } catch (error) {
        this.logger.error({ err: error, jobId: job.id }, 'Job processing failed');
        this.handleProcessingError(job.id, error);
      } finally {
        this.store.releaseJob(job.id, this.store.getJob(job.id)?.next_action_at || null);
      }
    } finally {
      this.running = false;
    }
  }

  handleProcessingError(jobId, error) {
    const job = this.store.getJob(jobId);
    if (!job || !job.is_active) return;
    if (job.status === 'DOWNLOADING' && error.name === 'ArtifactUnavailableError') {
      const attempt = this.store.getAttempt(job.current_attempt_id);
      if (attempt) {
        const { partialPath } = this.artifactPaths(attempt);
        fs.rmSync(partialPath, { force: true });
      }
      this.store.addEvent(job.id, 'ARTIFACT_NOT_AVAILABLE', error.message, {
        status: job.status,
        attempts: error.attempts || []
      }, 'warn');
      this.store.updateJob(job.id, {
        error_message: error.message,
        next_action_at: isoAfter(Math.max(config.pollIntervalMs, 5 * 60 * 1000))
      });
      return;
    }

    this.store.addEvent(job.id, 'PROCESSING_ERROR', error.message, { status: job.status }, 'error');

    if (error instanceof GbifAuthenticationError) {
      this.store.updateJob(job.id, {
        error_message: error.message,
        status: 'FAILED_PERMANENTLY',
        is_active: 0,
        completed_at: nowIso(),
        next_action_at: null
      });
      this.store.addEvent(job.id, 'GBIF_AUTHENTICATION_FAILED', 'GBIF rejected the configured credentials; automatic retries were stopped', null, 'error');
      return;
    }

    if (job.status === 'WAITING_FOR_GBIF') {
      this.store.updateJob(job.id, { error_message: error.message, next_action_at: isoAfter(config.pollIntervalMs) });
      return;
    }
    if (job.status === 'DOWNLOADING') {
      const attempt = this.store.getAttempt(job.current_attempt_id);
      if (attempt) {
        const { partialPath } = this.artifactPaths(attempt);
        fs.rmSync(partialPath, { force: true });
      }
      this.store.updateJob(job.id, { error_message: error.message, next_action_at: isoAfter(Math.max(config.pollIntervalMs, 5 * 60 * 1000)) });
      return;
    }
    if (job.status === 'RESOLVING_QUERY') {
      this.store.updateJob(job.id, { error_message: error.message, next_action_at: isoAfter(config.pollIntervalMs) });
      return;
    }
    this.store.updateJob(job.id, {
      error_message: error.message,
      status: 'RETRY_WAIT',
      next_action_at: isoAfter(config.retryIntervalMs)
    });
  }

  async process(job) {
    const latest = this.store.getJob(job.id);
    if (!latest || !latest.is_active) return;
    if (latest.source_mode === 'FIXTURE') return this.processReplay(latest);

    switch (latest.status) {
      case 'QUEUED':
        return this.beginResolution(latest);
      case 'RESOLVING_QUERY':
        return this.resolveQuery(latest);
      case 'SUBMITTING_TO_GBIF':
        return this.submit(latest);
      case 'WAITING_FOR_GBIF':
        return this.poll(latest);
      case 'DOWNLOADING':
        return this.download(latest);
      case 'VALIDATING':
        return this.validate(latest);
      case 'RETRY_WAIT':
        return this.retry(latest);
      default:
        throw new Error(`Unsupported active job status: ${latest.status}`);
    }
  }

  beginResolution(job) {
    this.store.updateJob(job.id, { status: 'RESOLVING_QUERY', next_action_at: nowIso(), error_message: null });
    this.store.addEvent(job.id, 'RESOLVING_QUERY', 'Resolving GBIF query and expected count');
  }

  async resolveQuery(job) {
    const [predicate, expectedCount] = await Promise.all([
      resolvePredicate(job.query_string),
      getExpectedCount(job.query_string)
    ]);
    this.store.updateJob(job.id, {
      predicate_json: JSON.stringify(predicate),
      expected_count: expectedCount,
      status: 'SUBMITTING_TO_GBIF',
      next_action_at: nowIso(),
      error_message: null
    });
    this.store.addEvent(job.id, 'QUERY_RESOLVED', `GBIF query resolved with ${expectedCount} expected records`, { expectedCount });
  }

  async submit(job) {
    if (this.store.countActiveLiveJobs(job.id) >= config.maxConcurrentLiveJobs) {
      this.store.updateJob(job.id, { next_action_at: isoAfter(config.pollIntervalMs) });
      return;
    }

    const attemptNumber = this.store.nextAttemptNumber(job.id);
    if (config.maxAttempts > 0 && attemptNumber > config.maxAttempts) {
      this.store.updateJob(job.id, {
        status: 'FAILED_PERMANENTLY',
        is_active: 0,
        completed_at: nowIso(),
        error_message: `Maximum attempts (${config.maxAttempts}) reached`
      });
      this.store.addEvent(job.id, 'MAX_ATTEMPTS_REACHED', 'Job stopped after maximum attempts', null, 'error');
      return;
    }

    const key = await submitDownload(jsonParse(job.predicate_json));
    const attemptId = crypto.randomUUID();
    const now = nowIso();
    this.store.createAttempt({
      id: attemptId,
      jobId: job.id,
      attemptNumber,
      gbifDownloadKey: key,
      gbifStatus: 'SUBMITTED',
      submittedAt: now,
      createdAt: now
    });

    if (job.last_invalid_gbif_key && key === job.last_invalid_gbif_key) {
      this.store.updateAttempt(attemptId, {
        gbif_status: 'REUSED_INVALID',
        finished_at: now,
        failure_reason: 'GBIF returned the same previously invalid download key'
      });
      this.store.updateJob(job.id, {
        status: 'RETRY_WAIT',
        next_action_at: isoAfter(config.retryIntervalMs),
        error_message: 'GBIF reused the previously invalid artifact; waiting before retry'
      });
      this.store.addEvent(job.id, 'INVALID_KEY_REUSED', `GBIF reused invalid key ${key}; artifact not downloaded again`, { key }, 'warn');
      return;
    }

    this.store.updateJob(job.id, {
      status: 'WAITING_FOR_GBIF',
      current_attempt_id: attemptId,
      next_action_at: now,
      error_message: null
    });
    this.store.addEvent(job.id, 'GBIF_SUBMITTED', `GBIF download requested: ${key}`, { key, attemptNumber });
  }

  async poll(job) {
    const attempt = this.store.getAttempt(job.current_attempt_id);
    if (!attempt) throw new Error('Current attempt is missing');

    const age = Date.now() - new Date(attempt.submitted_at).getTime();
    if (age > config.attemptTimeoutMs) {
      await cancelDownload(attempt.gbif_download_key).catch((error) => {
        this.store.addEvent(job.id, 'GBIF_CANCEL_FAILED', error.message, null, 'warn');
      });
      this.store.updateAttempt(attempt.id, {
        gbif_status: 'TIMED_OUT',
        finished_at: nowIso(),
        failure_reason: 'GBIF generation exceeded attempt timeout'
      });
      this.store.updateJob(job.id, {
        status: 'RETRY_WAIT',
        next_action_at: isoAfter(config.retryIntervalMs),
        error_message: 'GBIF generation timed out'
      });
      this.store.addEvent(job.id, 'GBIF_TIMEOUT', `GBIF attempt exceeded ${config.attemptTimeoutMs / 3600000} hours`, null, 'warn');
      return;
    }

    const rawStatus = await getDownloadStatus(attempt.gbif_download_key);
    const status = extractStatusFields(rawStatus);
    this.store.updateAttempt(attempt.id, {
      gbif_status: status.status,
      gbif_download_url: status.downloadUrl,
      gbif_doi: status.doi,
      gbif_reported_count: status.reportedCount,
      last_polled_at: nowIso()
    });
    if (Number.isSafeInteger(status.reportedCount)) {
      this.store.updateJob(job.id, { gbif_reported_count: status.reportedCount });
    }

    if (status.status === 'SUCCEEDED') {
      this.store.updateJob(job.id, { status: 'DOWNLOADING', next_action_at: nowIso() });
      this.store.addEvent(job.id, 'GBIF_READY', `GBIF download ${attempt.gbif_download_key} is ready`, status);
      return;
    }
    if (TERMINAL_GBIF_FAILURES.has(status.status)) {
      this.store.updateAttempt(attempt.id, {
        finished_at: nowIso(),
        failure_reason: `GBIF status ${status.status}`
      });
      this.store.updateJob(job.id, {
        status: 'RETRY_WAIT',
        next_action_at: isoAfter(config.retryIntervalMs),
        error_message: `GBIF attempt ended with ${status.status}`
      });
      this.store.addEvent(job.id, 'GBIF_FAILED', `GBIF attempt ended with ${status.status}`, rawStatus, 'warn');
      return;
    }
    if (!GBIF_IN_PROGRESS.has(status.status) && status.status) {
      this.store.addEvent(job.id, 'GBIF_UNKNOWN_STATUS', `Unknown GBIF status ${status.status}; continuing to poll`, rawStatus, 'warn');
    }
    this.store.updateJob(job.id, { next_action_at: isoAfter(config.pollIntervalMs) });
  }

  artifactPaths(attempt) {
    const finalPath = path.join(config.artifactDir, `${attempt.gbif_download_key}.zip`);
    return { finalPath, partialPath: `${finalPath}.part` };
  }

  async download(job) {
    let attempt = this.store.getAttempt(job.current_attempt_id);
    if (!attempt) throw new Error('Current attempt is missing');

    const age = Date.now() - new Date(attempt.submitted_at).getTime();
    if (age > config.attemptTimeoutMs) {
      const now = nowIso();
      this.store.updateAttempt(attempt.id, {
        gbif_status: 'ARTIFACT_UNAVAILABLE_TIMEOUT',
        finished_at: now,
        failure_reason: 'GBIF reported SUCCEEDED but the artifact remained unavailable'
      });
      this.store.updateJob(job.id, {
        status: 'RETRY_WAIT',
        next_action_at: isoAfter(config.retryIntervalMs),
        error_message: 'GBIF artifact remained unavailable after the attempt timeout'
      });
      this.store.addEvent(job.id, 'ARTIFACT_TIMEOUT', 'GBIF reported SUCCEEDED but did not make the artifact available in time', {
        key: attempt.gbif_download_key,
        timeoutMs: config.attemptTimeoutMs
      }, 'warn');
      return;
    }

    // Refresh metadata before every artifact attempt. A downloadLink can appear after SUCCEEDED.
    const rawStatus = await getDownloadStatus(attempt.gbif_download_key);
    const refreshed = extractStatusFields(rawStatus);
    const attemptUpdates = {
      gbif_status: refreshed.status || attempt.gbif_status,
      last_polled_at: nowIso()
    };
    if (refreshed.downloadUrl) attemptUpdates.gbif_download_url = refreshed.downloadUrl;
    if (refreshed.doi) attemptUpdates.gbif_doi = refreshed.doi;
    if (Number.isSafeInteger(refreshed.reportedCount)) {
      attemptUpdates.gbif_reported_count = refreshed.reportedCount;
      this.store.updateJob(job.id, { gbif_reported_count: refreshed.reportedCount });
    }
    this.store.updateAttempt(attempt.id, attemptUpdates);
    attempt = this.store.getAttempt(attempt.id);

    if (refreshed.status && refreshed.status !== 'SUCCEEDED') {
      this.store.updateJob(job.id, { status: 'WAITING_FOR_GBIF', next_action_at: isoAfter(config.pollIntervalMs) });
      this.store.addEvent(job.id, 'GBIF_STATUS_REGRESSED', `GBIF status changed from SUCCEEDED to ${refreshed.status}`, rawStatus, 'warn');
      return;
    }

    fs.mkdirSync(config.artifactDir, { recursive: true });
    const { finalPath, partialPath } = this.artifactPaths(attempt);
    fs.rmSync(partialPath, { force: true });
    if (!fs.existsSync(finalPath)) {
      const candidates = artifactUrlCandidates(attempt.gbif_download_key, attempt.gbif_download_url);
      const result = await downloadToFile(candidates, partialPath);
      const partialSize = fs.statSync(partialPath).size;
      if (Number.isSafeInteger(result.contentLength) && result.contentLength !== partialSize) {
        throw new Error(`Downloaded size ${partialSize} does not match Content-Length ${result.contentLength}`);
      }
      fs.renameSync(partialPath, finalPath);
      this.store.updateAttempt(attempt.id, { gbif_download_url: result.finalUrl });
      this.store.addEvent(job.id, 'ARTIFACT_DOWNLOADED', `Downloaded ${path.basename(finalPath)}`, {
        ...result,
        candidates
      });
    } else {
      this.store.addEvent(job.id, 'ARTIFACT_ALREADY_PRESENT', `Using existing local file ${path.basename(finalPath)}`, null, 'warn');
    }
    this.store.updateJob(job.id, { status: 'VALIDATING', next_action_at: nowIso(), error_message: null });
  }

  async validate(job) {
    const attempt = this.store.getAttempt(job.current_attempt_id);
    const { finalPath } = this.artifactPaths(attempt);
    let validation;
    try {
      validation = await validateDwca(finalPath, {
        preflightExpectedCount: job.expected_count,
        gbifReportedCount: attempt.gbif_reported_count ?? job.gbif_reported_count,
        maxEntryBytes: config.maxZipEntryBytes,
        maxTotalBytes: config.maxZipTotalBytes,
        maxCompressionRatio: config.maxZipCompressionRatio
      });
    } catch (error) {
      validation = {
        valid: false,
        errors: [`Validator exception: ${error.message}`],
        warnings: []
      };
    }
    const stat = fs.statSync(finalPath);
    const sha256 = await sha256File(finalPath);
    const now = nowIso();
    const artifactId = crypto.randomUUID();
    const artifact = this.store.createArtifact({
      id: artifactId,
      gbifDownloadKey: attempt.gbif_download_key,
      gbifDoi: attempt.gbif_doi ?? null,
      originalFilename: path.basename(finalPath),
      filePath: finalPath,
      sizeBytes: stat.size,
      sha256,
      validationStatus: validation.valid ? 'VALID' : 'INVALID',
      validationJson: JSON.stringify(validation),
      isPinned: 0,
      createdAt: now,
      validatedAt: now,
      expiresAt: new Date(Date.now() + config.retentionMs).toISOString()
    });
    this.store.updateAttempt(attempt.id, {
      artifact_id: artifact.id,
      finished_at: now,
      failure_reason: validation.valid ? null : validation.errors.join('; ')
    });

    if (validation.valid) {
      this.store.updateJob(job.id, {
        status: 'READY',
        is_active: 0,
        artifact_id: artifact.id,
        completed_at: now,
        next_action_at: null,
        error_message: null
      });
      this.store.addEvent(job.id, 'VALIDATION_SUCCEEDED', 'Darwin Core Archive passed all validation checks', validation);
      return;
    }

    if (!config.keepInvalidArtifacts) {
      fs.rmSync(finalPath, { force: true });
      this.store.markArtifactDeleted(artifact.id);
    }
    this.store.updateJob(job.id, {
      status: 'RETRY_WAIT',
      last_invalid_gbif_key: attempt.gbif_download_key,
      next_action_at: isoAfter(config.retryIntervalMs),
      error_message: validation.errors.join('; ')
    });
    this.store.addEvent(job.id, 'VALIDATION_FAILED', 'Darwin Core Archive is invalid; retry scheduled', validation, 'error');
  }

  retry(job) {
    this.store.updateJob(job.id, {
      status: 'SUBMITTING_TO_GBIF',
      next_action_at: nowIso(),
      error_message: null
    });
    this.store.addEvent(job.id, 'RETRY_STARTED', 'Starting a new GBIF download attempt');
  }

  async processReplay(job) {
    const fixture = this.store.getArtifact(job.fixture_artifact_id);
    if (!fixture || fixture.deleted_at || fixture.validation_status !== 'VALID' || !fs.existsSync(fixture.file_path)) {
      this.store.updateJob(job.id, {
        status: 'FAILED_PERMANENTLY',
        is_active: 0,
        completed_at: nowIso(),
        error_message: 'Replay fixture is missing or invalid'
      });
      this.store.addEvent(job.id, 'REPLAY_FIXTURE_INVALID', 'Replay fixture is missing or invalid', null, 'error');
      return;
    }

    const validation = jsonParse(fixture.validation_json, {});
    const recordCount = validation.occurrence?.completeRows ?? validation.occurrence?.rows ?? null;

    if (job.status === 'QUEUED') {
      const now = nowIso();
      const readyAt = new Date(Date.now() + config.replayDurationMs).toISOString();
      this.store.updateJob(job.id, {
        status: config.replayDurationMs === 0 ? 'VALIDATING' : 'WAITING_FOR_GBIF',
        expected_count: recordCount,
        gbif_reported_count: recordCount,
        replay_started_at: now,
        replay_ready_at: readyAt,
        next_action_at: nowIso()
      });
      this.store.addEvent(job.id, 'REPLAY_STARTED', 'Synthetic GBIF workflow started from a pinned fixture', {
        fixtureArtifactId: fixture.id,
        readyAfterMs: config.replayDurationMs,
        recordCount
      });
      return;
    }

    const startedAt = new Date(job.replay_started_at).getTime();
    const readyAt = new Date(job.replay_ready_at).getTime();
    const duration = Math.max(readyAt - startedAt, 1);
    const progress = Math.min(1, Math.max(0, (Date.now() - startedAt) / duration));

    if (Date.now() < readyAt) {
      const nextStatus = progress < 0.45 ? 'WAITING_FOR_GBIF' : progress < 0.75 ? 'DOWNLOADING' : 'VALIDATING';
      if (nextStatus !== job.status) {
        this.store.updateJob(job.id, { status: nextStatus, next_action_at: isoAfter(1000) });
        this.store.addEvent(job.id, 'REPLAY_PHASE', `Synthetic workflow entered ${nextStatus}`, { progress });
      } else {
        this.store.updateJob(job.id, { next_action_at: isoAfter(1000) });
      }
      return;
    }

    const fixtureSize = fs.statSync(fixture.file_path).size;
    if (fixtureSize !== fixture.size_bytes) {
      this.store.updateJob(job.id, {
        status: 'FAILED_PERMANENTLY',
        is_active: 0,
        completed_at: nowIso(),
        error_message: 'Replay fixture size mismatch'
      });
      this.store.addEvent(job.id, 'REPLAY_SIZE_FAILED', 'Replay fixture size mismatch', { expected: fixture.size_bytes, actual: fixtureSize }, 'error');
      return;
    }
    if (config.replayVerifySha256) {
      const currentHash = await sha256File(fixture.file_path);
      if (currentHash !== fixture.sha256) {
        this.store.updateJob(job.id, {
          status: 'FAILED_PERMANENTLY',
          is_active: 0,
          completed_at: nowIso(),
          error_message: 'Replay fixture checksum mismatch'
        });
        this.store.addEvent(job.id, 'REPLAY_CHECKSUM_FAILED', 'Replay fixture checksum mismatch', null, 'error');
        return;
      }
    }

    this.store.updateJob(job.id, {
      status: 'READY',
      is_active: 0,
      artifact_id: fixture.id,
      expected_count: recordCount,
      gbif_reported_count: recordCount,
      completed_at: nowIso(),
      next_action_at: null,
      error_message: null
    });
    this.store.addEvent(job.id, 'REPLAY_READY', 'Synthetic download completed using pinned fixture', {
      fixtureArtifactId: fixture.id,
      sha256: fixture.sha256
    });
  }

  async cleanup() {
    for (const artifact of this.store.listExpiredArtifacts()) {
      try {
        if (this.store.countOtherActiveArtifactsForPath(artifact.id, artifact.file_path) === 0) {
          fs.rmSync(artifact.file_path, { force: true });
        }
        this.store.markArtifactDeleted(artifact.id);
      } catch (error) {
        this.logger.error({ err: error, artifactId: artifact.id }, 'Artifact cleanup failed');
      }
    }
  }
}
