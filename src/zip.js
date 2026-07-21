import fs from 'node:fs';
import readline from 'node:readline';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';
import CRC32 from 'crc-32';
import { XMLParser } from 'fast-xml-parser';
import { asArray } from './util.js';

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true, autoClose: false }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

async function listEntries(filePath, limits) {
  const zip = await openZip(filePath);
  const entries = new Map();
  let totalUncompressed = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        const normalizedName = name.replaceAll('\\', '/');
        const pathParts = normalizedName.split('/');
        if (normalizedName.startsWith('/') || /^[A-Za-z]:\//.test(normalizedName) || pathParts.includes('..')) {
          reject(new Error(`Unsafe ZIP entry path: ${name}`));
          return;
        }
        if (entries.has(name)) {
          reject(new Error(`Duplicate ZIP entry: ${name}`));
          return;
        }
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0o170000) === 0o120000) {
          reject(new Error(`Symbolic links are not allowed in ZIP archives: ${name}`));
          return;
        }
        if (entry.uncompressedSize > limits.maxEntryBytes) {
          reject(new Error(`ZIP entry exceeds configured size limit: ${name}`));
          return;
        }
        totalUncompressed += entry.uncompressedSize;
        if (totalUncompressed > limits.maxTotalBytes) {
          reject(new Error('ZIP exceeds configured total uncompressed size limit'));
          return;
        }
        if (entry.compressedSize === 0 && entry.uncompressedSize > 0) {
          reject(new Error(`Invalid zero compressed size for non-empty ZIP entry: ${name}`));
          return;
        }
        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio) {
          reject(new Error(`Suspicious compression ratio for ZIP entry: ${name}`));
          return;
        }
        entries.set(name, entry);
        zip.readEntry();
      });
      zip.on('end', resolve);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return { entries, totalUncompressed };
}

async function withEntryStream(filePath, entryName, fn) {
  const zip = await openZip(filePath);
  try {
    let target = null;
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        if (entry.fileName === entryName) {
          target = entry;
          resolve();
        } else {
          zip.readEntry();
        }
      });
      zip.on('end', () => resolve());
      zip.readEntry();
    });
    if (!target) throw new Error(`ZIP entry not found: ${entryName}`);
    const stream = await new Promise((resolve, reject) => {
      zip.openReadStream(target, (error, value) => error ? reject(error) : resolve(value));
    });
    return await fn(stream, target);
  } finally {
    zip.close();
  }
}

async function readSmallEntry(filePath, entryName, maxBytes = 64 * 1024 * 1024) {
  return withEntryStream(filePath, entryName, async (stream, entry) => {
    if (entry.uncompressedSize > maxBytes) throw new Error(`${entryName} is unexpectedly large`);
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) throw new Error(`${entryName} exceeds read limit`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  });
}

async function verifyEntryCrc(filePath, entryName) {
  return withEntryStream(filePath, entryName, async (stream, entry) => {
    let crc = 0;
    let bytes = 0;
    for await (const chunk of stream) {
      crc = CRC32.buf(chunk, crc);
      bytes += chunk.length;
    }
    const actual = crc >>> 0;
    const expected = entry.crc32 >>> 0;
    if (bytes !== entry.uncompressedSize) {
      throw new Error(`${entryName} size mismatch: ${bytes} != ${entry.uncompressedSize}`);
    }
    if (actual !== expected) {
      throw new Error(`${entryName} CRC mismatch: ${actual.toString(16)} != ${expected.toString(16)}`);
    }
    return { bytes, crc32: actual };
  });
}

function parseArchiveDescriptor(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseAttributeValue: true,
    trimValues: true
  });
  const parsed = parser.parse(xml);
  const archive = parsed.archive;
  if (!archive?.core) throw new Error('meta.xml does not define a core');
  const core = archive.core;
  const coreLocation = asArray(core.files?.location)[0];
  if (!coreLocation) throw new Error('meta.xml does not define a core file location');

  const extensions = asArray(archive.extension).map((extension) => ({
    rowType: String(extension['@_rowType'] || ''),
    location: asArray(extension.files?.location)[0] || null,
    coreIdIndex: extension.coreid?.['@_index'] ?? null
  }));

  const multimedia = extensions.find((extension) =>
    /multimedia|audiovisual|simplemultimedia/i.test(extension.rowType) ||
    /multimedia\.txt$/i.test(extension.location || '')
  );

  return {
    coreLocation,
    coreIdIndex: core.id?.['@_index'] ?? 0,
    coreRowType: core['@_rowType'] || null,
    multimediaLocation: multimedia?.location || null,
    extensions
  };
}

function parseMetadataExpectedCount(xml) {
  const matches = [...xml.matchAll(/\b([\d,.]+)\s+records?\s+from\b/gi)];
  if (!matches.length) return null;
  const counts = matches.map((match) => Number.parseInt(match[1].replace(/[,.]/g, ''), 10));
  return counts.every(Number.isSafeInteger) ? counts.reduce((sum, value) => sum + value, 0) : null;
}

async function inspectTsvEntry(filePath, entryName, options = {}) {
  const {
    collectIds = false,
    allowedIds = null,
    trackMediaType = false,
    idColumnName = 'gbifID'
  } = options;

  return withEntryStream(filePath, entryName, async (stream) => {
    let bytes = 0;
    let lastByte = null;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let utf8Valid = true;
    const tracker = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (chunk.length) lastByte = chunk[chunk.length - 1];
        if (utf8Valid) {
          try { decoder.decode(chunk, { stream: true }); } catch { utf8Valid = false; }
        }
        callback(null, chunk);
      },
      flush(callback) {
        if (utf8Valid) {
          try { decoder.decode(); } catch { utf8Valid = false; }
        }
        callback();
      }
    });
    stream.on('error', (error) => tracker.destroy(error));
    stream.pipe(tracker);

    const rl = readline.createInterface({ input: tracker, crlfDelay: Infinity });
    let header = null;
    let expectedColumns = null;
    let idIndex = -1;
    let mediaTypeIndex = -1;
    let rows = 0;
    let malformedRows = 0;
    let emptyIds = 0;
    let duplicateIds = 0;
    let orphanIds = 0;
    const ids = collectIds ? new Set() : null;
    const mediaTypeIds = trackMediaType ? new Set() : null;
    let identifierIndex = -1;
    let referencesIndex = -1;
    let invalidMediaUrls = 0;
    const invalidMediaUrlSamples = [];
    const samples = [];

    for await (const line of rl) {
      if (header == null) {
        header = line.split('\t');
        expectedColumns = header.length;
        idIndex = header.indexOf(idColumnName);
        mediaTypeIndex = header.indexOf('mediaType');
        identifierIndex = header.indexOf('identifier');
        referencesIndex = header.indexOf('references');
        if (idIndex < 0) throw new Error(`${entryName} does not contain ${idColumnName}`);
        continue;
      }
      rows += 1;
      const columns = line.split('\t');
      if (columns.length !== expectedColumns) {
        malformedRows += 1;
        if (samples.length < 10) samples.push({ row: rows, columns: columns.length, expectedColumns });
        continue;
      }
      const id = columns[idIndex];
      if (!id) {
        emptyIds += 1;
      } else {
        if (ids) {
          if (ids.has(id)) duplicateIds += 1;
          else ids.add(id);
        }
        if (allowedIds && !allowedIds.has(id)) orphanIds += 1;
        if (mediaTypeIds && mediaTypeIndex >= 0 && columns[mediaTypeIndex]?.trim()) mediaTypeIds.add(id);
        if (options.validateMediaUrls) {
          const values = [identifierIndex, referencesIndex]
            .filter((index) => index >= 0)
            .map((index) => columns[index]?.trim())
            .filter(Boolean);
          const validUrl = values.some((value) => {
            try {
              const parsed = new URL(value);
              return parsed.protocol === 'http:' || parsed.protocol === 'https:';
            } catch { return false; }
          });
          if (!validUrl) {
            invalidMediaUrls += 1;
            if (invalidMediaUrlSamples.length < 10) invalidMediaUrlSamples.push({ row: rows, id, values });
          }
        }
      }
    }

    if (header == null) throw new Error(`${entryName} is empty`);

    return {
      entryName,
      bytes,
      rows,
      completeRows: rows - malformedRows,
      headerColumns: expectedColumns,
      malformedRows,
      emptyIds,
      duplicateIds,
      orphanIds,
      invalidMediaUrls,
      invalidMediaUrlSamples,
      utf8Valid,
      endsWithNewline: lastByte === 0x0a,
      samples,
      ids,
      mediaTypeIds
    };
  });
}

export async function validateDwca(filePath, options) {
  const limits = {
    maxEntryBytes: options.maxEntryBytes,
    maxTotalBytes: options.maxTotalBytes,
    maxCompressionRatio: options.maxCompressionRatio
  };
  const errors = [];
  const warnings = [];
  const { entries, totalUncompressed } = await listEntries(filePath, limits);

  if (!entries.has('meta.xml')) errors.push('meta.xml is missing');
  if (!entries.has('metadata.xml')) warnings.push('metadata.xml is missing');
  if (errors.length) return { valid: false, errors, warnings, totalUncompressed, entries: [...entries.keys()] };

  for (const name of entries.keys()) {
    if (name.endsWith('/')) continue;
    try {
      await verifyEntryCrc(filePath, name);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length) return { valid: false, errors, warnings, totalUncompressed, entries: [...entries.keys()] };

  let descriptor;
  try {
    descriptor = parseArchiveDescriptor(await readSmallEntry(filePath, 'meta.xml'));
  } catch (error) {
    errors.push(error.message);
    return { valid: false, errors, warnings, totalUncompressed, entries: [...entries.keys()] };
  }

  if (!entries.has(descriptor.coreLocation)) {
    errors.push(`Core file is missing: ${descriptor.coreLocation}`);
    return { valid: false, errors, warnings, descriptor, totalUncompressed, entries: [...entries.keys()] };
  }

  let metadataExpectedCount = null;
  if (entries.has('metadata.xml')) {
    metadataExpectedCount = parseMetadataExpectedCount(await readSmallEntry(filePath, 'metadata.xml'));
  }

  let occurrence;
  try {
    occurrence = await inspectTsvEntry(filePath, descriptor.coreLocation, {
      collectIds: true,
      trackMediaType: true
    });
  } catch (error) {
    errors.push(error.message);
  }

  let verbatim = null;
  if (entries.has('verbatim.txt')) {
    try {
      verbatim = await inspectTsvEntry(filePath, 'verbatim.txt', { collectIds: false });
    } catch (error) {
      errors.push(error.message);
    }
  } else {
    warnings.push('verbatim.txt is missing');
  }

  let multimedia = null;
  const multimediaLocation = descriptor.multimediaLocation || (entries.has('multimedia.txt') ? 'multimedia.txt' : null);
  if (multimediaLocation && entries.has(multimediaLocation) && occurrence) {
    try {
      multimedia = await inspectTsvEntry(filePath, multimediaLocation, {
        collectIds: true,
        allowedIds: occurrence.ids,
        validateMediaUrls: true
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (occurrence) {
    if (!occurrence.utf8Valid) errors.push('Occurrence core is not valid UTF-8');
    if (occurrence.malformedRows) errors.push(`${occurrence.malformedRows} malformed occurrence row(s)`);
    if (occurrence.emptyIds) errors.push(`${occurrence.emptyIds} occurrence row(s) without gbifID`);
    if (occurrence.duplicateIds) errors.push(`${occurrence.duplicateIds} duplicate occurrence gbifID(s)`);
    if (!occurrence.endsWithNewline) warnings.push('occurrence core does not end with a newline');

    const exactCounts = [
      ['GBIF status', options.gbifReportedCount],
      ['metadata.xml', metadataExpectedCount]
    ].filter(([, value]) => Number.isSafeInteger(value));

    for (const [source, value] of exactCounts) {
      if (occurrence.completeRows !== value) errors.push(`Complete occurrence row count ${occurrence.completeRows} does not match ${source} count ${value}`);
    }

    if (Number.isSafeInteger(options.preflightExpectedCount) && occurrence.completeRows !== options.preflightExpectedCount) {
      warnings.push(`Preflight search count changed: ${options.preflightExpectedCount} -> ${occurrence.completeRows}`);
    }

    if (verbatim) {
      if (!verbatim.utf8Valid) errors.push('verbatim.txt is not valid UTF-8');
      if (verbatim.malformedRows) errors.push(`${verbatim.malformedRows} malformed verbatim row(s)`);
      if (verbatim.completeRows !== occurrence.completeRows) errors.push(`Complete verbatim row count ${verbatim.completeRows} does not match complete occurrence count ${occurrence.completeRows}`);
    }

    const mediaTypeCount = occurrence.mediaTypeIds?.size || 0;
    if (mediaTypeCount > 0 && !multimedia) {
      errors.push(`${mediaTypeCount} occurrence(s) declare mediaType but no multimedia extension is present`);
    }
    if (multimedia) {
      if (!multimedia.utf8Valid) errors.push('multimedia file is not valid UTF-8');
      if (multimedia.malformedRows) errors.push(`${multimedia.malformedRows} malformed multimedia row(s)`);
      if (multimedia.emptyIds) errors.push(`${multimedia.emptyIds} multimedia row(s) without gbifID`);
      if (multimedia.invalidMediaUrls) errors.push(`${multimedia.invalidMediaUrls} multimedia row(s) have no valid HTTP(S) identifier or references URL`);
      if (multimedia.orphanIds) errors.push(`${multimedia.orphanIds} multimedia row(s) reference missing occurrence IDs`);
      if (!multimedia.endsWithNewline) warnings.push('multimedia file does not end with a newline');
      const mediaIds = multimedia.ids || new Set();
      let missingMediaIds = 0;
      for (const id of occurrence.mediaTypeIds || []) {
        if (!mediaIds.has(id)) missingMediaIds += 1;
      }
      if (missingMediaIds) errors.push(`${missingMediaIds} occurrence(s) declare mediaType but have no multimedia row`);
      multimedia.missingMediaIds = missingMediaIds;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    totalUncompressed,
    entryCount: entries.size,
    entries: [...entries.keys()],
    descriptor,
    metadataExpectedCount,
    occurrence: occurrence ? { ...occurrence, ids: undefined, mediaTypeIds: undefined, uniqueIds: occurrence.ids?.size || 0, mediaTypeOccurrences: occurrence.mediaTypeIds?.size || 0 } : null,
    verbatim,
    multimedia: multimedia ? { ...multimedia, ids: undefined, uniqueOccurrenceIds: multimedia.ids?.size || 0 } : null
  };
}
