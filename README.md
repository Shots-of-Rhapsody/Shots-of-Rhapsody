# Shots of Rhapsody

> Fiction, poetry, nonfiction, and audio preserved with source-level care.

Shots of Rhapsody is Tai Song's independent publication. The combined v1.0.0 release target contains 35 written works—11 fiction, poetry, and reflection pieces plus 24 nonfiction essays—and the first episode of Shots of Rhapsody Podcast.

The site presents creative work without silently editing it. Titles, subtitles, summaries, body text, paragraph order, emphasis, punctuation, Unicode, captions, and image bytes are covered by deterministic provenance checks. Automated checks do not replace the required human side-by-side review.

## Release collection

The release catalog is generated only from approved, hash-bound manifests. The original 11 works retain their sealed Proton-backed verification contract. The 24 nonfiction essays retain their sealed historical account-export evidence while their reconciled Proton Docs are the current authoring masters. Their exported headline and summary, authored pre-hero title and subtitle, Ledger Series sentence, body structure, and metadata-free hero derivative remain separately verifiable. The historical account export is not a fallback source for a missing or changed Proton master. Episode 1 retains the exact approved MP3 bytes and will not publish without approved episode metadata, artwork, rights, and content signoff. A transcript is optional for this release and is published only if separately reviewed.

Four repository-only posts and the nine excluded response records remain outside production routes, feeds, archives, search, and sitemaps.

## Mission

Shots of Rhapsody gives imaginative and reflective writing a durable home while keeping the author's voice intact. The project values:

- faithful preservation over editorial normalization;
- clear provenance without exposing private author-workspace data;
- accessible presentation of images, captions, and article structure;
- explicit boundaries between open-source code and copyrighted creative work;
- reviewable, reproducible publishing changes.

## Integrity workflow

The publication path is one-way and review-gated:

```text
Proton Docs -> supported HTML export -> deterministic verification -> reviewed Git pull request -> GitHub Actions -> GitHub Pages
```

The canonical Proton layout is `Blogging/Fiction` for the 11 fiction, poetry,
and reflection masters and `Blogging/Non-Fiction` for the 24 nonfiction
masters. The repository mirrors that boundary physically at
`src/content/posts/fiction/<slug>/` and
`src/content/posts/nonfiction/<slug>/`. Physical storage never changes the
stable public URL, which remains `/posts/<slug>/`.

Importers and verification tools run only from the canonical checkout. Do not
use or recreate duplicate or retired checkouts. Raw author exports stay under
the ignored
`.proton-import/` directory; the sealed `.medium-import/` material is retained
only as historical acquisition evidence. Committed outputs contain sanitized
provenance, deterministic writing output, and approved local assets. Raw HTML,
cloud identifiers, account data, private document URLs, and absolute machine
paths are never committed or deployed. Any future podcast transcript work
remains ignored under `.podcast-import/` until Tai Song approves it.

The optional official Proton Drive CLI is limited to authenticated, read-only
cloud-name inventory. It is not a Docs content exporter, synchronizer, build
tool, or live-site dependency. Article content enters the workflow only through
Proton Docs' supported HTML export.

The workflow and acceptance criteria are documented in:

- [Tai Song archive import runbook](docs/tai-song-import.md)
- [Writing and nonfiction import workflow](docs/authoring-and-medium-import.md)
- [Podcast release workflow](docs/podcast-release.md)
- [Archive provenance](provenance/tai-song/README.md)
- [Human-review checklist](provenance/tai-song/review-checklist.md)

The strict release verifier reconciles 35 writing records and zero published podcast episodes with built routes, RSS, archive data, search input, sitemap entries, metadata, structured data, article bodies, and heroes. It also proves that the retained podcast draft has no public route, cover, or audio artifact. Writing accuracy means exact reproduction from the approved author master. Independent nonfiction claim research remains optional internal work and is not a publication gate. The writing release remains blocked until all required source-fidelity, rights, and presentation approvals are genuine and complete; a future podcast release separately reactivates every podcast metadata, artwork, content, and deployment gate.

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
pnpm proton:verify-v2 --require-complete --require-final-cloud
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

`pnpm verify:site` validates the current approved publication catalog. `pnpm verify:release` is the combined publication gate: it aggregates missing Medium, podcast, catalog, content-signoff, and presentation-signoff evidence and fails closed until the complete release is ready.

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

Raw author-master exports and the optional read-only cloud inventory remain
ignored local verification evidence. They are required only for the private
raw-backed comparison—not to build, deploy, search, or serve the public site.

## Repository

- [Shots-of-Rhapsody/Shots-of-Rhapsody](https://github.com/Shots-of-Rhapsody/Shots-of-Rhapsody)
- Issues and changes should be proposed through that repository's normal review process.

## Rights and attribution

The root [MIT License](LICENSE) applies to repository software and the Fuwari-derived theme code. It does **not** license the articles, hero images, project branding, or other creative media.

Tai Song's writing, original artwork, podcast audio, and any published transcript are **All Rights Reserved**. Source-platform records remain non-rendered provenance only. Repository-only drafts remain outside the publication catalog until separately reviewed.

See [Content rights and licensing](CONTENT-LICENSE.md) and [Third-party notices](THIRD-PARTY-NOTICES.md) for the complete scope.
