import { sha256Text } from './util.js';

const ALLOWED_HOSTS = new Set(['www.gbif.org', 'gbif.org']);
const ALLOWED_PATHS = new Set(['/occurrence/search']);

export function canonicalizeGbifSearchUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid URL');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only HTTP(S) URLs are supported');
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('URL must point to gbif.org');
  }
  if (!ALLOWED_PATHS.has(url.pathname.replace(/\/$/, ''))) {
    throw new Error('Only GBIF occurrence search URLs are supported');
  }

  const entries = [...url.searchParams.entries()]
    .filter(([key]) => !['view', 'advanced'].includes(key))
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey.localeCompare(bKey) || aValue.localeCompare(bValue)
    );

  if (entries.length === 0) {
    throw new Error('The GBIF search URL contains no filters');
  }

  const params = new URLSearchParams();
  for (const [key, value] of entries) params.append(key, value);

  const canonicalUrl = `https://www.gbif.org/occurrence/search?${params.toString()}`;
  const queryString = params.toString();

  return {
    originalUrl: input,
    canonicalUrl,
    queryString,
    queryHash: sha256Text(queryString),
    parameters: entries
  };
}
