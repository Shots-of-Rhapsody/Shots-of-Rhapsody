import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_REPO_ROOT } from "../medium/lib/contract.js";

const REVIEW_BRANCH = "codex/v1.0-release";
const RETIRED_REVIEW_BRANCH = "codex/v1.0-integration";
const workflow = await readFile(
	path.join(DEFAULT_REPO_ROOT, ".github", "workflows", "gh-pages.yml"),
	"utf8",
);
const buildWorkflow = await readFile(
	path.join(DEFAULT_REPO_ROOT, ".github", "workflows", "build.yml"),
	"utf8",
);
const layout = await readFile(
	path.join(DEFAULT_REPO_ROOT, "src", "layouts", "Layout.astro"),
	"utf8",
);

function occurrenceCount(source, value) {
	return source.split(value).length - 1;
}

function shellVariable(name) {
	return `\${${name}}`;
}

test("Pages review deployment pins the release branch and exact commit", () => {
	assert.doesNotMatch(workflow, new RegExp(RETIRED_REVIEW_BRANCH, "u"));
	assert.equal(
		occurrenceCount(workflow, `refs/heads/${REVIEW_BRANCH}`),
		8,
		"build, deploy, smoke, and review-tip guards must use the release branch",
	);
	assert.equal(
		occurrenceCount(workflow, `refs/remotes/origin/${REVIEW_BRANCH}`),
		6,
		"each build/deploy review-tip check must fetch and compare the release branch",
	);
	assert.match(workflow, /\^\[0-9a-fA-F\]\{40\}\$/u);
	assert.equal(
		occurrenceCount(
			workflow,
			`test "${shellVariable("GITHUB_SHA")}" = "${shellVariable("expected_sha_normalized")}"`,
		),
		2,
	);
	assert.equal(
		occurrenceCount(
			workflow,
			`test "$(git rev-parse HEAD)" = "${shellVariable("expected_sha_normalized")}"`,
		),
		3,
	);
});

test("Pages review deployment selects the exact noindex build contract", () => {
	assert.equal(
		occurrenceCount(
			workflow,
			"inputs.deployment_mode == 'review' && 'public-review' || 'release'",
		),
		2,
	);
	assert.equal(occurrenceCount(workflow, "run: pnpm verify:review"), 1);
	assert.match(
		layout,
		/<meta name="robots" content="noindex, nofollow, noarchive, nosnippet" \/>/u,
	);
});

test("release CI requires the final two-folder Proton ledger", () => {
	const command =
		"pnpm proton:verify-v2 --require-complete --require-final-cloud";
	assert.equal(occurrenceCount(buildWorkflow, command), 1);
	assert.equal(occurrenceCount(workflow, command), 1);
	assert.doesNotMatch(buildWorkflow, /run: pnpm proton:verify --/u);
	assert.doesNotMatch(workflow, /run: pnpm proton:verify --/u);
	assert.match(
		workflow,
		/- name: Verify the final two-folder Proton master ledger\r?\n\s+run: pnpm proton:verify-v2 --require-complete --require-final-cloud/u,
	);
});
