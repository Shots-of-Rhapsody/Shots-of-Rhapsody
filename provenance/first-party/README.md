# First-party writing

This directory holds the [manifest](manifest.json) for future writing created directly for Shots of Rhapsody.

`pnpm content:new` creates an unlisted draft. Publication requires the work's Markdown and assets to be hashed in the manifest, a matching `ContentSignoffV2` completed by Tai Song, and an explicit entry in the [publication catalog](../publication-catalog.json).

## Verification rules

- `hashes.source` and `hashes.output` must both match the current Markdown bytes.
- The Markdown must contain exactly one frontmatter `draft: false` declaration.
- Every asset declares a `hero` or `body` role.
- Each work has exactly one hero, with its MIME type, dimensions, and byte size recorded for reproducible responsive and social images.
- Drafts are never published through unrestricted folder discovery.

See the [writing workflow](../../docs/authoring-and-medium-import.md) and [contribution guidance](../../CONTRIBUTING.md). Writing and media remain subject to the [content rights policy](../../CONTENT-LICENSE.md).
