# GBIF Download Manager

## Version 0.1.2

GBIF can briefly report a download as `SUCCEEDED` before the ZIP is retrievable. The manager now:

- refreshes download metadata before every artifact attempt,
- prefers GBIF's returned `downloadLink`,
- tries both documented versioned and unversioned retrieval endpoints,
- treats HTTP 5xx/404 artifact responses as temporary availability failures,
- retries without creating a new GBIF job, and
- starts a new GBIF attempt only if the artifact remains unavailable past the configured attempt timeout, and
- reports a rejected GBIF username/password explicitly and stops retrying that job permanently until the configuration is corrected.


Node.js service with a Web UI and REST API for creating, polling, downloading and validating GBIF Darwin Core Archive downloads. Valid archives can be pinned and assigned as replay fixtures for their canonical GBIF query.

See [`docs/architecture.md`](docs/architecture.md) for the state machine and persistence model.

## Implemented workflow

- Accepts GBIF occurrence search URLs.
- Canonicalizes the query and deduplicates identical active jobs.
- Converts the search query through GBIF's official predicate endpoint.
- Reads a preflight result count from the occurrence search API.
- Requests a `DWCA` download with GBIF credentials.
- Polls GBIF every 60 seconds by default.
- Does not submit another request while the current GBIF attempt is running.
- Cancels and retries an attempt after 12 hours by default.
- Downloads ZIP files atomically as `.part` files.
- Validates ZIP paths, sizes, decompression ratios, entry CRCs, `meta.xml`, core TSV structure, row counts, unique `gbifID`s, `verbatim.txt`, and multimedia references.
- Retries invalid results hourly. If GBIF returns the same invalid download key, it is not downloaded again.
- Allows administrators to trigger `RETRY_WAIT`/failed jobs immediately or delete safely waiting/terminal jobs.
- A deleted job returns `JOB_NOT_FOUND` on later status requests so downstream OSCA imports can fail immediately and expose their retry action.
- Deletes unpinned artifacts after 30 days.
- Keeps all job and validation metadata in SQLite. `GET /api/jobs/:id` also reports `artifact_gbif_doi` and `artifact_gbif_download_key` for the **validated artifact**, including fixture replays; failed attempts' DOIs are not used as the archive's provenance.
- Allows a valid job archive to be pinned and mapped as the fixture for its exact canonical query.
- Automatically creates a synthetic replay job when `mode=auto` receives a query with a fixture mapping.

## Important count semantics

Validation treats these as exact when available:

1. `totalRecords` reported by the GBIF download status API.
2. The sum of `N records from …` entries in `metadata.xml`.
3. Actual complete core rows and unique `gbifID`s.

The preflight occurrence-search count is a warning-only comparison because the GBIF index may change while a download is being generated.

## Run locally

Node.js 22 or newer is required. The Docker image uses Node.js 24 LTS and its built-in `node:sqlite` module, avoiding native SQLite addon builds.

```bash
cp .env.example .env
# Edit .env and set GBIF credentials.
npm install
set -a; . ./.env; set +a
npm start
```

Open `http://localhost:3000`.

## Docker

```bash
cp .env.example .env
# Edit credentials and passwords.
docker compose up --build -d
```

Persistent state is stored in the Docker named volume `gbif-data` and mounted at `/data`. Use a bind mount instead only when the host directory is writable by the container user (UID 1000).

## REST API

The OpenAPI description is served at `http://localhost:3000/openapi.yaml`.

### Create a job

```bash
curl -u admin:change-me \
  -H 'content-type: application/json' \
  -d '{
    "url":"https://www.gbif.org/occurrence/search?taxonKey=4TCZM&datasetKey=857bce66-f762-11e1-a439-00145eb45e9a&year=1995%2C2000",
    "mode":"auto"
  }' \
  http://localhost:3000/api/jobs
```

`mode=auto` uses a configured fixture when one exists, otherwise it starts a live GBIF download. `mode=live` always bypasses fixtures. `mode=replay` requires either an existing query fixture or a valid `fixtureArtifactId` in the request body.

If an identical query already has an active job, the API returns that job with:

```json
{
  "deduplicated": true,
  "alreadyRunning": true
}
```

### Status

```bash
curl -u admin:change-me http://localhost:3000/api/jobs/JOB_ID
```

### Download a ready archive

```bash
curl -u admin:change-me -OJ http://localhost:3000/api/jobs/JOB_ID/download
```

Replay responses carry `X-Artifact-Replayed: true`.

### Pin and assign a job archive as this query's fixture

```bash
curl -u admin:change-me -X POST \
  -H 'content-type: application/json' -d '{}' \
  http://localhost:3000/api/jobs/JOB_ID/fixture
```

A later identical `mode=auto` request creates a new synthetic job and serves the same immutable ZIP after the configured replay delay. Replay always checks the stored file size; set `REPLAY_VERIFY_SHA256=true` to hash the complete fixture on every replay.

### Remove query fixture mapping

```bash
curl -u admin:change-me -X DELETE \
  http://localhost:3000/api/jobs/JOB_ID/fixture
```

This removes the query mapping but does not automatically unpin the archive.

## Standalone archive validation

```bash
npm run validate -- /path/to/download.zip 200000
```

The optional number is used both as preflight and GBIF-reported expected count for the standalone check.

## Current MVP boundaries

- One application instance is supported. SQLite leases make restart recovery possible, but multi-replica deployment needs a shared queue and shared artifact storage.
- Local filesystem storage is used. S3-compatible object storage can be added behind the artifact layer later.
- The parser targets GBIF-generated DWCA downloads, whose core is tab-separated and not field-enclosed. Publisher-specific arbitrary DwC-A dialects require a more general delimited-text parser.
- Invalid ZIPs are deleted by default after their validation report is stored. Set `KEEP_INVALID_ARTIFACTS=true` for diagnosis.
- The service uses a conservative default of one active live GBIF download because GBIF limits incomplete downloads per account depending on platform load.

## Production recommendations

- Set `APP_USERNAME` and `APP_PASSWORD`, or place the service behind an authenticated reverse proxy.
- Back up `manager.sqlite` and pinned artifacts.
- Use a dedicated GBIF account and contact email.
- Keep the container clock synchronized.
- Monitor disk usage, retry counts and repeated reuse of invalid GBIF keys.
