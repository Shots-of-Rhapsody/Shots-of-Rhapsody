# Public-release governance runbook

This runbook covers provider-side controls that cannot be enforced by files in
the repository. Do not perform these steps until the release candidate has
passed the archive, browser, dependency, human-signoff, and disclosure gates.

## Before changing repository visibility

1. Confirm the release candidate is the current `main` commit and the tracked
   worktree is clean.
2. Fetch every branch and tag, then run the checksum-verified Gitleaks wrapper
   and the independent repository audit:

   ```sh
   git fetch --prune --prune-tags origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
   git fetch --prune --no-tags origin '+refs/pull/*/head:refs/remotes/audit-pull-head/*' '+refs/pull/*/merge:refs/remotes/audit-pull-merge/*'
   git fetch --prune --no-tags origin '+refs/notes/*:refs/remotes/audit-notes/*'
   pnpm audit:gitleaks
   node scripts/release/audit-repository.mjs --gitleaks-report gitleaks-report.json --output <temporary-audit.json>
   ```

   The Gitleaks wrapper checksum-verifies the pinned binary, passes an explicit
   checksum-verified configuration that selects that binary's compiled default
   rules, and uses an explicit empty ignore file. It removes Gitleaks config
   environment variables and does not load repository `.gitleaks.toml` or
   `.gitleaksignore` overrides. With no arguments it writes only a sanitized,
   redacted report to the ignored repository-root `gitleaks-report.json`.
   Automation may continue to select another redacted destination with
   `--report <path>`.

3. Complete the provider-surface review in `docs/public-release-audit.md`:
   open/closed pull requests, issue and review comments, Actions logs and
   artifacts, releases, deploy keys, webhooks, and collaborator permissions.
4. Record only tool versions, checksums, commands, ref counts, accepted
   disclosures, and audited SHAs. The Gitleaks wrapper replaces its raw report
   with a minimal sanitized report before either audit workflow can upload it.
   Never copy a matched secret, identity value, commit message, unreviewed
   repository path, or private document identifier into an artifact or report.
   Paths explicitly listed as accepted public disclosures are the only path
   exception.
5. Keep the repository private if either scanner reports a blocking finding.
   Revoke or rotate credentials before any history remediation. A raw Proton
   export or real document identifier requires an explicit owner decision
   before rewriting history.
6. Review every redacted Git author, committer, tagger, commit/tag-message, and
   ref-name finding. Identity exceptions are bound to one immutable Git object
   and role. The documented Fuwari ancestry is trusted only through its pinned
   upstream commit; secret-like metadata remains blocking everywhere.
7. In an unauthenticated browser, confirm that deleted-repository and
   superseded commit URLs do not expose old private content. Repository
   recreation removed those provider refs from the current canonical
   repository; contact GitHub Support only if an old URL remains accessible.

## First public conversion

After all 11 `ReviewSignoffV1` records, 25 `ContentSignoffV2` records, the 24
nonfiction claim reviews, and the release-wide `PresentationSignoffV2` record
pass for the exact candidate:

1. Change `Shots-of-Rhapsody/Shots-of-Rhapsody` from private to public.
2. Wait for GitHub secret scanning to complete and confirm there are no open
   alerts. Enable secret push protection.
3. Enable Dependabot alerts, Dependabot security updates, and private
   vulnerability reporting.
4. Set Actions policy to the exact action repositories used by the workflows,
   require full-length SHA pinning, retain read-only default workflow-token
   permissions, and keep pull-request approval disabled for that token.
5. Create a `main-release-protection` ruleset targeting the default branch:
   - require pull requests and conversation resolution;
   - require branches to be up to date before merging;
   - block force pushes and deletion;
   - apply to administrators with no routine bypass;
   - allow merge commits and do not require linear history;
   - require zero approving reviews while there is only one eligible
     maintainer; require approval after a second reviewer is available;
   - require the unique CI checks for archive integrity, code quality,
     dependency security, build/site verification, and browser accessibility.

Record the ruleset ID, enabled features, and required check names in the final
audit report. Do not record tokens or collaborator email addresses.

## First GitHub Pages deployment

1. In organization settings, allow public Pages publication.
2. In repository **Settings → Pages**, choose **GitHub Actions**.
3. Protect the `github-pages` environment so only `main` can deploy.
4. Dispatch **Deploy Astro to GitHub Pages** from the approved `main` SHA. The
   workflow is intentionally manual and refuses to deploy any other ref.
5. Require the post-deployment job to validate the Pages output URL, wait for
   it with bounded polling, and run the same privacy, route, image,
   accessibility, and interaction suite against production. It uploads only
   deliberate privacy-reviewed screenshots after the full suite passes.
6. Independently open
   `https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/` from a device that
   is not serving the local preview and complete the production acceptance
   checklist.
7. If the production smoke passes, add the `main` push trigger in a one-purpose
   pull request. Keep `workflow_dispatch` for recovery.
8. Tag the deployed commit `v1.0.0`, publish the release notes, and submit the
   sitemap index to Google Search Console.

Browser evidence is fail-closed for privacy: Playwright's automatic traces,
videos, failure screenshots, and generated error-context snapshots are
disabled. CI uploads only deliberate screenshots captured after the rendered
page and runtime recorder pass their private-reference checks, and only when
the complete browser suite succeeds.

## Emergency rollback

- For a privacy or rights defect, disable Pages immediately, correct the source
  through a protected pull request, rerun every gate, and deploy a new artifact.
- For an ordinary code regression, revert through a protected pull request and
  redeploy. Never edit a deployed artifact directly or move the `v1.0.0` tag.

## Authoritative references

- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Secure use of GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use)
- [Repository visibility consequences](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
- [GitHub secret-scanning scope](https://docs.github.com/en/code-security/reference/secret-security/secret-scanning-scope)
- [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
