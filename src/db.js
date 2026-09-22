import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nowIso, jsonParse } from './util.js';

const ACTIVE_STATUSES = [
  'QUEUED',
  'RESOLVING_QUERY',
  'SUBMITTING_TO_GBIF',
  'WAITING_FOR_GBIF',
  'DOWNLOADING',
  'VALIDATING',
  'REPLAYING',
  'RETRY_WAIT'
];

export class Store {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        original_url TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        query_string TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        requested_mode TEXT NOT NULL,
        source_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        expected_count INTEGER,
        gbif_reported_count INTEGER,
        predicate_json TEXT,
        current_attempt_id TEXT,
        artifact_id TEXT,
        fixture_artifact_id TEXT,
        last_invalid_gbif_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        next_action_at TEXT,
        replay_started_at TEXT,
        replay_ready_at TEXT,
        error_message TEXT,
        locked_by TEXT,
        locked_until TEXT,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(id),
        FOREIGN KEY (fixture_artifact_id) REFERENCES artifacts(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_query
        ON jobs(query_hash) WHERE is_active = 1;
      CREATE INDEX IF NOT EXISTS idx_jobs_due
        ON jobs(is_active, next_action_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_created
        ON jobs(created_at DESC);

      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        gbif_download_key TEXT,
        gbif_status TEXT,
        gbif_download_url TEXT,
        gbif_doi TEXT,
        gbif_reported_count INTEGER,
        submitted_at TEXT,
        last_polled_at TEXT,
        finished_at TEXT,
        next_retry_at TEXT,
        failure_reason TEXT,
        artifact_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(id),
        UNIQUE(job_id, attempt_number)
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_job ON attempts(job_id, attempt_number DESC);
      CREATE INDEX IF NOT EXISTS idx_attempts_gbif_key ON attempts(gbif_download_key);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        gbif_download_key TEXT,
        gbif_doi TEXT,
        original_filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        validation_status TEXT NOT NULL,
        validation_json TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        pin_label TEXT,
        pin_description TEXT,
        created_at TEXT NOT NULL,
        validated_at TEXT,
        expires_at TEXT,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_expiry
        ON artifacts(is_pinned, deleted_at, expires_at);

      CREATE TABLE IF NOT EXISTS query_fixtures (
        query_hash TEXT PRIMARY KEY,
        canonical_url TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
      );

      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        level TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, id DESC);
    `);
    // Existing installations already have artifacts and attempts. Preserve
    // provenance on the artifact itself so a pinned fixture retains its DOI
    // even when the original job/attempt is eventually removed.
    if (!this.db.prepare('PRAGMA table_info(artifacts)').all().some((column) => column.name === 'gbif_doi')) {
      this.db.exec('ALTER TABLE artifacts ADD COLUMN gbif_doi TEXT');
    }
    this.db.exec(`
      UPDATE artifacts SET gbif_doi = (
        SELECT at.gbif_doi FROM attempts at
        WHERE at.artifact_id = artifacts.id AND at.failure_reason IS NULL AND at.gbif_doi IS NOT NULL
        ORDER BY at.attempt_number DESC LIMIT 1
      ) WHERE gbif_doi IS NULL
        AND EXISTS (SELECT 1 FROM attempts at WHERE at.artifact_id = artifacts.id AND at.failure_reason IS NULL AND at.gbif_doi IS NOT NULL)
    `);
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get activeStatuses() {
    return ACTIVE_STATUSES;
  }

  addEvent(jobId, eventType, message, details = null, level = 'info') {
    this.db.prepare(`
      INSERT INTO job_events(job_id, created_at, level, event_type, message, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jobId, nowIso(), level, eventType, message, details == null ? null : JSON.stringify(details));
  }

  findActiveJob(queryHash) {
    return this.db.prepare('SELECT * FROM jobs WHERE query_hash = ? AND is_active = 1').get(queryHash);
  }

  createJob(job) {
    const tx = () => this.transaction(() => {
      this.db.prepare(`
        INSERT INTO jobs(
          id, original_url, canonical_url, query_string, query_hash,
          requested_mode, source_mode, status, is_active,
          fixture_artifact_id, created_at, updated_at, started_at, next_action_at
        ) VALUES (
          @id, @originalUrl, @canonicalUrl, @queryString, @queryHash,
          @requestedMode, @sourceMode, @status, 1,
          @fixtureArtifactId, @createdAt, @createdAt, @createdAt, @nextActionAt
        )
      `).run(job);
      this.addEvent(job.id, 'JOB_CREATED', `Job created in ${job.sourceMode} mode`, {
        requestedMode: job.requestedMode,
        queryHash: job.queryHash
      });
    });
    tx();
    return this.getJob(job.id);
  }

  retryJobNow(id) {
    return this.transaction(() => {
      const job = this.getJob(id);
      if (!job) return null;
      if (job.status !== 'RETRY_WAIT' && job.status !== 'FAILED_PERMANENTLY') {
        const error = new Error('Only waiting or permanently failed jobs can be retried manually');
        error.code = 'JOB_NOT_RETRYABLE';
        throw error;
      }
      const otherActive = this.findActiveJob(job.query_hash);
      if (otherActive && otherActive.id !== id) {
        const error = new Error('Another active job already exists for this query');
        error.code = 'ACTIVE_JOB_EXISTS';
        throw error;
      }
      this.updateJob(id, {
        status: 'RETRY_WAIT',
        is_active: 1,
        completed_at: null,
        next_action_at: nowIso(),
        error_message: null,
        locked_by: null,
        locked_until: null
      });
      this.addEvent(id, 'MANUAL_RETRY_REQUESTED', 'An administrator requested an immediate retry');
      return this.getJob(id);
    });
  }

  deleteJob(id) {
    return this.transaction(() => {
      const job = this.getJob(id);
      if (!job) return null;
      // A network/validation operation already in progress cannot be safely
      // interrupted by deleting its durable coordination row. RETRY_WAIT has
      // no running work and terminal jobs are inactive, so both are safe.
      if (job.is_active && job.status !== 'RETRY_WAIT') {
        const error = new Error('A running job can only be deleted while it is waiting for a retry');
        error.code = 'JOB_STILL_RUNNING';
        throw error;
      }
      this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
      return job;
    });
  }

  updateJob(id, patch) {
    const allowed = new Set([
      'status', 'is_active', 'expected_count', 'gbif_reported_count', 'predicate_json',
      'current_attempt_id', 'artifact_id', 'fixture_artifact_id', 'last_invalid_gbif_key',
      'updated_at', 'completed_at', 'next_action_at', 'replay_started_at', 'replay_ready_at',
      'error_message', 'locked_by', 'locked_until', 'source_mode'
    ]);
    const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
    if (!entries.length) return this.getJob(id);
    if (!entries.some(([key]) => key === 'updated_at')) entries.push(['updated_at', nowIso()]);
    const sql = `UPDATE jobs SET ${entries.map(([key]) => `${key} = @${key}`).join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(Object.fromEntries([...entries, ['id', id]]));
    return this.getJob(id);
  }

  getJob(id) {
    return this.db.prepare(`
      SELECT j.*, a.sha256 AS artifact_sha256, a.size_bytes AS artifact_size_bytes,
             a.gbif_download_key AS artifact_gbif_download_key,
             a.gbif_doi AS artifact_gbif_doi,
             a.validation_status AS artifact_validation_status, a.validation_json,
             a.is_pinned AS artifact_is_pinned, a.pin_label, a.expires_at AS artifact_expires_at,
             a.deleted_at AS artifact_deleted_at,
             qf.artifact_id AS mapped_fixture_artifact_id
      FROM jobs j
      LEFT JOIN artifacts a ON a.id = j.artifact_id
      LEFT JOIN query_fixtures qf ON qf.query_hash = j.query_hash AND qf.enabled = 1
      WHERE j.id = ?
    `).get(id);
  }

  getJobDetails(id) {
    const job = this.getJob(id);
    if (!job) return null;
    const attempts = this.db.prepare('SELECT * FROM attempts WHERE job_id = ? ORDER BY attempt_number DESC').all(id);
    const events = this.db.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT 200').all(id);
    return {
      ...job,
      predicate: jsonParse(job.predicate_json),
      validation: jsonParse(job.validation_json),
      attempts,
      events: events.map((event) => ({ ...event, details: jsonParse(event.details_json) }))
    };
  }

  listJobs({ limit = 200, offset = 0 } = {}) {
    return this.db.prepare(`
      SELECT j.*, a.sha256 AS artifact_sha256, a.size_bytes AS artifact_size_bytes,
             a.validation_status AS artifact_validation_status,
             latest.gbif_download_key, latest.gbif_doi, latest.gbif_reported_count,
             a.is_pinned AS artifact_is_pinned, a.pin_label,
             a.expires_at AS artifact_expires_at, a.deleted_at AS artifact_deleted_at,
             CASE WHEN qf.query_hash IS NULL THEN 0 ELSE 1 END AS has_fixture_mapping
      FROM jobs j
      LEFT JOIN artifacts a ON a.id = j.artifact_id
      LEFT JOIN attempts latest ON latest.id = (
        SELECT attempt.id FROM attempts attempt
        WHERE attempt.job_id = j.id
        ORDER BY attempt.attempt_number DESC LIMIT 1
      )
      LEFT JOIN query_fixtures qf ON qf.query_hash = j.query_hash AND qf.enabled = 1
      ORDER BY j.created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  listArtifacts({ limit = 200 } = {}) {
    return this.db.prepare(`
      SELECT a.*,
             (SELECT COUNT(*) FROM jobs j WHERE j.artifact_id = a.id) AS job_count,
             (SELECT COUNT(*) FROM query_fixtures q WHERE q.artifact_id = a.id AND q.enabled = 1) AS fixture_count
      FROM artifacts a
      WHERE a.deleted_at IS NULL
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(limit);
  }

  getArtifact(id) {
    return this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
  }

  getFixture(queryHash) {
    return this.db.prepare(`
      SELECT qf.*, a.file_path, a.sha256, a.size_bytes, a.validation_status, a.deleted_at, a.is_pinned
      FROM query_fixtures qf
      JOIN artifacts a ON a.id = qf.artifact_id
      WHERE qf.query_hash = ? AND qf.enabled = 1 AND a.deleted_at IS NULL
        AND a.validation_status = 'VALID' AND a.is_pinned = 1
    `).get(queryHash);
  }

  setFixture({ queryHash, canonicalUrl, artifactId }) {
    const now = nowIso();
    const tx = () => this.transaction(() => {
      this.db.prepare(`
        INSERT INTO query_fixtures(query_hash, canonical_url, artifact_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(query_hash) DO UPDATE SET
          canonical_url = excluded.canonical_url,
          artifact_id = excluded.artifact_id,
          enabled = 1,
          updated_at = excluded.updated_at
      `).run(queryHash, canonicalUrl, artifactId, now, now);
      this.db.prepare(`
        UPDATE artifacts SET is_pinned = 1, validated_at = COALESCE(validated_at, ?), expires_at = NULL
        WHERE id = ?
      `).run(now, artifactId);
    });
    tx();
    return this.getFixture(queryHash);
  }

  deleteFixture(queryHash) {
    return this.db.prepare('DELETE FROM query_fixtures WHERE query_hash = ?').run(queryHash).changes > 0;
  }

  pinArtifact(id, { pinned, label = null, description = null, expiresAt = null }) {
    const artifact = this.getArtifact(id);
    if (!artifact) return null;
    this.db.prepare(`
      UPDATE artifacts
      SET is_pinned = ?, pin_label = ?, pin_description = ?, expires_at = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, expires_at) END
      WHERE id = ?
    `).run(pinned ? 1 : 0, label, description, pinned ? 1 : 0, expiresAt, id);
    return this.getArtifact(id);
  }


  isArtifactMapped(id) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM query_fixtures WHERE artifact_id = ? AND enabled = 1').get(id).n > 0;
  }

  countOtherActiveArtifactsForPath(id, filePath) {
    return this.db.prepare(`
      SELECT COUNT(*) AS n FROM artifacts
      WHERE id <> ? AND file_path = ? AND deleted_at IS NULL
    `).get(id, filePath).n;
  }

  createAttempt(attempt) {
    this.db.prepare(`
      INSERT INTO attempts(
        id, job_id, attempt_number, gbif_download_key, gbif_status,
        submitted_at, created_at, updated_at
      ) VALUES (
        @id, @jobId, @attemptNumber, @gbifDownloadKey, @gbifStatus,
        @submittedAt, @createdAt, @createdAt
      )
    `).run(attempt);
    this.updateJob(attempt.jobId, { current_attempt_id: attempt.id });
    return this.getAttempt(attempt.id);
  }

  updateAttempt(id, patch) {
    const allowed = new Set([
      'gbif_download_key', 'gbif_status', 'gbif_download_url', 'gbif_doi',
      'gbif_reported_count', 'submitted_at', 'last_polled_at', 'finished_at',
      'next_retry_at', 'failure_reason', 'artifact_id', 'updated_at'
    ]);
    const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
    if (!entries.length) return this.getAttempt(id);
    if (!entries.some(([key]) => key === 'updated_at')) entries.push(['updated_at', nowIso()]);
    const sql = `UPDATE attempts SET ${entries.map(([key]) => `${key} = @${key}`).join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(Object.fromEntries([...entries, ['id', id]]));
    return this.getAttempt(id);
  }

  getAttempt(id) {
    return this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
  }

  getLatestAttempt(jobId) {
    return this.db.prepare('SELECT * FROM attempts WHERE job_id = ? ORDER BY attempt_number DESC LIMIT 1').get(jobId);
  }

  nextAttemptNumber(jobId) {
    return this.db.prepare('SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM attempts WHERE job_id = ?').get(jobId).n;
  }

  createArtifact(artifact) {
    this.db.prepare(`
      INSERT INTO artifacts(
        id, gbif_download_key, gbif_doi, original_filename, file_path, size_bytes, sha256,
        validation_status, validation_json, is_pinned, created_at, validated_at, expires_at
      ) VALUES (
        @id, @gbifDownloadKey, @gbifDoi, @originalFilename, @filePath, @sizeBytes, @sha256,
        @validationStatus, @validationJson, @isPinned, @createdAt, @validatedAt, @expiresAt
      )
    `).run(artifact);
    return this.getArtifact(artifact.id);
  }

  claimDueJob(workerId, leaseMs = 5 * 60 * 1000) {
    const now = nowIso();
    const lockedUntil = new Date(Date.now() + leaseMs).toISOString();
    const tx = () => this.transaction(() => {
      const candidate = this.db.prepare(`
        SELECT id FROM jobs
        WHERE is_active = 1
          AND (next_action_at IS NULL OR next_action_at <= ?)
          AND (locked_until IS NULL OR locked_until < ?)
        ORDER BY created_at ASC
        LIMIT 1
      `).get(now, now);
      if (!candidate) return null;
      const result = this.db.prepare(`
        UPDATE jobs SET locked_by = ?, locked_until = ?, updated_at = ?
        WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)
      `).run(workerId, lockedUntil, now, candidate.id, now);
      return result.changes ? this.getJob(candidate.id) : null;
    });
    return tx();
  }

  releaseJob(id, nextActionAt = null) {
    this.updateJob(id, { locked_by: null, locked_until: null, next_action_at: nextActionAt });
  }

  countActiveLiveJobs(excludingJobId = null) {
    if (excludingJobId) {
      return this.db.prepare(`
        SELECT COUNT(*) AS n FROM jobs
        WHERE is_active = 1 AND source_mode = 'LIVE' AND id <> ?
          AND status NOT IN ('QUEUED', 'RESOLVING_QUERY', 'RETRY_WAIT')
      `).get(excludingJobId).n;
    }
    return this.db.prepare(`
      SELECT COUNT(*) AS n FROM jobs
      WHERE is_active = 1 AND source_mode = 'LIVE'
        AND status NOT IN ('QUEUED', 'RESOLVING_QUERY', 'RETRY_WAIT')
    `).get().n;
  }

  markArtifactDeleted(id, deletedAt = nowIso()) {
    this.db.prepare('UPDATE artifacts SET deleted_at = ? WHERE id = ?').run(deletedAt, id);
    this.db.prepare(`
      UPDATE jobs SET status = CASE WHEN status = 'READY' THEN 'EXPIRED' ELSE status END,
                      updated_at = ?
      WHERE artifact_id = ?
    `).run(deletedAt, id);
  }

  listExpiredArtifacts(now = nowIso()) {
    return this.db.prepare(`
      SELECT * FROM artifacts
      WHERE deleted_at IS NULL AND is_pinned = 0 AND expires_at IS NOT NULL AND expires_at <= ?
    `).all(now);
  }
}
