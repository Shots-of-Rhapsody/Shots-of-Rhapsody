# Writing and Medium nonfiction workflow

## Current source-of-truth workflow

Work only from the canonical checkout; do not use or recreate duplicate or
retired checkouts. Proton Docs is the current authoring master for all writing.
The publication flow is strictly one-way:

```text
Proton Docs -> supported HTML export -> deterministic verification -> reviewed Git pull request -> GitHub Actions -> GitHub Pages
```

Keep exactly two native-document folders under `Blogging` in Proton Drive:
`Fiction` for fiction, poetry, and reflection, and `Non-Fiction` for
nonfiction. The repository mirrors them at
`src/content/posts/fiction/<slug>/` and
`src/content/posts/nonfiction/<slug>/`. Storage folders do not appear in public
addresses; every approved work keeps `/posts/<slug>/`.

The official Medium export described below is sealed historical acquisition
evidence for the initial nonfiction import. It is not an alternate authoring
master and must never be used to fill in, overwrite, or silently repair a
missing or changed Proton document. Stop and obtain a supported Proton Docs
HTML export instead.

## Start a future draft

Create a non-public draft with a lowercase ASCII slug:

```sh
pnpm content:new --section nonfiction --slug example-title
```

Valid sections are `fiction`, `poetry-reflection`, and `nonfiction`. Fiction and
poetry/reflection drafts are created beneath `src/content/drafts/fiction/`;
nonfiction drafts are created beneath `src/content/drafts/nonfiction/`. The
command refuses to overwrite an existing draft or published slug. Complete the
title, subtitle, summary, description, category, image, caption, alt text,
tags, and body before review. Keep `draft: true` until source, rights,
accessibility, and presentation checks pass.

Directly authored work is recorded in `provenance/first-party/manifest.json`
only after its Markdown and assets are final. A matching human
`ContentSignoffV2` is then required before the work can enter the approved
publication catalog. The legacy `new-post` command is a safe alias of
`content:new`; it can no longer create a public post.

Use descriptive headings in logical order, short card summaries that accurately describe the work, meaningful link text, and concise alternative text for informative images. Use `imageAlt: null` only when an image is genuinely decorative and its visible caption carries the relevant context. Do not add search keywords, artificial update dates, or generated filler to an authored work.

## Preserve the historical Medium acquisition evidence

Use Medium's logged-in **Settings → Security and apps → Download your information → Export** flow. Automated requests, profile scraping, RSS copies, and reader-page HTML are not accepted source evidence.

1. Save the untouched download as `.medium-import/raw/medium-export.zip`.
2. Do not extract, edit, normalize, or re-save the ZIP or its HTML files.
   Medium exports may omit the ZIP UTF-8 filename flag. The bounded reader
   accepts that official variant only when every unflagged filename byte is
   printable ASCII and round-trips exactly; non-ASCII or ambiguous legacy
   encodings stop inventory creation.
3. Generate an ignored review candidate:

   ```sh
   pnpm medium:inventory .medium-import/raw/medium-export.zip --captured-at 2026-07-25T12:34:56.000Z --write
   ```

   After the exact release-title and response dispositions are approved, create
   a separate non-publishing proposal:

   ```sh
   pnpm medium:review-inventory .medium-import/raw/medium-export.zip --write
   ```

   This verifies the source footer author on all 33 candidates and refuses to
   overwrite an existing proposal. It does not create the final inventory or
   any human signoff.

4. Compare every candidate with the public author profile. Include only public, original, standalone stories. Exclude drafts, unlisted stories, reposts, and responses.
5. Retain a disposition for every exported HTML file—include, or exclude with
   a reason—and preserve the candidate-set count and hash. For every included
   essay, review the export metadata title and summary separately from the
   visible display title, display subtitle, article-specific Ledger Series
   sentence, hero, and post-hero authored body. Also review publication
   timestamps, URLs, tags, image alt text, captions, image identity, and
   republication rights before promoting data into
   `provenance/medium/inventory.json`.
6. In the logged-in browser, open each approved story and inspect its loaded
   responsive image candidates. Expand the viewport through 4800 CSS pixels,
   confirm that no larger Medium candidate appears, and save the exact response
   bytes of the highest observed candidate as
   `.medium-import/raw/assets/<slug>/hero-medium.webp`. This is a browser-captured
   Medium responsive derivative, not the original upload. Do not use a
   screenshot, the export's `max/800` reference, a smaller candidate, automated
   requests, or any image whose identity or reuse rights are unclear.

Generate the acquisition checklist from the explicit, versioned release
allowlist. This command performs no network requests and writes no image bytes:

```sh
pnpm medium:assets .medium-import/raw/medium-export.zip --titles-file provenance/medium/approved-titles.v1.json
```

Review the JSON on standard output first. Add `--write` only when you want to
create the ignored `.medium-import/hero-acquisition-checklist.json`. The command
refuses to overwrite an existing checklist, requires all 24 approved titles to
occur exactly once within the exact 33-candidate export, requires exactly nine
candidates outside the allowlist, and rejects missing or multiple featured
heroes, unsafe URLs, conflicting story/image identities, and duplicate slugs or
URLs. It also
verifies the allowlist's exact ZIP and candidate-set SHA-256 bindings
before inspecting any hero evidence. Each exported `data-image-id` must equal
the final decoded path component of its source URL; mismatched or swapped URLs
stop the checklist. The output preserves the export's exact hero URL, declared
dimensions, and the distinction
between absent and empty alt/caption evidence. When the official export omits
its featured flag, the checklist records `sole-exported-figure` only if exactly
one exported figure image exists; it never hides that weaker identification
evidence. The destination remains a
fixed capture path—`.medium-import/raw/assets/<slug>/hero-medium.webp`—and the
checklist labels it `highest-observed-medium-responsive-derivative` with
`originalUploadClaimed: false`. It also records the separate site-ready target
`.medium-import/site-ready/assets/<slug>/hero-sanitized.webp`, marks the exported
hero URL `comparison-reference-only`, and forbids automated download.

Sanitize the captured heroes locally before any article import. Both commands
are non-writing by default:

```sh
pnpm medium:sanitize-image --slug <slug>
pnpm medium:sanitize-image --all
```

[`provenance/medium/hero-assets.v1.json`](../provenance/medium/hero-assets.v1.json)
is the durable, non-rendered 24-item asset anchor. It binds the approved title
order, public story and hero identities, canonical and observed URLs, captured
and sanitized byte hashes and dimensions, decoded-pixel hashes, and the exact
ignored acquisition-ledger SHA-256
`sha256:0d69e778a94687b646431598575d593b246425b9762863f96156bbb3471953aa`.
It contains no account data, local absolute paths, or private document IDs.

Both single-slug and `--all` modes validate that anchor against the exact
ignored `.medium-import/hero-acquisition-results.json` ledger before reading an
image. `--all` takes its exact 24 slugs, in order, from that validated binding;
it never scans an asset directory or broad filesystem glob to discover work.
Swapped story IDs, image IDs, URLs, paths, hashes, dimensions, sizes, order, or
duplicate items stop the entire operation. After the complete dry run succeeds,
add `--write` to create one ignored `hero-sanitized.webp` and
`hero-sanitization.json` per approved slug.

Every source, generated image, and verification record is size-checked with
`lstat` before it is opened or read. The record has its own 64 KiB cap. Fixed
ignored-root components are created one at a time and symbolic-link or junction
escapes are rejected. Existing outputs are never overwritten. Each of the 48
batch files is installed atomically with a same-filesystem hard link using
no-replace semantics; the batch is not globally atomic, but an identity-checked
rollback removes files installed by a failed batch without deleting an
unrelated replacement.

The sanitizer uses the repository-pinned Sharp release to decode the source,
reject malformed or animated input, remove EXIF, XMP, IPTC, ICC profiles,
comments, and every other auxiliary WebP chunk, and write a lossless WebP. It
then decodes both files into sRGB RGBA bytes and requires the dimensions and
every decoded pixel to be identical. The importer consumes only the verified
site-ready bytes; raw captures and their acquisition metadata remain ignored
evidence and can never be copied into article directories or `dist`.

The future reviewed inventory, sanitized snapshot, and committed Medium
manifest must carry the acquisition-manifest hash, captured-byte hash,
sanitized-byte hash, and decoded-pixel hash for every hero. Verification checks
those values against the durable asset anchor before an essay can enter the
publication catalog.

The approved-title file is a non-rendered release allowlist, not a substitute
for candidate reconciliation. `medium:inventory` must continue to retain all
33 exported candidates; the nine titles outside the allowlist stay unresolved
until their explicit excluded-response dispositions are recorded in the
reviewed inventory. Never use title shape, length, filename, or hero presence to
classify a response.

The candidate is deliberately not a publishable inventory: classification fields remain unset, and the importer rejects it.

## Import and verification

Run a read-only plan first:

```sh
pnpm medium:import --slug <slug>
```

After reviewing every proposed output, use `--write`. Existing managed content can change only with `--write --update`, and only when its current files still match their recorded manifest hashes.

```sh
pnpm medium:import --slug <slug> --write
pnpm medium:verify --slug <slug> --with-raw
pnpm content:verify --require-complete
```

The converter recognizes Medium's official export envelope explicitly. For an
included essay it requires the exact significant-element order observed in all
24 approved exports: renderer `h2`/`h3` display title, renderer `h4` display
subtitle, one article-specific `A Ledger Series article ...` paragraph, hero
figure, then authored body. These presentation fields are compared code point
for code point with the reviewed inventory and rendered in the same order. The
outer export `h1` title and optional `p-summary` remain separate provenance
fields because they are not interchangeable with the public display title and
subtitle. After the hero, real source headings remain headings, bold paragraphs
remain bold paragraphs, and ordinary paragraphs are never promoted. Medium's
export-only head stylesheet is ignored and never deployed, while any style or
active markup in the authored body fails closed.

Cards and page metadata use the exact exported summary when one exists. The one
approved essay without an export summary requires an explicit Tai Song-reviewed
site summary in the final inventory; the tooling never silently substitutes the
display subtitle or generates new copy.

The converter preserves text, headings, paragraphs, lists, quotations, links,
emphasis, inline breaks, Unicode—including non-breaking spaces—code, and
reviewed images through an explicit HTML allowlist. Link destinations retain
their exact exported query strings. Unknown wrappers, attributes, embeds,
unsafe URLs, scripts, forms, tracking markup, missing images, and metadata
disagreements stop the import for review. Response-like filenames or titles are
never excluded heuristically: every exported post remains unresolved until Tai
Song records its reviewed classification.

Source fidelity and factual review are separate. Never silently correct imported
prose. The v1.0.0 release gate verifies exact reproduction from the hash-bound
author master; `accuracy: "passed"` in `ContentSignoffV2` records that specific
source-fidelity decision. Independent claim research may be kept in
`provenance/medium/claim-reviews.json` as optional internal evidence, but its
presence or outcome does not publish, block, qualify, or alter an essay. Any
author-approved factual correction must still be made in the author master,
re-imported, rehashed, and reviewed again.

Importing creates sealed evidence but does not publish a work. A Medium article
becomes release-eligible only when the complete manifest, verified site-ready
assets, and matching source-fidelity and rights `ContentSignoffV2` record all
verify. `provenance/publication-catalog.json` is the exact 35-work release
allowlist; missing or stale approvals keep release mode fail-closed even when an
entry is present. This separation prevents partial imports and unsigned drafts
from entering an approved release.

## Establish and update the Proton Non-Fiction masters

Proton Docs is the private authoring master, but it is not a website runtime.
For the initial 24-essay migration only, create a self-contained bootstrap
package after the reviewed historical inventory and imported snapshot for that
slug verify. The default command is a non-writing dry run:

```sh
node scripts/content/master-package.js --slug <slug>
node scripts/content/master-package.js --slug <slug> --write
```

The write mode creates exactly one ignored, self-contained bootstrap file at
`.medium-import/proton-masters/<slug>/master.html`. It embeds the approved
sanitized hero instead of loading it over the network, refuses to overwrite an
existing package, and contains no Proton URL or document identifier. Its visible
order is the exact exported headline and reviewed summary, authored title,
authored subtitle, Ledger Series sentence, hero and complete post-hero body.
Marks, links, lists, quotations, line breaks, blank blocks and Unicode come from
the sealed Medium snapshot without editorial rewriting.

Import the package through Proton Docs, then use the exact target cloud name
from the reviewed inventory. Keep the Drive layout flat and exact:

```text
Blogging/
├── Fiction/       # the existing 11 native documents; never changed here
└── Non-Fiction/   # exactly one native document per approved Medium essay
```

Do not copy, rename, rewrite, or reorganize anything in `Fiction` while
establishing `Non-Fiction`. Some exact article titles contain characters that
Windows cannot represent in a local filename. Use the reviewed,
Windows-compatible target cloud name instead of inventing another spelling,
and do not rename a cloud master merely to force desktop-placeholder parity.
Never read, hash, edit, or treat a zero-byte `.protondoc` placeholder as content
evidence.

The optional official Proton Drive CLI may authenticate in the browser for an
explicit inventory run and list only `Blogging/Fiction` and
`Blogging/Non-Fiction` read-only. Its raw JSON contains cloud identifiers and
must remain ignored. The CLI does not export Docs content, establish semantic
fidelity, modify the cloud folders, participate in GitHub Actions, or serve the
live site.

Run package-script options directly with pnpm 11; do not insert an additional
literal `--`. Capture each observation to a new timestamped ignored file:

```powershell
pnpm proton:cloud-capture --cli <absolute-cli-path> --output .proton-import/cloud-inventory.<timestamp>.v1.json
pnpm proton:cloud-verify --capture .proton-import/cloud-inventory.<timestamp>.v1.json --preflight --require-complete
```

Preflight permits only exact, uniquely mapped legacy names. After the reviewed
one-at-a-time cloud renames, capture again to a different timestamped file and
omit `--preflight`; final verification must pass before evidence is promoted:

```powershell
pnpm proton:cloud-verify --capture .proton-import/cloud-inventory.<final-timestamp>.v1.json --require-complete
```

Promotion means passing that exact final capture to `proton:record-v2`; it does
not mean overwriting or editing an earlier observation. The record command also
requires 35 fresh timestamped Docs exports, verifies all raw evidence, binds the
immutable V1 ledger, and refuses to overwrite an existing V2 ledger:

```powershell
pnpm proton:capture-scaffold --generated-at <UTC-ISO-TIMESTAMP> --cloud .proton-import/cloud-inventory.<final-timestamp>.v1.json
pnpm proton:record-v2 --capture .proton-import/capture.v2.json --cloud .proton-import/cloud-inventory.<final-timestamp>.v1.json
pnpm proton:verify-v2 --with-raw --with-cloud --require-complete --require-final-cloud --capture .proton-import/capture.v2.json --cloud .proton-import/cloud-inventory.<final-timestamp>.v1.json
```

Until that fresh V2 capture exists, the immutable V1 ledger and
`pnpm proton:verify` remain available as the historical local evidence
contract, while release CI and review deployment intentionally remain blocked.
After V2 is committed, it becomes the sole current-content gate and retains the
exact V1 ledger hash as immutable ancestry. Never fabricate a V2 capture or copy
legacy exports into the timestamped structure merely to make the new command
pass.

After importing or intentionally revising a document in Proton Docs, use Docs'
supported HTML export and save it beneath the ignored `.proton-import/`
directory, for example
`.proton-import/raw/<master-folder>/<slug>/<timestamp>/document.html`. Verify
that export locally:

```sh
node scripts/content/master-verify.js --slug <slug> \
  .proton-import/raw/<master-folder>/<slug>/<timestamp>/document.html
pnpm proton:verify-v2 --with-raw --with-cloud --require-complete --require-final-cloud
```

The verifier performs no network requests. It requires embedded image bytes or
safe sibling image files and compares semantic block order, exact text, marks,
lists, links, line breaks and Unicode with the sealed snapshot. It separately
decodes the hero and requires the exact approved dimensions and pixel identity;
re-encoding alone is tolerated only when every decoded pixel remains identical.
Remote images, Proton URLs or IDs, active markup, unsafe paths, linked files,
malformed HTML, changed semantics and `.protondoc` placeholders fail closed.
The bootstrap package, Proton export, cloud inventory, and verifier result
remain ignored local evidence and are never required by GitHub Actions or the
live static site. After a Proton master is established, do not regenerate it
from the historical Medium ZIP or a public Medium page; an unavailable or
ambiguous Proton export blocks publication.

For a later intentional single-work revision, first record the exact current
V2 ledger hash. `proton:update` defaults to a dry run, regenerates all bindings,
requires a final unchanged cloud inventory, rejects any non-target drift, and
reports only the changed evidence fields and approval invalidation:

```powershell
pnpm proton:update --slug <slug> --previous-ledger-sha sha256:<digest> --capture .proton-import/capture.v2.json --cloud .proton-import/cloud-inventory.<timestamp>.v1.json
```

Review that output before repeating the same command with `--write`. A title,
slug, master-folder, cloud-name, or second-work change is outside this guarded
update path and requires a separately reviewed migration.

## Publication boundary

Source-platform names, URLs, IDs, ZIP hashes, and acquisition details remain in non-rendered provenance and repository documentation. Reader pages use only Shots of Rhapsody branding. Raw exports, account data, cloud identifiers, local paths, `.proton-import/`, and `.medium-import/` must never be committed or deployed.

No local importer utility is required by the live static site. GitHub Actions builds only committed, approved content with the frozen JavaScript dependency graph.

After building the frozen v1.0.0 candidate, generate—never auto-approve—the
release-wide presentation evidence with:

```sh
pnpm content:presentation-evidence --release v1.0.0
```

Tai Song records the displayed commit and hashes only after responsive and
accessibility review. Verification then uses the same command with `--verify`;
the command checks current renderer and complete built-site bytes plus Git
ancestry, but it never writes or impersonates a human signoff.

Authoritative references:

- [Medium account export](https://help.medium.com/hc/en-us/articles/115004745787-Export-your-account-data)
- [Medium Rules](https://help.medium.com/hc/en-us/articles/213477928-Medium-Rules)
- [Medium RSS limitations](https://help.medium.com/hc/en-us/articles/214874118-Using-RSS-feeds-of-profiles-publications-and-topics)
- [Astro content collections](https://docs.astro.build/en/guides/content-collections/)
- [Astro image handling](https://docs.astro.build/en/guides/images/)
- [Sharp image output](https://sharp.pixelplumbing.com/api-output/)
- [Proton Docs import and export](https://proton.me/support/drive-import-export-docs)
- [Proton Drive CLI](https://proton.me/support/drive-cli)
- [Google people-first content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
