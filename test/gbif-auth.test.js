import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GBIF_USERNAME = 'test-user';
process.env.GBIF_PASSWORD = 'wrong-password';
process.env.GBIF_EMAIL = 'test@example.org';

const { GbifAuthenticationError, submitDownload } = await import('../src/gbif.js');
const { Worker } = await import('../src/worker.js');

test('reports rejected GBIF credentials as a specific authentication error', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response('Unauthorized', {
    status: 401,
    statusText: 'Unauthorized',
  });

  await assert.rejects(
    submitDownload({ type: 'equals', key: 'DATASET_KEY', value: 'test' }),
    (error) => error instanceof GbifAuthenticationError
      && /GBIF_USERNAME and GBIF_PASSWORD/.test(error.message),
  );
});

test('stops a job permanently after GBIF rejects the configured credentials', () => {
  let job = { id: 'job-1', is_active: 1, status: 'SUBMITTING_TO_GBIF' };
  const events = [];
  const store = {
    getJob() { return job; },
    updateJob(_id, patch) { job = { ...job, ...patch }; return job; },
    addEvent(_id, type, message) { events.push({ type, message }); },
  };
  const worker = new Worker(store, { error() {} });

  worker.handleProcessingError(job.id, new GbifAuthenticationError(401));

  assert.equal(job.status, 'FAILED_PERMANENTLY');
  assert.equal(job.is_active, 0);
  assert.equal(job.next_action_at, null);
  assert.match(job.error_message, /username or password/);
  assert.ok(events.some((event) => event.type === 'GBIF_AUTHENTICATION_FAILED'));
});
