# Author-master evidence

The [V2 master ledger](master-ledger.v2.json) records the current 35-work author-master contract: 11 fiction, poetry, and reflection works, and 24 nonfiction essays. The [V1 ledger](master-ledger.v1.json) is preserved as historical evidence.

Supported Proton Docs HTML exports establish content fidelity. The ledger binds exact titles, public slugs, export timestamps, counts, and cryptographic hashes to committed writing and approved images.

## Verification boundaries

- Every current export must pass semantic and image verification, and the final document inventory must match the expected names.
- Fiction records also bind the separately saved original PNG. Nonfiction exports carry hero evidence within their HTML package.
- Historical exports remain historical evidence; they cannot substitute for a fresh current master.
- Raw HTML, capture input, cloud identifiers, private URLs, account details, and absolute file paths remain excluded from Git and deployment artifacts.
- Recording or verifying evidence never approves content or changes an article. Preserve previous ledger history and require an approved author revision before regeneration.

The optional official Proton Drive CLI supports read-only document-name inventory. It does not export native Docs content and is not a website dependency. Use supported Proton Docs HTML downloads for content acquisition, and verify the CLI distribution before use.

## Contribute

Follow the [writing workflow](../../docs/authoring-and-medium-import.md) for current V2 capture, verification, and revision commands, or the [archive import guide](../../docs/tai-song-import.md) for the original 11-work collection.

For committed-evidence verification:

```sh
pnpm proton:verify-v2 --require-complete --require-final-cloud
```

Raw-backed and cloud-backed comparisons require the additional evidence and exact command options described in those guides. Human source-fidelity, rights, and presentation reviews remain separate publication requirements.
