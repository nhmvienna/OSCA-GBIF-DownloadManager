import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeGbifSearchUrl } from '../src/query.js';

test('canonicalizes parameter order', () => {
  const a = canonicalizeGbifSearchUrl('https://www.gbif.org/occurrence/search?year=1995%2C2000&datasetKey=x&taxonKey=y');
  const b = canonicalizeGbifSearchUrl('https://gbif.org/occurrence/search?taxonKey=y&datasetKey=x&year=1995,2000');
  assert.equal(a.queryHash, b.queryHash);
  assert.equal(a.canonicalUrl, b.canonicalUrl);
});

test('rejects unrelated URLs', () => {
  assert.throws(() => canonicalizeGbifSearchUrl('https://example.com/occurrence/search?x=1'));
});
