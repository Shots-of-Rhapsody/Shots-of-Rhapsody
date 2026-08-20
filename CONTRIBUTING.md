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

Work only from the canonical checkout; do not use or recreate duplicate or
retired checkouts.
Published writing is physically divided between
`src/content/posts/fiction/<slug>/` and
`src/content/posts/nonfiction/<slug>/`. Fiction, poetry, and reflection use the
first folder; nonfiction uses the second. Drafts are created under the matching
`src/content/drafts/` folder. Those storage folders never become part of the
public address: an approved work keeps `/posts/<slug>/` throughout moves or
source revisions.

Proton Docs is the authoring master. The supported change path is Proton Docs
HTML export, deterministic local verification, a reviewed Git pull request,
GitHub Actions, and GitHub Pages. Do not reconstruct a current master from a
public page, the sealed historical Medium export, or a desktop `.protondoc`
placeholder. The optional Proton Drive CLI may list cloud names read-only for
inventory reconciliation; it must not export or modify content and is never a
build or runtime dependency.

When running repository scripts with pnpm 11, pass script options directly,
including an explicit timestamped `--capture` value for cloud verification. Do
not insert an extra literal `--`. Each Proton cloud observation uses a new
timestamped ignored output; after final-name verification, the selected capture
is finalized with `proton:capture-finalize` and bound through
`proton:record-v2`. Finalization scans only the canonical `raw/fiction` and
`raw/nonfiction` timestamp trees, rejects unreferenced files, creates no
approvals, and never overwrites existing capture evidence. Never overwrite an
earlier observation or create V2 evidence before fresh supported HTML exports
exist.

## Submitting Code

Use a `codex/` or other descriptive topic branch and keep generated or local
files out of the change. Do not commit raw Proton exports, credentials, private
document identifiers, cloud-inventory output, build output, browser traces, or
absolute local paths.

Use [Conventional Commits](https://www.conventionalcommits.org/) when practical.
For visible changes, include privacy-reviewed screenshots covering the
relevant desktop/mobile and light/dark states.

Run the applicable non-writing release checks before submitting a pull request:

```bash
pnpm install --frozen-lockfile
pnpm test:archive
pnpm test:future-content
pnpm archive:verify --require-complete
pnpm proton:verify-v2 --require-complete --require-final-cloud
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
