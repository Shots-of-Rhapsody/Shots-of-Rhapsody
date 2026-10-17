# Nonfiction provenance

This directory preserves the historical Medium acquisition evidence for 24 nonfiction essays. The [active manifest](manifest.json) binds their source snapshots, generated Markdown, and verified hero images. Current author revisions follow the Proton Docs workflow documented in the [writing guide](../../docs/authoring-and-medium-import.md).

## Evidence map

- [Approved titles](approved-titles.v1.json): the exact 24-work selection, bound to the original 33-candidate export
- [Inventory](inventory.json): reviewed inclusion or exclusion decisions, including the nine excluded responses
- [Hero assets](hero-assets.v1.json): image identities, hashes, dimensions, and acquisition-evidence binding
- [Article snapshots](posts/): sanitized source and presentation records
- [Manifest](manifest.json): the verified relationship between source, output, and assets
- [Claim reviews](claim-reviews.json): optional internal research, separate from source fidelity and publication approval

## Preserve fidelity

The importer preserves five distinct elements: export title, optional export summary, display title, display subtitle, and the article's Ledger Series sentence. Rendered articles retain the order `display title → display subtitle → Ledger Series sentence → hero → authored body`.

The historical candidate-set identity remains immutable. Source HTML hashes, reviewed inventory, snapshots, and output hashes bind later verification to that evidence. Historical exports must not replace a missing or changed current author master.

Hero records distinguish the captured Medium derivative from its metadata-free, site-ready derivative. Sanitization must preserve decoded pixels and dimensions. Raw captures remain excluded from import and deployment inputs; a valid filename alone never establishes an image's identity.

## Review and privacy

Only reviewed inventories, sanitized snapshots, deterministic hashes, and verified assets belong in Git. Keep raw exports, acquisition logs, account data, private document identifiers, and absolute file paths out of committed records.

Import and image tools default to non-writing checks where documented. Image sanitization writes must preserve earlier evidence and reject existing targets. Image batches have rollback protection; they are not globally atomic.

Source fidelity, optional factual research, and publication approval are separate. A current Tai Song source-fidelity and rights `ContentSignoffV2`, plus an explicit [catalog](../publication-catalog.json) entry, is required for release. Automated tools never create human approvals or rewrite prose to satisfy research findings.

See the [writing workflow](../../docs/authoring-and-medium-import.md) for exact commands and the [content rights policy](../../CONTENT-LICENSE.md) for reuse restrictions. This evidence remains separate from the [11-work archive](../tai-song/README.md).
