# Shots of Rhapsody

> Fiction, poetry, and reflection preserved with source-level care.

Shots of Rhapsody is Tai Song's independent writing archive. The first public collection contains exactly eleven articles reconstructed from the author's Proton Docs HTML exports and their original PNG hero images.

The site presents creative work without silently editing it. Titles, subtitles, summaries, body text, paragraph order, emphasis, punctuation, Unicode, captions, and image bytes are covered by deterministic provenance checks. Automated checks do not replace the required human side-by-side review.

## Published archive

The launch collection contains eleven works by Tai Song across fiction, poetry, and personal reflection. The site provides a factual [Tai Song author index](https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/authors/tai-song/) generated from the same fixed manifest that controls release verification.

Four repository-only posts remain drafts and are intentionally excluded from production routes, feeds, archives, search, and sitemaps. They are not part of the eleven-article archive.

An unreferenced legacy podcast bundle is retained under `legacy/podcast/` for repository history and intentionally excluded from Astro's content tree and every production artifact.

## Mission

Shots of Rhapsody gives imaginative and reflective writing a durable home while keeping the author's voice intact. The project values:

- faithful preservation over editorial normalization;
- clear provenance without exposing private author-workspace data;
- accessible presentation of images, captions, and article structure;
- explicit boundaries between open-source code and copyrighted creative work;
- reviewable, reproducible publishing changes.

## Integrity workflow

The archive importer is local-only. Raw creator exports stay under the ignored `.proton-import/` directory; committed outputs contain sanitized provenance, generated Markdown, and exact original image bytes.

The workflow and acceptance criteria are documented in:

- [Tai Song archive import runbook](docs/tai-song-import.md)
- [Archive provenance](provenance/tai-song/README.md)
- [Human-review checklist](provenance/tai-song/review-checklist.md)

The strict release verifier reconciles the eleven manifest entries with built routes, RSS, archive data, Pagefind search input, sitemap entries, metadata, JSON-LD, article bodies, and hero images. Release remains blocked until all eleven structured human-review signoffs are complete.

## Development

The project uses Astro's static output and retains the reviewed Fuwari Git
lineage, while the public interface is a project-specific Song-literati reading
system. It uses one self-hosted Latin Noto Serif family, native browser
controls, responsive Astro images, and Pagefind's static search index. There is
no client framework, CMS, database, analytics service, or application server.

Use Node.js 24 and the pinned package manager and lockfile:

```shell
pnpm install --frozen-lockfile
pnpm test:archive
pnpm archive:verify --require-complete
pnpm lint:ci
pnpm type-check
pnpm build
pnpm verify:site
pnpm verify:release
pnpm test:e2e
```

`pnpm verify:site` validates the complete built archive while permitting the exact empty human-review template and reporting it as pending. `pnpm verify:release` is the publication gate: it fails closed until all eleven structured human-review signoffs are genuine and complete.

Fuwari's pinned lineage and review-only update procedure are documented in [Fuwari upstream synchronization](docs/upstream-sync.md). Upstream is fetch-only; project changes are pushed only to the Shots of Rhapsody repository.

## Hosting independence

GitHub Actions builds the site from a clean checkout and the frozen lockfile.
GitHub Pages receives only the generated static artifact: HTML, CSS, small
browser modules, Pagefind data, responsive image derivatives, RSS, sitemap,
robots policy, and JSON-LD. The live site needs no environment secret, local
path, local process, Proton export, Python utility, API, or database. Once a
verified artifact is deployed, the development computer can be offline without
affecting the website.

Raw author-master exports remain ignored local verification evidence. They are
required only for the optional private raw-backed comparison—not to build,
deploy, search, or serve the public site.

## Repository

- [Shots-of-Rhapsody/Shots-of-Rhapsody](https://github.com/Shots-of-Rhapsody/Shots-of-Rhapsody)
- Issues and changes should be proposed through that repository's normal review process.

## Rights and attribution

The root [MIT License](LICENSE) applies to repository software and the Fuwari-derived theme code. It does **not** license the articles, hero images, project branding, or other creative media.

The eleven imported Tai Song articles and their author-controlled hero images are **All Rights Reserved**. Historical Vocal links record publication history only. Repository-only draft posts retain their separately documented fallback status until reviewed.

See [Content rights and licensing](CONTENT-LICENSE.md) and [Third-party notices](THIRD-PARTY-NOTICES.md) for the complete scope.
