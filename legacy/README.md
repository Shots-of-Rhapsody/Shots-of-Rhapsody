# Unpublished legacy material

This directory preserves historical repository material that is intentionally excluded from the Astro content tree and public site build.

## `podcast/`

The legacy podcast player and audio file are retained byte-for-byte for repository history. They are not part of the eleven-article launch, are not copied into `dist/`, and must not be published without a separate content, security, accessibility, provenance, and rights review.

In particular, the historical player accepts query-controlled metadata and media paths and writes some values through `innerHTML`. Treat it as archival source, not deployment-ready web code.
