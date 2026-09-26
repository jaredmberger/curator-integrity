# Curator Integrity

Curator Integrity is the standards and consistency auditor for Ocean Liner Curator.

It complements Site Health by answering a different question: not merely whether a page works, but whether it conforms to the project's current structural, metadata, accessibility, and editorial standards.

## v1 scope

- Crawl OceanLiners.net from a configurable starting URL
- Classify pages into broad page families
- Apply configurable standards with error, warning, notice, and info severities
- Score overall integrity and category-level compliance
- Show actionable findings by page and rule
- Support documented exceptions for intentional deviations
- Export findings as CSV

Curator Integrity is read-only in v1. It does not modify OceanLiners.net or GitHub content.

## Disaster recovery

The complete primary `CURATOR_INTEGRITY_RECORDS` namespace can be exported through authenticated `GET /api/recovery-export`. Configure the Worker secret `RECOVERY_EXPORT_TOKEN`; the route remains disabled if the secret is absent. The shared `CURATOR_ERROR_RECORDS` namespace is intentionally excluded because its authoritative recovery export is owned by Error Bus. See [`RECOVERY_EXPORT.md`](RECOVERY_EXPORT.md).
