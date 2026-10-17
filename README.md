# Shots of Rhapsody

Shots of Rhapsody is Tai Song's independent publication for fiction, poetry, reflection, nonfiction, and audio. This repository contains its website, creative work, and tools for preserving the author's writing and images through publication.

## What is here

The current publication catalog contains 35 written works: 11 fiction, poetry, and reflection pieces, and 24 nonfiction essays. The [release target](provenance/release-target.json) includes zero published podcast episodes. Episode 1 is retained as a draft for a future, separately approved release.

The Astro website provides article pages, archives, author information, static search, RSS, and responsive images. It builds a self-contained static site for GitHub Pages. Podcast pages and audio verification tools are also implemented, with publication controlled by explicit approvals.

## Get started

Use Node.js 24 and the pinned pnpm version in [package.json](package.json).

```sh
pnpm install --frozen-lockfile
pnpm dev
```

To check and build the site:

```sh
pnpm lint:ci
pnpm type-check
pnpm build
pnpm verify:site
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete test sequence and [release governance](docs/release-governance.md) for publication requirements. Development checks and a successful build do not replace release approval.

## Preserve the work

Article text, presentation, and images are verified against approved author masters. Imported writing must be changed through the author's reviewed source-update process; do not hand-edit imported text, provenance, or approved images.

Proton Docs is the current authoring source. Historical source-platform records establish provenance, while automated verification and genuine human review remain separate requirements. Keep raw exports, private document identifiers, account data, and credentials out of Git and deployment artifacts.

The publication catalog controls what readers can see. Drafts and excluded records stay out of public routes, feeds, archives, search, and sitemaps. Podcast metadata, artwork, rights, and content require their own approval; a transcript is optional and requires review if published.

## Repository guide

- [`src/content/`](src/content/): writing, drafts, and podcast metadata
- [`src/pages/`](src/pages/) and [`src/components/`](src/components/): website presentation
- [`provenance/`](provenance/): publication catalog, source records, and review evidence
- [`scripts/`](scripts/): import, integrity, media, and release checks
- [`tests/`](tests/): browser and accessibility tests
- [Writing workflow](docs/authoring-and-medium-import.md), [archive import](docs/tai-song-import.md), and [podcast release](docs/podcast-release.md): detailed contribution paths

Open an [issue](https://github.com/Shots-of-Rhapsody/Shots-of-Rhapsody/issues) before major changes. The site retains its [Fuwari](https://github.com/saicaca/fuwari) code lineage; upstream updates follow the [reviewed synchronization process](docs/upstream-sync.md).

## Rights and attribution

The [MIT License](LICENSE) covers repository software and Fuwari-derived code. The 35 catalog-controlled written works, their approved hero images, and podcast media are **All Rights Reserved**. Other material follows the content rights policy, including the existing CC BY-NC-SA 4.0 fallback for repository-only drafts lacking a specific per-post license.

See [Content rights and licensing](CONTENT-LICENSE.md) and [Third-party notices](THIRD-PARTY-NOTICES.md) before reusing material.
