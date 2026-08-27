# Medium nonfiction provenance

The official export has been inventoried locally, but the committed import
remains intentionally inactive until every candidate disposition, verified
hero, article record, and human review is complete. The empty inventory and
manifest are fail-closed placeholders; they publish nothing and contain no raw
account data.

Raw ZIP files, candidate inventories, browser-captured Medium derivatives, acquisition evidence, and work-in-progress conversions belong under the ignored `.medium-import/` directory. The fixed raw hero name is `hero-medium.webp`: it identifies the highest responsive Medium derivative observed in the logged-in browser, not an original upload. A separate ignored, metadata-free `hero-sanitized.webp` must pass exact decoded-pixel and dimension verification before the importer can copy it into a post. Only a reviewed inventory, sanitized snapshots, deterministic output hashes, and verified site-ready assets may be committed. The reviewed inventory retains the hash-bound disposition of every exported story candidate, including exclusions and their reasons.

[`approved-titles.v1.json`](approved-titles.v1.json) records the exact 24-title
release allowlist approved by Tai Song. It is non-rendered input to the local
hero-acquisition checklist only: it does not classify the other nine export
candidates, approve an image, or publish an essay. Its 33-candidate binding
prevents a stale, incomplete, or expanded export from producing a release
checklist silently.

Its candidate-set hash is the immutable identity used when the hero evidence
was acquired. It remains intentionally backward-compatible. Each candidate's
included source SHA-256 already binds the complete HTML bytes; reviewed display
fields are re-extracted from those bytes and compared exactly during raw-backed
import, then carried by the separately hashed reviewed inventory, snapshot, and
manifest. Presentation fields therefore cannot be edited independently without
failing verification, while the historical image-acquisition identity remains
truthful.

[`hero-assets.v1.json`](hero-assets.v1.json) is the sanitized, non-rendered
asset anchor for those exact 24 works. It records only public Medium identity,
capture and site-ready hashes, dimensions, decoded-pixel hashes, and the exact
ignored acquisition-manifest SHA-256. It deliberately excludes local absolute
paths, account information, and private document identifiers. The ignored
`.medium-import/hero-acquisition-results.json` ledger must match every anchored
identity, URL, fixed local repository path, capture hash, byte size, dimension,
and item position before any source image is read.

`pnpm medium:review-inventory .medium-import/raw/medium-export.zip --write`
creates an ignored, non-publishing disposition proposal. The proposal retains
all 33 candidate metadata and source hashes, binds the exact 24 approved
standalone titles, marks the remaining nine as excluded responses, and verifies
the Tai Song author credit in every official export footer. It is not the
committed reviewed inventory: it has no article records, verified site-ready assets,
reviewer, approval timestamp, or publication effect, and it refuses to
overwrite an existing proposal.

For each of the 24 included essays, the proposal also preserves five distinct
source roles: the outer export metadata title and optional summary, the visible
display title, the visible display subtitle, and the article-specific Ledger
Series sentence. The importer then requires `display title → display subtitle →
Ledger Series sentence → hero → authored body` in every source and rendered
page. It never treats the export metadata title as the public heading, moves the
Ledger sentence into the article body, or promotes the first post-hero paragraph
into a heading.

`pnpm medium:sanitize-image --all` derives the exact 24-slug selection from the
validated durable anchor and ignored acquisition ledger; it does not discover
articles by scanning folders or a broad glob. Single-slug mode uses the same
complete binding. Dry-run is the default. `--write` refuses every existing
target and creates one sanitized image plus one verification record per
approved slug only after every input validates. Each file installation is
atomic and no-replace; the 48-file batch is rollback-protected but is not
claimed to be globally atomic. Inputs and outputs are bounded before reads,
records have a separate 64 KiB limit, and symbolic-link or junction escapes
from the fixed ignored roots fail closed. Raw captures remain ignored and are
never importer or deployment inputs.

The reviewed inventory, per-article snapshot, and final Medium manifest carry
the acquisition-manifest, capture, site-ready, and decoded-pixel hashes forward.
Verification reconciles them with `hero-assets.v1.json`; a swapped or stale
asset cannot be published merely because its filename is valid.

Copy fidelity, optional factual research, and publication approval remain separate records. `claim-reviews.json` may bind internal nonfiction research to current source and output hashes, but it is not a v1.0.0 publication gate and never changes imported prose. A current Tai Song source-fidelity and rights `ContentSignoffV2` plus an explicit entry in the aggregate publication catalog are required before an imported article can enter an approved release.

The Medium source package is separate from the sealed 11-work Proton/Vocal archive. Importing nonfiction must not rewrite or reinterpret that existing evidence.
