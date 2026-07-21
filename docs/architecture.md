# Architecture and state machine

## Components

```text
Browser / API client
        |
        v
Fastify HTTP server ---- SQLite (jobs, attempts, artifacts, fixtures, events)
        |
        v
Persistent worker ------ GBIF API
        |
        +--------------- local artifact storage
```

The HTTP server and worker run in one Node.js process for the MVP. All durable coordination is stored in SQLite, so an interrupted job resumes after restart once its lease expires.

## Live job state machine

```text
QUEUED
  -> RESOLVING_QUERY
  -> SUBMITTING_TO_GBIF
  -> WAITING_FOR_GBIF
  -> DOWNLOADING
  -> VALIDATING
  -> READY
```

Failure branches:

```text
WAITING_FOR_GBIF -- 12-hour timeout --> RETRY_WAIT
GBIF failed/killed ------------------> RETRY_WAIT
invalid archive ---------------------> RETRY_WAIT
RETRY_WAIT -- after one hour --------> SUBMITTING_TO_GBIF
```

A GBIF key already known to reference an invalid archive is not downloaded again. The worker waits and resubmits later until GBIF returns a different key.

## Replay state machine

A query fixture maps a canonical query hash to a pinned, valid artifact.

```text
QUEUED
  -> WAITING_FOR_GBIF
  -> DOWNLOADING
  -> VALIDATING
  -> READY
```

No GBIF request occurs. The status phases are synthetic and timestamp-driven, which allows downstream integration tests to exercise polling and download behavior.

## Identity and deduplication

The query identity is SHA-256 over sorted URL query parameters after URL decoding and canonical re-encoding. Parameter order therefore does not create a new identity.

Only one active local job may exist for a query hash. A repeated request returns the existing active job. Completed jobs are retained as history and a later request creates a refresh job or a replay job.

## Artifact retention

- Normal valid artifacts expire 30 days after validation.
- Pinned artifacts do not expire.
- Assigning an artifact as a query fixture pins it automatically.
- Removing a fixture mapping does not unpin the artifact automatically.
- A valid old artifact is not removed merely because a refresh has started.
