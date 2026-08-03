# v1.1 dashboard hotfix

The initial v1.1 calibration wrapper modified dashboard JavaScript by string replacement at request time. Wrangler validates the Worker module but cannot parse JavaScript created dynamically inside the returned HTML, allowing a browser-side syntax regression to pass CI.

The hotfix removes all runtime dashboard source rewriting. URL normalization and finding deduplication remain server-side in `/api/page`, so the existing known-good dashboard receives normalized page URLs and crawl links without having its script mutated after validation.

Future dashboard behavior changes should be made directly in source and covered by a browser-script syntax check rather than runtime string replacement.
