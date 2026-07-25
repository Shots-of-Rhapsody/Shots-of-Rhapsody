import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateReviewSignoffCommitBinding } from "../lib/review-signoff.js";

function git(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		windowsHide: true,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout.trim();
}

async function repository(context) {
	const root = await mkdtemp(path.join(os.tmpdir(), "review-signoff-git-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	git(root, ["init"]);
	git(root, ["config", "user.name", "Release Test"]);
	git(root, [
		"config",
		"user.email",
		["release-test", "users.noreply.github.com"].join("@"),
	]);
	git(root, ["config", "commit.gpgSign", "false"]);
	await writeFile(path.join(root, "README.md"), "candidate\n", "utf8");
	git(root, ["add", "README.md"]);
	git(root, ["commit", "-m", "Create candidate"]);
	return root;
}

function record(reviewedCommit) {
	return {
		version: 1,
		articles: Array.from({ length: 11 }, (_, index) => ({
			slug: `work-${String(index + 1).padStart(2, "0")}`,
			reviewedCommit,
		})),
	};
}

test("release binding rejects a reviewed commit missing from the repository", async (context) => {
	const root = await repository(context);
	assert.deepEqual(
		validateReviewSignoffCommitBinding({
			record: record("f".repeat(40)),
			repoRoot: root,
		}),
		["human review reviewedCommit does not exist in this repository"],
	);
});

test("release binding rejects a reviewed commit outside release ancestry", async (context) => {
	const root = await repository(context);
	const base = git(root, ["rev-parse", "HEAD"]);
	git(root, ["checkout", "-b", "reviewed"]);
	await writeFile(path.join(root, "reviewed.txt"), "reviewed\n", "utf8");
	git(root, ["add", "reviewed.txt"]);
	git(root, ["commit", "-m", "Create reviewed branch"]);
	const reviewedCommit = git(root, ["rev-parse", "HEAD"]);
	git(root, ["checkout", "-b", "release", base]);
	await writeFile(path.join(root, "release.txt"), "release\n", "utf8");
	git(root, ["add", "release.txt"]);
	git(root, ["commit", "-m", "Create release branch"]);

	assert.deepEqual(
		validateReviewSignoffCommitBinding({
			record: record(reviewedCommit),
			repoRoot: root,
		}),
		["human review reviewedCommit is not an ancestor of the release"],
	);
});

test("release binding rejects render-critical changes after review", async (context) => {
	const root = await repository(context);
	const reviewedCommit = git(root, ["rev-parse", "HEAD"]);
	await mkdir(path.join(root, "src"));
	await mkdir(path.join(root, "public"));
	await mkdir(path.join(root, "provenance", "tai-song"), { recursive: true });
	await writeFile(path.join(root, "src", "site.txt"), "changed\n", "utf8");
	await writeFile(path.join(root, "public", "mark.svg"), "<svg />\n", "utf8");
	await writeFile(
		path.join(root, "astro.config.mjs"),
		"export default {};\n",
		"utf8",
	);
	await writeFile(path.join(root, "package.json"), "{}\n", "utf8");
	await writeFile(
		path.join(root, "pnpm-lock.yaml"),
		"lockfileVersion: '9.0'\n",
		"utf8",
	);
	await writeFile(
		path.join(root, "pagefind.yml"),
		"exclude_selectors: []\n",
		"utf8",
	);
	await writeFile(
		path.join(root, "provenance", "tai-song", "manifest.json"),
		"{}\n",
		"utf8",
	);
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "Change rendered site"]);

	assert.deepEqual(
		validateReviewSignoffCommitBinding({
			record: record(reviewedCommit),
			repoRoot: root,
		}),
		[
			"render-critical paths changed after human review: astro.config.mjs, package.json, pagefind.yml, pnpm-lock.yaml, provenance/tai-song/manifest.json, public/mark.svg, src/site.txt",
		],
	);
});

test("release binding detects a render-critical file renamed outside protected paths", async (context) => {
	const root = await repository(context);
	await mkdir(path.join(root, "src"));
	await writeFile(path.join(root, "src", "rendered.txt"), "reviewed\n", "utf8");
	git(root, ["add", "src/rendered.txt"]);
	git(root, ["commit", "-m", "Add reviewed rendering input"]);
	const reviewedCommit = git(root, ["rev-parse", "HEAD"]);
	await mkdir(path.join(root, "docs"));
	git(root, ["mv", "src/rendered.txt", "docs/rendered.txt"]);
	git(root, ["commit", "-m", "Move rendering input outside protected paths"]);

	assert.deepEqual(
		validateReviewSignoffCommitBinding({
			record: record(reviewedCommit),
			repoRoot: root,
		}),
		[
			"render-critical paths changed after human review: src/rendered.txt",
			"release paths changed after human review outside permitted evidence: docs/rendered.txt",
		],
	);
});

test("release binding rejects an unstaged rendering change", async (context) => {
	const root = await repository(context);
	await mkdir(path.join(root, "src"));
	await writeFile(path.join(root, "src", "unstaged.txt"), "reviewed\n", "utf8");
	git(root, ["add", "src/unstaged.txt"]);
	git(root, ["commit", "-m", "Add reviewed rendering input"]);
	const reviewedCommit = git(root, ["rev-parse", "HEAD"]);
	await writeFile(path.join(root, "src", "unstaged.txt"), "changed\n", "utf8");

	assert.deepEqual(
		validateReviewSignoffCommitBinding({
			record: record(reviewedCommit),
			repoRoot: root,
		}),
		[
			"working tree contains changes outside permitted review evidence: src/unstaged.txt",
		],
	);
});

test("release binding rejects a staged rendering change", async (context) => {
	const root = await repository(context);
	const reviewedCommit = git(root, ["rev-parse", "HEAD"]);
	await mkdir(path.join(root, "public"));
	await writeFile(path.join(root, "public", "staged.svg"), "<svg />\n", "utf8");
	git(root, ["add", "public/staged.svg"]);

	assert.deepEqual(
		validateReviewSignoffCommitBinding({
			record: record(reviewedCommit),
			repoRoot: root,
		}),
		[
			"working tree contains changes outside permitted review evidence: public/staged.svg",
		],
	);
});

test("release binding rejects an untracked configuration change", async (context) => {
	const root = await repository(context);
	const reviewedCommit = git(root, ["rev-parse", "HEAD"]);
	await writeFile(
		path.join(root, "astro.config.mjs"),
		"export default {};\n",
		"utf8",
	);

	assert.deepEqual(
		validateReviewSignoffCommitBinding({
			record: record(reviewedCommit),
			repoRoot: root,
		}),
		[
			"working tree contains changes outside permitted review evidence: astro.config.mjs",
		],
	);
});

test("release binding allows signoff and audit documents after review", async (context) => {
	const root = await repository(context);
	const reviewedCommit = git(root, ["rev-parse", "HEAD"]);
	await mkdir(path.join(root, "provenance", "tai-song"), { recursive: true });
	await mkdir(path.join(root, "docs"), { recursive: true });
	await writeFile(
		path.join(root, "provenance", "tai-song", "review-signoffs.json"),
		"{}\n",
		"utf8",
	);
	await writeFile(
		path.join(root, "docs", "public-release-audit.md"),
		"# Audit\n",
		"utf8",
	);
	await writeFile(
		path.join(root, "provenance", "tai-song", "review-checklist.md"),
		"# Review checklist\n",
		"utf8",
	);
	git(root, ["add", "provenance/tai-song/review-signoffs.json"]);
	git(root, ["add", "provenance/tai-song/review-checklist.md"]);
	git(root, ["add", "docs/public-release-audit.md"]);
	git(root, ["commit", "-m", "Record release evidence"]);

	assert.deepEqual(
		validateReviewSignoffCommitBinding({
			record: record(reviewedCommit),
			repoRoot: root,
		}),
		[],
	);
});

test("release binding allows uncommitted signoff and audit evidence", async (context) => {
	const root = await repository(context);
	const reviewedCommit = git(root, ["rev-parse", "HEAD"]);
	await mkdir(path.join(root, "provenance", "tai-song"), { recursive: true });
	await mkdir(path.join(root, "docs"), { recursive: true });
	await writeFile(
		path.join(root, "provenance", "tai-song", "review-signoffs.json"),
		"{}\n",
		"utf8",
	);
	await writeFile(
		path.join(root, "docs", "public-release-audit.md"),
		"# Audit\n",
		"utf8",
	);
	await writeFile(
		path.join(root, "provenance", "tai-song", "review-checklist.md"),
		"# Review checklist\n",
		"utf8",
	);

	assert.deepEqual(
		validateReviewSignoffCommitBinding({
			record: record(reviewedCommit),
			repoRoot: root,
		}),
		[],
	);
});
