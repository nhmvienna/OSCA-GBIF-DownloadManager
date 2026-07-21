import { config } from './config.js';
import { validateDwca } from './zip.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: npm run validate -- /path/to/archive.zip [expectedCount]');
  process.exit(2);
}
const expectedCount = process.argv[3] ? Number.parseInt(process.argv[3], 10) : null;
const result = await validateDwca(filePath, {
  preflightExpectedCount: expectedCount,
  gbifReportedCount: expectedCount,
  maxEntryBytes: config.maxZipEntryBytes,
  maxTotalBytes: config.maxZipTotalBytes,
  maxCompressionRatio: config.maxZipCompressionRatio
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.valid ? 0 : 1);
