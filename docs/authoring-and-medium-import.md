# Writing and Medium nonfiction workflow

## Start a future draft

Create a non-public draft with a lowercase ASCII slug:

```sh
pnpm content:new --section nonfiction --slug example-title
```

Valid sections are `fiction`, `poetry-reflection`, and `nonfiction`. The command refuses to overwrite an existing path. Complete the title, subtitle, summary, description, category, image, caption, alt text, tags, and body before review. Keep `draft: true` until source, rights, accessibility, and presentation checks pass.

Directly authored work is recorded in `provenance/first-party/manifest.json`
only after its Markdown and assets are final. A matching human
`ContentSignoffV2` is then required before the work can enter the approved
publication catalog. The legacy `new-post` command is a safe alias of
`content:new`; it can no longer create a public post.

Use descriptive headings in logical order, short card summaries that accurately describe the work, meaningful link text, and concise alternative text for informative images. Use `imageAlt: null` only when an image is genuinely decorative and its visible caption carries the relevant context. Do not add search keywords, artificial update dates, or generated filler to an authored work.

## Acquire the official Medium export

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

4. Compare every candidate with the public author profile. Include only public, original, standalone stories. Exclude drafts, unlisted stories, reposts, and responses.
5. Retain a disposition for every exported HTML file—include, or exclude with
   a reason—and preserve the candidate-set count and hash. Review exact titles,
   subtitles, descriptions, summaries, publication timestamps, URLs, tags,
   image alt text, captions, and original-image ownership before promoting data
   into `provenance/medium/inventory.json`.
6. Save each author-controlled original PNG, JPEG, or WebP under `.medium-import/raw/assets/<slug>/`. Do not use screenshots, thumbnails, transformed delivery URLs, or images whose reuse rights are unclear.

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
pattern—`.medium-import/raw/assets/<slug>/hero-original.<ext>`—until the real
original file determines its extension and MIME type.
The JSON also marks every exported hero URL `comparison-reference-only`, states
that an original asset is still required, and forbids automated download.

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

The converter recognizes Medium's official export envelope explicitly. It
validates and removes only the known header, subtitle, body-layout, and footer
wrappers. It also reconciles Medium's leading renderer title/subtitle shell:
those nodes are omitted only when their text matches the reviewed metadata
exactly, allowing only Medium's observed non-breaking-space presentation
substitution. Distinct `h2`, `h3`, and `h4` text remains authored body content.
When the export has no `p-summary`, its observed leading renderer `h4` becomes
the subtitle candidate and is subject to the same exact reconciliation.
Medium's export-only head stylesheet is ignored and never deployed, while any
style or active markup in the authored body fails closed.

The converter preserves text, headings, paragraphs, lists, quotations, links,
emphasis, inline breaks, Unicode—including non-breaking spaces—code, and
reviewed images through an explicit HTML allowlist. Link destinations retain
their exact exported query strings. Unknown wrappers, attributes, embeds,
unsafe URLs, scripts, forms, tracking markup, missing images, and metadata
disagreements stop the import for review. Response-like filenames or titles are
never excluded heuristically: every exported post remains unresolved until Tai
Song records its reviewed classification.

Source fidelity and factual review are separate. Never silently correct imported prose. Bind each entry in `provenance/medium/claim-reviews.json` to the current source and Markdown hashes, and record material nonfiction claims against primary sources. An unresolved material claim blocks publication until Tai Song corrects the author master and re-imports it or excludes the article.

Importing creates sealed evidence but does not publish a work. A Medium article
becomes eligible for `provenance/publication-catalog.json` only when the complete
manifest, original assets, claim review, and matching `ContentSignoffV2` record
all verify. This separate allowlist prevents partial imports and unsigned drafts
from entering routes, RSS, search, or the sitemap.

## Publication boundary

Source-platform names, URLs, IDs, ZIP hashes, and acquisition details remain in non-rendered provenance and repository documentation. Reader pages use only Shots of Rhapsody branding. Raw exports, account data, local paths, and `.medium-import/` must never be committed or deployed.

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
- [Google people-first content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
