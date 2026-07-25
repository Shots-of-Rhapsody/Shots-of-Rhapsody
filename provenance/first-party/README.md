# First-party writing manifest

This manifest is the approval boundary for future writing created directly for
Shots of Rhapsody. `pnpm content:new` creates an unlisted draft, never a public
entry. A work may join `provenance/publication-catalog.json` only after its
Markdown and assets are hashed here and a matching `ContentSignoffV2` record is
completed by Tai Song.

For directly authored writing, both `hashes.source` and `hashes.output` must
equal the current Markdown bytes; verification also requires exactly one
frontmatter `draft: false` declaration. This prevents a placeholder draft or a
detached claimed source digest from entering the publication catalog.
Every asset declares `role: "hero"` or `role: "body"`, and each work has
exactly one hero plus its MIME type, dimensions, and byte size so responsive
and social derivatives are deterministic.

The live site never discovers drafts through a broad content glob.
