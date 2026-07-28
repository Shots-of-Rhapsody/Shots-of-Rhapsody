# Tai Song author-master archive import

This runbook imports and verifies the fixed 11-article Tai Song archive from the
author's native documents in `Blogging/Fiction` in Proton Drive. The supported
publication path is Proton Docs HTML export, deterministic local verification,
a reviewed Git pull request, GitHub Actions, and GitHub Pages. The importer is
local-only: it does not log in to, request, or scrape Proton or Vocal. Proton
Docs HTML exports are authoritative for article text, inline bold and italic
marks, empty paragraphs, subtitle, hero placement, caption, and nullable image
alt text. The fixed inventory supplies publication dates, summaries,
communities, and historical public Vocal links as non-rendered evidence; Vocal
is never a fallback source for a missing or changed Proton master.

Run the workflow only from the canonical checkout; do not use or recreate
duplicate or retired checkouts. Private Proton document URLs, document
identifiers, account data, cloud-inventory output, and editor configuration
must never be committed. Raw exports remain under the ignored
`.proton-import/` directory.

The optional official Proton Drive CLI may be used only to list the two cloud
folders read-only and reconcile document names. It is not a Docs exporter,
does not establish content fidelity, and is not required by builds or the live
site. Supported HTML export from Proton Docs is the only content-acquisition
path.

## Export one author master

1. Sign in to Proton Drive, open `Blogging/Fiction`, and open the intended native document.
2. Confirm the title and that the editor contains the final article and hero image.
3. Open the document-title menu, choose **Download**, then choose **Web page (.html)**.
4. Do not edit, re-save, prettify, or normalize the downloaded HTML.
5. Place it at `.proton-import/raw/<master-folder>/<slug>/<timestamp>/document.html`.
6. Resolve the export's sole hero reference to the originally uploaded PNG and save its response bytes beside the document as `hero-original.png`. For the observed Cloudinary URLs, validate the exact `res.cloudinary.com/jerrick/image/upload/<transformation>/<public-id>.png` shape and remove only the transformation component; Cloudinary documents that a delivery URL without transformations returns the originally uploaded asset. Do not guess at another path. See [Cloudinary image delivery](https://cloudinary.com/documentation/image_delivery_options) and [transformation URL rules](https://cloudinary.com/documentation/cloudinary_transformation_rules).
7. Verify that the saved response is a PNG, not a screenshot or transformed JPEG preview. Do not use an image editor, optimizer, or format converter.
8. Record the actual UTC capture time. A first write or changed raw evidence requires that timestamp in canonical form, such as `2026-07-21T12:34:56.000Z`.

A Word or PDF download may be retained locally as a secondary visual witness, but neither is an accepted importer input. HTML is required because it preserves the hero reference, empty blocks, and inline break structure.

## Import and verify one article

Run a read-only plan first:

```sh
pnpm archive:import -- --slug <slug>
```

After reviewing the plan, write the deterministic outputs:

```sh
pnpm archive:import -- --slug <slug> --captured-at <UTC-ISO-TIMESTAMP> --write
pnpm archive:verify --slug <slug> --with-raw
pnpm check
pnpm build
pnpm verify:site
```

The write creates or updates only:

```text
provenance/tai-song/posts/<slug>.json
provenance/tai-song/manifest.json
src/content/posts/fiction/<slug>/index.md
src/content/posts/fiction/<slug>/hero-original.png
```

The snapshot contains the sanitized document model and hashes, not private
Proton references. The generated Markdown uses explicit HTML paragraphs so
text, empty paragraphs, inline breaks, Unicode, and observed bold/italic
boundaries survive Markdown parsing. The physical `fiction` folder is a storage
boundary only; each article retains its stable public route at
`/posts/<slug>/`.

## Reviewed source updates

If an already imported master has intentionally changed, first inspect the dry-run. Then use `--write --update` with a new capture time. The updater refuses to replace a managed output if its current hash no longer matches the manifest, preventing an unnoticed overwrite of local edits.

## Complete-archive gate

After all 11 articles have been imported, run:

```sh
pnpm test:archive
pnpm archive:verify --with-raw --require-complete
pnpm lint:ci
pnpm check
pnpm build
pnpm verify:site
pnpm verify:release
```

The complete verifier requires all 11 fixed slugs, unique historical publication URLs, exact body structure and hashes, exact PNG bytes and metadata, and matching generated outputs. It does not claim the former Vocal word-count total because Proton Docs author masters are now the text authority. A missing Proton export blocks the update; historical Vocal evidence must not be substituted for it.

## Human review

Compare every built article side-by-side with its Proton author master and record the result in the structured [`ReviewSignoffV1` record](../provenance/tai-song/review-signoffs.json), using the [human-review checklist](../provenance/tai-song/review-checklist.md). Check title, subtitle, summary, full uncropped hero, caption, paragraph order, empty paragraphs, line breaks, emphasis, punctuation, Unicode, ending text, and rendered layout. Never generate reviewer identities or passed checks from automated results.

The normal site verifier permits only the exact empty pending signoff template; malformed or partial records still fail. Do not call the archive complete or publish until `pnpm verify:release` passes with all 11 structured human-review signoffs complete. Never commit `.proton-import/`, raw CLI output, or any Proton identifier.

Authoritative Proton operations are documented in [Proton Docs import and
export](https://proton.me/support/drive-import-export-docs). The optional
inventory boundary follows [Proton Drive CLI](https://proton.me/support/drive-cli).
