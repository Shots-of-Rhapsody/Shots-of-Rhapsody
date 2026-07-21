# Vocal provenance

This directory contains the public, reviewable evidence for local imports from the Tai Song Vocal archive.

- `inventory.json` is the fixed 11-article contract, ordered from oldest to newest as confirmed by the author.
- `posts/<slug>.json` is the canonical serialization of the saved page's `props.pageProps.post` object only.
- `manifest.json` is generated after the first import and records source, sanitized, Markdown, and image hashes plus PNG metadata.
- `review-checklist.md` records the required human source and rendered-page comparison.

Raw creator exports and manually downloaded original images remain under the ignored `.vocal-import/` directory. They may contain unrelated page or account configuration and must never be staged or committed.

See [`docs/vocal-import.md`](../../docs/vocal-import.md) for the capture, import, verification, and update procedure.
