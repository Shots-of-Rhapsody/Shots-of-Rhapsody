# Contributing

Thank you for helping improve Shots of Rhapsody. Contributions to the site's
code, accessibility, documentation, and design are welcome under the
repository's MIT license. Tai Song's articles and original hero images remain
All Rights Reserved; public access to the repository does not grant permission
to rewrite or reuse them.

## Before You Start

Open an issue before starting a major feature, design change, dependency
addition, or content-model change. Keep pull requests focused on one purpose
and preserve the existing code/content licensing boundary.

Never hand-edit an imported article, its source metadata, provenance snapshot,
or approved hero image. A writing correction must be approved by the author,
applied to the private source master, and regenerated through the reviewed
import path. The resulting hash mismatch identifies the exact work whose
evidence changed. Shared presentation changes require a new frozen candidate
and a fresh release-wide presentation review.

## Submitting Code

Use a `codex/` or other descriptive topic branch and keep generated or local
files out of the change. Do not commit raw Proton exports, credentials, private
document identifiers, build output, browser traces, or absolute local paths.

Use [Conventional Commits](https://www.conventionalcommits.org/) when practical.
For visible changes, include privacy-reviewed screenshots covering the
relevant desktop/mobile and light/dark states.

Run the applicable non-writing release checks before submitting a pull request:

```bash
pnpm install --frozen-lockfile
pnpm test:archive
pnpm test:future-content
pnpm archive:verify --require-complete
pnpm medium:verify --require-complete
pnpm content:verify --require-complete
pnpm podcast:verify --require-complete
pnpm test:migration
pnpm test:release-tools
pnpm lint:ci
pnpm type-check
pnpm build
pnpm verify:site
pnpm podcast:verify --require-complete --with-built
pnpm test:e2e
pnpm audit --json
git diff --check
```

`pnpm verify:release` is reserved for a frozen publication candidate with all
genuine, hash-bound content, claim, rights, and presentation signoffs. It must
not be bypassed or satisfied with generated reviewer data. Formatting commands
write files; run them only when intentional and confirm that imported content
remains unchanged.
