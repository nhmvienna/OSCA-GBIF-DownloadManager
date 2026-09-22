import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';

test('ready jobs and fixture replays expose only the DOI of their validated artifact', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gbif-manager-doi-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let store = new Store(path.join(directory, 'manager.sqlite'));
  t.after(() => store.db.close());
  const createdAt = new Date().toISOString();
  const createJob = (id, sourceMode = 'LIVE') => store.createJob({
    id, originalUrl: 'https://www.gbif.org/occurrence/search?datasetKey=test',
    canonicalUrl: 'https://www.gbif.org/occurrence/search?datasetKey=test',
    queryString: 'datasetKey=test', queryHash: id, requestedMode: 'auto', sourceMode,
    status: 'QUEUED', fixtureArtifactId: null, createdAt, nextActionAt: createdAt,
  });
  createJob('live');
  const createAttempt = (id, attemptNumber, key, doi) => {
    store.createAttempt({ id, jobId: 'live', attemptNumber, gbifDownloadKey: key,
      gbifStatus: 'SUCCEEDED', submittedAt: createdAt, createdAt });
    store.updateAttempt(id, { gbif_doi: doi });
  };
  createAttempt('bad', 1, 'bad-key', '10.15468/bad');
  store.updateAttempt('bad', { failure_reason: 'Invalid archive' });
  createAttempt('good', 2, 'good-key', '10.15468/good');
  store.createArtifact({ id: 'artifact', gbifDownloadKey: 'good-key', gbifDoi: '10.15468/good',
    originalFilename: 'good.zip', filePath: '/tmp/good.zip', sizeBytes: 10,
    sha256: 'test', validationStatus: 'VALID', validationJson: '{}', isPinned: 0,
    createdAt, validatedAt: createdAt, expiresAt: createdAt });
  store.updateAttempt('good', { artifact_id: 'artifact' });
  store.updateJob('live', { artifact_id: 'artifact', status: 'READY', is_active: 0 });
  createJob('replay', 'FIXTURE');
  store.updateJob('replay', { artifact_id: 'artifact', status: 'READY', is_active: 0 });

  for (const id of ['live', 'replay']) {
    const job = store.getJobDetails(id);
    assert.equal(job.artifact_gbif_doi, '10.15468/good');
    assert.equal(job.artifact_gbif_download_key, 'good-key');
  }
  assert.equal(store.getJob('missing'), undefined);

  // Upgrade an existing database which has not stored the DOI on artifacts
  // before: copy it once from the successful originating attempt.
  store.db.exec('ALTER TABLE artifacts DROP COLUMN gbif_doi');
  store.close();
  store = new Store(path.join(directory, 'manager.sqlite'));
  assert.equal(store.getJob('replay').artifact_gbif_doi, '10.15468/good');
  store.db.prepare('DELETE FROM attempts WHERE job_id = ?').run('live');
  assert.equal(store.getJob('replay').artifact_gbif_doi, '10.15468/good');
});
