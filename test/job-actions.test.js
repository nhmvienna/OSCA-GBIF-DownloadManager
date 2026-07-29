import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gbif-manager-actions-'));
  const store = new Store(path.join(directory, 'manager.sqlite'));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function createJob(store, id = 'job-1') {
  return store.createJob({
    id,
    originalUrl: 'https://www.gbif.org/occurrence/search?datasetKey=test',
    canonicalUrl: 'https://www.gbif.org/occurrence/search?datasetKey=test',
    queryString: 'datasetKey=test',
    queryHash: 'query-hash',
    requestedMode: 'live',
    sourceMode: 'LIVE',
    status: 'QUEUED',
    fixtureArtifactId: null,
    createdAt: new Date().toISOString(),
    nextActionAt: new Date().toISOString(),
  });
}

test('an administrator can retry RETRY_WAIT immediately without losing history', (t) => {
  const store = fixture(t);
  createJob(store);
  store.updateJob('job-1', { status: 'RETRY_WAIT', error_message: 'old failure', next_action_at: '2099-01-01T00:00:00.000Z' });

  const retried = store.retryJobNow('job-1');

  assert.equal(retried.status, 'RETRY_WAIT');
  assert.equal(retried.is_active, 1);
  assert.equal(retried.error_message, null);
  assert.ok(new Date(retried.next_action_at).getTime() <= Date.now() + 1000);
  assert.ok(store.getJobDetails('job-1').events.some((event) => event.event_type === 'MANUAL_RETRY_REQUESTED'));
});

test('job list exposes the latest GBIF download DOI and key', (t) => {
  const store = fixture(t);
  createJob(store);
  store.createAttempt({
    id: 'attempt-1', jobId: 'job-1', attemptNumber: 1,
    gbifDownloadKey: '0000001-260101120000001', gbifStatus: 'SUCCEEDED',
    submittedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
  });
  store.updateAttempt('attempt-1', {
    gbif_doi: '10.15468/dl.example',
    gbif_reported_count: 123,
  });

  const listed = store.listJobs({ limit: 10 })[0];
  assert.equal(listed.gbif_download_key, '0000001-260101120000001');
  assert.equal(listed.gbif_doi, '10.15468/dl.example');
  assert.equal(listed.gbif_reported_count, 123);
});

test('deleting a waiting job removes its coordination history', (t) => {
  const store = fixture(t);
  createJob(store);
  store.updateJob('job-1', { status: 'RETRY_WAIT' });

  assert.equal(store.deleteJob('job-1').id, 'job-1');
  assert.equal(store.getJob('job-1'), undefined);
});

test('does not delete a job while GBIF work is in progress', (t) => {
  const store = fixture(t);
  createJob(store);
  store.updateJob('job-1', { status: 'WAITING_FOR_GBIF' });
  assert.throws(() => store.deleteJob('job-1'), (error) => error.code === 'JOB_STILL_RUNNING');
});
