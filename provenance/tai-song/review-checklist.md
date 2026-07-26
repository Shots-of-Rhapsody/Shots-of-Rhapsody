# Tai Song archive human review

An automated verification pass is necessary but not sufficient. For each article, compare the locally built page with the Proton Docs author master and enter the reviewer, canonical UTC review time, and notes in [`review-signoffs.json`](review-signoffs.json), following [`review-signoffs.schema.json`](review-signoffs.schema.json). Check all text and presentation fields listed in the runbook.

The structured record currently remains `pending`. Do not add a reviewer identity or passed decision unless a human actually performed the side-by-side comparison. `pnpm verify:site` reports the exact empty template as pending while still checking the built archive; `pnpm verify:release` fails closed until all eleven manifest-bound signoffs are genuine and complete.

All records bind to one frozen candidate commit. A changed source hash identifies the exact article whose evidence is stale; separately, any post-review rendering or release-file change invalidates the frozen presentation candidate for all eleven works. Only the structured signoff and redacted audit evidence may change afterward. Rebuild and review a new clean candidate rather than carrying presentation approval across code or content changes.

Automated integrity was verified for all 11 articles with the ignored raw author-master bundles present by running `pnpm archive:verify --with-raw --require-complete`.

| Order | Article | Automated integrity | Human visual/text review | Reviewer | Reviewed at (UTC) | Notes |
|---:|---|---|---|---|---|---|
| 1 | The Seventh Skin | Passed | Pending |  |  |  |
| 2 | Poetic Biography | Passed | Pending |  |  |  |
| 3 | The Guild: A Chronicle of Pretty Souls | Passed | Pending |  |  |  |
| 4 | Cold Children | Passed | Pending |  |  |  |
| 5 | Lanterns for the Unreturning | Passed | Pending |  |  |  |
| 6 | The Khan Who Chose the Grain | Passed | Pending |  |  |  |
| 7 | Eggasaurus Rex | Passed | Pending |  |  |  |
| 8 | Where We Last Were Us | Passed | Pending |  |  |  |
| 9 | Before the Sky Went Quiet: Part I - The Girl Who Faded | Passed | Pending |  |  |  |
| 10 | Before the Sky Went Quiet: Part II - The Goodbye | Passed | Pending |  |  |  |
| 11 | Before the Sky Went Quiet: Part III - The Echo That Stayed | Passed | Pending |  |  |  |
