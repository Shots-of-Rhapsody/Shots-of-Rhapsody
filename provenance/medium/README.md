# Medium nonfiction provenance

The official export has been inventoried locally, but the committed import
remains intentionally inactive until every candidate disposition, original
hero, article record, and human review is complete. The empty inventory and
manifest are fail-closed placeholders; they publish nothing and contain no raw
account data.

Raw ZIP files, candidate inventories, original-image acquisition evidence, and work-in-progress conversions belong under the ignored `.medium-import/` directory. Only a reviewed inventory, sanitized snapshots, deterministic output hashes, and author-controlled original assets may be committed. The reviewed inventory retains the hash-bound disposition of every exported story candidate, including exclusions and their reasons.

[`approved-titles.v1.json`](approved-titles.v1.json) records the exact 24-title
release allowlist approved by Tai Song. It is non-rendered input to the local
hero-acquisition checklist only: it does not classify the other nine export
candidates, approve an image, or publish an essay. Its 33-candidate binding
prevents a stale, incomplete, or expanded export from producing a release
checklist silently.

`pnpm medium:review-inventory .medium-import/raw/medium-export.zip --write`
creates an ignored, non-publishing disposition proposal. The proposal retains
all 33 candidate metadata and source hashes, binds the exact 24 approved
standalone titles, marks the remaining nine as excluded responses, and verifies
the Tai Song author credit in every official export footer. It is not the
committed reviewed inventory: it has no article records, original assets,
reviewer, approval timestamp, or publication effect, and it refuses to
overwrite an existing proposal.

Copy fidelity, factual review, and publication approval are separate gates. `claim-reviews.json` binds nonfiction claim review to the current source and output hashes. A current Tai Song `ContentSignoffV2` and an explicit entry in the aggregate publication catalog are also required before an imported article can become a public route.

The Medium source package is separate from the sealed 11-work Proton/Vocal archive. Importing nonfiction must not rewrite or reinterpret that existing evidence.
