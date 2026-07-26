# Proton author-master evidence

`master-ledger.v1.json` is the sanitized synchronization boundary between the
35 native author documents and their reviewed repository outputs. It contains
only exact titles, public slugs, timestamps, counts, and cryptographic hashes.
The hero-source hash binds the single image reference in each HTML export
without retaining its private URL; Fiction records also verify the separately
captured PNG byte-for-byte, by dimensions, and by decoded pixels.
Exact cloud titles remain authoritative. Four Fiction cloud documents use the
Windows-compatible underscore spellings `Before the Sky Went Quiet_Part I`,
`Part II`, `Part III`, and `The Guild_A Chronicle of Pretty Souls`; their public
article titles retain canonical colons. Placeholder name/count parity is never
a publication or synchronization gate.

Raw HTML exports, normalized capture input, cloud identifiers, account details,
and machine paths remain in the ignored local import area. The ledger does not
approve content or modify an article. Regeneration is intentionally
no-overwrite: remove an obsolete ledger only after preserving its history and
explicitly approving a new author revision.

The current sealed Medium round-trip exports predate this unified contract and
remain in their fixed ignored export directory. Fresh exports normally belong
under `.proton-import`. On the current protected Windows checkout, that folder
does not permit creation of new timestamped children, so the explicit ignored
fallback `.medium-import/proton-captures/` is accepted for current Chrome
exports. Both roots are local evidence only; neither is a second authoring
workflow or a deployment input.

Cloud inventory may be reconciled read-only with the official Proton Drive CLI
0.6.0 from [Proton's documented download page](https://proton.me/support/drive-cli).
The installed Windows archive was verified before extraction against Proton's
published SHA-512 value
`a7cefbac439b2f54178fcd3c18fbdfc32e150a2e35bfe8f5d3a714fd157e509c59307db09ae71c164bbc8174439acda2bd5fb3fe84c4f1ad4977d1e7fb9fb904`.
The CLI is not a content exporter or runtime dependency. Authenticate in a
browser only for an explicit inventory run, use `filesystem list --json`, then
log out; never commit its output because it contains cloud identifiers.

Use these commands:

```text
pnpm proton:inventory --expected
pnpm proton:inventory
pnpm proton:record
pnpm proton:verify --require-complete
pnpm proton:verify --with-raw --require-complete
```

The normalized local capture has this strict shape:

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-07-26T00:00:00.000Z",
  "sections": {
    "fiction": [
      {
        "slug": "public-slug",
        "title": "Exact cloud document title",
        "exportedAt": "2026-07-26T00:00:00.000Z",
        "file": ".proton-import/raw/public-slug/export.html",
        "heroFile": ".proton-import/raw/public-slug/hero-original.png"
      }
    ],
    "nonfiction": []
  }
}
```

The example is structural only. A complete capture must contain exactly 11
Fiction and 24 Non-Fiction records in the order printed by
`pnpm proton:inventory --expected --json`. Every Fiction record also binds its
separately saved original PNG; Non-Fiction exports embed the hero evidence in
their supported HTML package and therefore omit `heroFile`.
