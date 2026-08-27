# Proton author-master evidence

`master-ledger.v1.json` is immutable historical evidence for the first verified
35-document round trip. The current two-folder contract is V2: exactly 11
native Docs in `Blogging/Fiction` and 24 native Docs in
`Blogging/Non-Fiction`, bound to timestamped HTML exports under the ignored
`.proton-import/raw/fiction/` and `.proton-import/raw/nonfiction/` roots.

The committed V2 ledger is created only after all 35 current Docs exports pass
semantic and image verification and a final cloud inventory confirms every
Windows-safe name. It contains only exact titles, public slugs, timestamps,
counts, and cryptographic hashes. No account identifier, cloud object ID,
private URL, raw HTML, or machine path may enter committed evidence.

Raw HTML exports, normalized capture input, cloud identifiers, account details,
and machine paths remain in the ignored local import area. The ledger does not
approve content or modify an article. Regeneration is intentionally
no-overwrite: remove an obsolete ledger only after preserving its history and
explicitly approving a new author revision.

The sealed V1 Fiction and Medium round-trip exports predate this unified
contract and remain ignored historical evidence until V2 verifies 35/35. They
are not current authoring locations, deployment inputs, or permitted fallbacks
for fresh exports. New evidence uses only the canonical timestamped V2 paths.

Cloud inventory may be reconciled read-only with the official Proton Drive CLI
0.6.0 from [Proton's documented download page](https://proton.me/support/drive-cli).
The installed Windows archive was verified before extraction against Proton's
published SHA-512 value
`a7cefbac439b2f54178fcd3c18fbdfc32e150a2e35bfe8f5d3a714fd157e509c59307db09ae71c164bbc8174439acda2bd5fb3fe84c4f1ad4977d1e7fb9fb904`.
The CLI is not a native Docs exporter or runtime dependency. Authenticate in a
browser only for an explicit inventory run and use the repository's fixed,
read-only capture command. Raw CLI output is never committed because it
contains private cloud identifiers. Native Docs content is acquired only with
Proton Docs' supported HTML download interface.

Historical V1 verification remains available:

```text
pnpm proton:inventory --expected
pnpm proton:inventory
pnpm proton:record
pnpm proton:verify --require-complete
pnpm proton:verify --with-raw --require-complete
```

The current V2 workflow is:

```text
pnpm proton:cloud-capture --cli <absolute-verified-cli-path> --output .proton-import/cloud-inventory.<timestamp>.v1.json
pnpm proton:cloud-verify --capture .proton-import/cloud-inventory.<timestamp>.v1.json --require-complete
pnpm proton:capture-finalize --cloud .proton-import/cloud-inventory.<final-timestamp>.v1.json
pnpm proton:record-v2 --capture .proton-import/capture.v2.json --cloud .proton-import/cloud-inventory.<final-timestamp>.v1.json
pnpm proton:verify-v2 --with-raw --with-cloud --require-complete --require-final-cloud --capture .proton-import/capture.v2.json --cloud .proton-import/cloud-inventory.<final-timestamp>.v1.json
```

Every Fiction record also binds its separately saved original PNG;
Non-Fiction exports embed the hero evidence in their supported HTML package and
therefore omit a separate hero file. Automated commands prepare and verify
evidence but never create human approvals.
