# Shots of Rhapsody public-release disclosure audit

Status: **Public review deployed; final release not yet approved**

The current Pages artifact is a globally `noindex` review build. This report is
intentionally incomplete until the exact release-candidate
commit has passed every automated gate and Tai Song has completed all 11
`ReviewSignoffV1` records, all 25 `ContentSignoffV2` records, the podcast
publication review, and the release-wide
`PresentationSignoffV2` record. Keeping this document in a pending state
prevents a planning or tool run from being mistaken for release approval.

## Required final evidence

- Release commit and tree SHA: pending
- Gitleaks version, release checksum, embedded `useDefault` configuration
  checksum, and command: pending. The wrapper passes an explicit temporary
  configuration and empty ignore file, so repository and environment
  overrides cannot weaken the scan.
- Independent repository-audit command and policy checksum: pending
- Refs, commits, and blobs scanned: pending
- GitHub pull requests, issues, reviews, Actions logs/artifacts, releases,
  deploy keys, webhooks, and collaborator permissions reviewed: pending
- GitHub automatic secret-scanning result for the exact release commit: pending
- Manual WCAG 2.2 keyboard and contrast review on desktop and mobile,
  including visible focus, logical tab order, menus, search, and both themes:
  pending

## Private identity-rewrite evidence

The approved project-history rewrite is complete, but it is not public-release
approval:

- An immutable private mirror of every pre-rewrite branch, tag, and ref is
  retained as recovery evidence and passed strict object-integrity checks.
- The rewrite mapped 90 project commits. Every mapped commit retained its file
  tree, mapped parent topology, and author/committer timestamps.
- All 337 commits in the reviewed Fuwari ancestry remained byte-identical.
  The imported baseline `415fb97054e57bb85da86e2ca4ea4a1ae7266219`
  and reviewed upstream tip `6d39b0dec41282e7852e23e032998a5789abee28`
  remain exact.
- Rewriting project commit metadata necessarily invalidated 31 existing GitHub
  commit signatures. No replacement attestations were fabricated.
- The maintained remote heads were reduced to `main` and the current release
  branch. Obsolete identity-bearing branches and tags are not maintained.
- The independent repository audit reported zero blocking and zero review
  findings against the sanitized refs.

The sanitized repository was recreated under the canonical owner and name, so
the superseded provider-side pull-request refs are not part of the current
repository. Final indexable release remains blocked until an unauthenticated check
confirms that deleted-repository and superseded commit URLs expose no old
private material, and until every writing, podcast, rights, and
presentation approval is complete against the final release candidate. GitHub
Support is a fallback only if an old URL still exposes deleted private data. If
a public privacy defect appears, disable Pages immediately and keep the release
blocked until remediation and a fresh disclosure audit pass.

## Accepted disclosures

The repository owner has accepted public disclosure of these materials after
the final privacy and credential audit passes:

- the Fuwari-derived Git history and merged pull requests;
- the four unpublished draft-post source files and their legacy history;
- prior GitHub Actions logs;
- author-controlled imported article snapshots and approved hero images;
- the exact 57,831,360-byte Episode 1 MP3, intended for the verified public
  episode route after metadata, rights, content, and presentation approval.

Acceptance of disclosure is not a content license. Tai Song's 35 written works,
their approved images, podcast audio, artwork, and any published transcript
remain All Rights Reserved.

## Fail-closed outcomes

- Any credential finding blocks publication until the credential is revoked or
  rotated and the exact release candidate is rescanned.
- Any raw Proton export or real Proton document identifier keeps the repository
  private and requires an explicit history-remediation decision.
- Review-only findings, including email-address locations, must be classified
  as public project data or removed before this report can be marked passed.
- Project-owned commits must use an approved public project or GitHub-generated
  identity. Personal mail domains and project `Signed-off-by` trailers are
  blocking findings. The reviewed Fuwari ancestry is exempt only through its
  exact pinned tip; secret and private-data rules still apply to every commit.
- Routine pull-request CI enforces that identity policy for commits reachable
  from the candidate `HEAD`. The final disclosure workflow separately fetches
  and audits every provider branch, tag, note, and pull-request ref.
- Commit-message identity exceptions must be exact-object scoped; no global
  message-email exception is permitted, and an exception cannot permit a
  project `Signed-off-by` trailer.

The final completed report will record tool versions, commands, checksums,
audited refs, accepted disclosures, and the audited tree SHA without including
secret values or private identifiers.
