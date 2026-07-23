# Shots of Rhapsody public-release disclosure audit

Status: **Not yet approved for public release**

This report is intentionally incomplete until the exact release-candidate
commit has passed every automated gate and Tai Song has signed all 11 review
records. Keeping this document in a pending state prevents a planning or tool
run from being mistaken for release approval.

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
- GitHub automatic secret-scanning result after public conversion: pending
- Manual WCAG 2.2 keyboard and contrast review on desktop and mobile,
  including visible focus, logical tab order, menus, search, and both themes:
  pending

## Accepted disclosures

The repository owner has accepted public disclosure of these materials after
the final privacy and credential audit passes:

- the Fuwari-derived Git history and merged pull requests;
- the four unpublished draft-post source files and their legacy history;
- prior GitHub Actions logs;
- author-controlled imported article snapshots and original hero images;
- the tracked 57,831,360-byte legacy podcast MP3, which remains excluded from
  the built website.

Acceptance of disclosure is not a content license. Tai Song's 11 articles and
their original hero images remain All Rights Reserved.

## Fail-closed outcomes

- Any credential finding blocks publication until the credential is revoked or
  rotated and the exact release candidate is rescanned.
- Any raw Proton export or real Proton document identifier keeps the repository
  private and requires an explicit history-remediation decision.
- Review-only findings, including email-address locations, must be classified
  as public project data or removed before this report can be marked passed.
- The current preliminary metadata scan has 138 redacted owner-review
  findings. One unapproved project name appears in 118 author/committer roles
  across 63 commits; its associated email metadata is GitHub noreply. A
  separate non-GitHub-noreply `Signed-off-by` identity appears in 20 commit
  messages. Both values are deliberately omitted. Public disclosure or history
  remediation requires explicit owner decisions. Commit-message identity
  exceptions must be exact-object scoped; no global message-email exception is
  permitted.

The final completed report will record tool versions, commands, checksums,
audited refs, accepted disclosures, and the audited tree SHA without including
secret values or private identifiers.
