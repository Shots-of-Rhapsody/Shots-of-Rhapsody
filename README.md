# Shots of Rhapsody

> Fiction, poetry, nonfiction, and audio preserved with source-level care.

Shots of Rhapsody is Tai Song's independent publication. The combined v1.0.0 release target contains 35 written works—11 fiction, poetry, and reflection pieces plus 24 nonfiction essays—and the first episode of Shots of Rhapsody Podcast.

The site presents creative work without silently editing it. Titles, subtitles, summaries, body text, paragraph order, emphasis, punctuation, Unicode, captions, and image bytes are covered by deterministic provenance checks. Automated checks do not replace the required human side-by-side review.

## Release collection

The release catalog is generated only from approved, hash-bound manifests. The original 11 works retain their sealed Proton-backed verification contract. The 24 nonfiction essays are imported from the official account export, with their exported headline and summary, authored pre-hero title and subtitle, Ledger Series sentence, body structure, and metadata-free hero derivative preserved as separate evidence. Episode 1 retains the exact approved MP3 bytes and will not publish without a reviewed transcript and episode metadata.

Four repository-only posts and the nine excluded response records remain outside production routes, feeds, archives, search, and sitemaps.

The historical player under `legacy/podcast/` is retained only as repository history and is never deployed. The release uses the browser's native audio controls and same-origin media.

## Mission

Shots of Rhapsody gives imaginative and reflective writing a durable home while keeping the author's voice intact. The project values:

- faithful preservation over editorial normalization;
- clear provenance without exposing private author-workspace data;
- accessible presentation of images, captions, and article structure;
- explicit boundaries between open-source code and copyrighted creative work;
- reviewable, reproducible publishing changes.

## Integrity workflow

The importers are local-only. Raw author exports stay under the ignored `.proton-import/` and `.medium-import/` directories; committed outputs contain sanitized provenance, deterministic writing output, and approved local assets. Podcast transcript work remains ignored under `.podcast-import/` until Tai Song approves the final transcript.

The workflow and acceptance criteria are documented in:

- [Tai Song archive import runbook](docs/tai-song-import.md)
- [Writing and nonfiction import workflow](docs/authoring-and-medium-import.md)
- [Podcast release workflow](docs/podcast-release.md)
- [Archive provenance](provenance/tai-song/README.md)
- [Human-review checklist](provenance/tai-song/review-checklist.md)

The strict release verifier reconciles 35 writing records and one podcast episode with built routes, RSS, archive data, search input, sitemap entries, metadata, structured data, article bodies, heroes, transcript, and audio bytes. Release remains blocked until all content, claim, rights, and presentation reviews are genuine and complete.

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
pnpm test:future-content
pnpm test:migration
pnpm test:release-tools
pnpm archive:verify --require-complete
pnpm medium:verify --require-complete
pnpm content:verify --require-complete
pnpm podcast:verify --require-complete
pnpm lint:ci
pnpm type-check
pnpm build
pnpm verify:site
pnpm podcast:verify --require-complete --with-built
pnpm verify:release
pnpm test:e2e
pnpm audit --json
```

`pnpm verify:site` validates the current approved publication catalog. `pnpm verify:release` is the combined publication gate: it aggregates missing Medium, podcast, catalog, claim-review, content-signoff, and presentation-signoff evidence and fails closed until the complete release is ready.

Fuwari's pinned lineage and review-only update procedure are documented in [Fuwari upstream synchronization](docs/upstream-sync.md). Upstream is fetch-only; project changes are pushed only to the Shots of Rhapsody repository.

## Hosting independence

The release workflow builds the site from a clean checkout and the frozen lockfile.
The static host receives only the generated artifact: HTML, CSS, small
browser modules, Pagefind data, responsive image derivatives, RSS, sitemap,
structured data, and the single approved episode asset. Release verification also ensures the artifact does not emit a
misleading project-path `robots.txt`. The live site needs no environment
secret, local path, local process, Proton export, Python utility, API, or
database. Once a verified artifact is deployed, the development computer can
be offline without affecting the website.

Raw author-master exports remain ignored local verification evidence. They are
required only for the optional private raw-backed comparison—not to build,
deploy, search, or serve the public site.

## Repository

- [Shots-of-Rhapsody/Shots-of-Rhapsody](https://github.com/Shots-of-Rhapsody/Shots-of-Rhapsody)
- Issues and changes should be proposed through that repository's normal review process.

## Rights and attribution

The root [MIT License](LICENSE) applies to repository software and the Fuwari-derived theme code. It does **not** license the articles, hero images, project branding, or other creative media.

Tai Song's writing, original artwork, podcast audio, and transcript are **All Rights Reserved**. Source-platform records remain non-rendered provenance only. Repository-only draft posts retain their separately documented fallback status until reviewed.

See [Content rights and licensing](CONTENT-LICENSE.md) and [Third-party notices](THIRD-PARTY-NOTICES.md) for the complete scope.
