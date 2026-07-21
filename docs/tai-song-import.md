# Tai Song author-master archive import

This runbook imports the fixed 11-article Tai Song archive from the author's Proton Docs masters. The importer is local-only: it does not log in to, request, or scrape Proton or Vocal. Proton Docs HTML exports are authoritative for article text, inline bold and italic marks, empty paragraphs, subtitle, hero placement, caption, and nullable image alt text. The fixed inventory supplies publication dates, summaries, communities, and historical public Vocal links.

Private Proton document URLs, document identifiers, account data, and editor configuration must never be committed. Raw exports remain under the ignored `.proton-import/` directory.

## Export one author master

1. Sign in at [Proton Docs](https://docs.proton.me/u/1/recents) and open the intended document.
2. Confirm the title and that the editor contains the final article and hero image.
3. Open the document-title menu, choose **Download**, then choose **Web page (.html)**.
4. Do not edit, re-save, prettify, or normalize the downloaded HTML.
5. Place it at `.proton-import/raw/<slug>/page.html`.
6. Resolve the export's sole hero reference to the originally uploaded PNG and save its response bytes as `.proton-import/raw/<slug>/hero-original.png`. For the observed Cloudinary URLs, validate the exact `res.cloudinary.com/jerrick/image/upload/<transformation>/<public-id>.png` shape and remove only the transformation component; Cloudinary documents that a delivery URL without transformations returns the originally uploaded asset. Do not guess at another path. See [Cloudinary image delivery](https://cloudinary.com/documentation/image_delivery_options) and [transformation URL rules](https://cloudinary.com/documentation/cloudinary_transformation_rules).
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
pnpm archive:verify -- --slug <slug> --with-raw
pnpm check
pnpm build
pnpm verify:site
```

The write creates or updates only:

```text
provenance/tai-song/posts/<slug>.json
provenance/tai-song/manifest.json
src/content/posts/<slug>/index.md
src/content/posts/<slug>/hero-original.png
```

The snapshot contains the sanitized document model and hashes, not private Proton references. The generated Markdown uses explicit HTML paragraphs so text, empty paragraphs, inline breaks, Unicode, and observed bold/italic boundaries survive Markdown parsing.

## Reviewed source updates

If an already imported master has intentionally changed, first inspect the dry-run. Then use `--write --update` with a new capture time. The updater refuses to replace a managed output if its current hash no longer matches the manifest, preventing an unnoticed overwrite of local edits.

## Complete-archive gate

After all 11 articles have been imported, run:

```sh
pnpm test:archive
pnpm archive:verify -- --with-raw --require-complete
pnpm lint:ci
pnpm check
pnpm build
pnpm verify:site
```

The complete verifier requires all 11 fixed slugs, unique historical publication URLs, exact body structure and hashes, exact PNG bytes and metadata, and matching generated outputs. It does not claim the former Vocal word-count total because Proton Docs author masters are now the text authority.

## Human review

Compare every built article side-by-side with its Proton author master and record the result in [`provenance/tai-song/review-checklist.md`](../provenance/tai-song/review-checklist.md). Check title, subtitle, summary, full uncropped hero, caption, paragraph order, empty paragraphs, line breaks, emphasis, punctuation, Unicode, and ending text.

Do not call the archive complete until the strict verifier passes and all 11 human-review rows are signed off. Never commit `.proton-import/`.
