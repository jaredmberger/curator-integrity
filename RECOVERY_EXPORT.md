# Curator Integrity Recovery Export

Curator Integrity provides a complete, read-only backup of the `CURATOR_INTEGRITY_RECORDS` Cloudflare KV namespace at:

`GET /api/recovery-export`

The shared `CURATOR_ERROR_RECORDS` binding is intentionally excluded because Error Bus owns its authoritative recovery path.

## Security

Configure the Worker secret:

`RECOVERY_EXPORT_TOKEN`

Send it as:

`X-Curator-Recovery-Key: <RECOVERY_EXPORT_TOKEN>`

If the secret is absent, the endpoint remains disabled.

## Scope

The exporter paginates every key in `CURATOR_INTEGRITY_RECORDS` and preserves exact key/value pairs, including retained historical audit state and future key families.

Each backup includes export timestamp, namespace identity, total key count, SHA-256 integrity metadata, and the complete key/value payload.

The downloaded filename is:

`curator-integrity-recovery-<timestamp>.json`

## Validation

```bash
node scripts/validate-recovery-backup.mjs /path/to/curator-integrity-recovery-....json
```

## iPad / iPhone backup

Use Shortcuts:

1. Get Contents of URL
2. URL: `https://integrity.oceanliners.net/api/recovery-export`
3. Method: GET
4. Header: `X-Curator-Recovery-Key` = the configured recovery token
5. Save File

## Restore policy

There is intentionally no production restore endpoint. Any restore should first target a disposable KV namespace and be verified before production is considered.
