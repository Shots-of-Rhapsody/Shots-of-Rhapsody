import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectPresentationEvidence } from "../content/presentation.js";
import {
	requirePresentationTarget,
	validateCombinedReleaseSummary,
	validateReleaseTarget,
	verifyRelease,
} from "./verify-release.mjs";

const TARGET = Object.freeze({
	schemaVersion: 2,
	release: "v1.0.0",
	expected: Object.freeze({
		archiveWriting: 11,
		mediumWriting: 24,
		podcastEpisodes: 1,
	}),
});

const SITE = Object.freeze({
	htmlPages: 45,
	postPages: 35,
	rssItems: 35,
	pagefindRecords: 37,
	archiveEntries: 35,
	authorWorks: 35,
	nonfictionEntries: 24,
	podcastEpisodes: 1,
});

const AGGREGATE = Object.freeze({
	complete: true,
	publishedCount: 35,
	sources: {
		archive: { importedCount: 11, complete: true },
		medium: { importedCount: 24, complete: true },
		firstParty: { importedCount: 0, complete: true },
	},
});

const MEDIUM = Object.freeze({
	complete: true,
	expectedCount: 24,
	importedCount: 24,
});

const PODCAST = Object.freeze({
	complete: true,
	episodes: 1,
	builtArtifactsChecked: true,
});

function git(repoRoot, args) {
	const result = spawnSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		windowsHide: true,
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function commitFixture(repoRoot, message) {
	git(repoRoot, ["add", "src", "public"]);
	git(repoRoot, [
		"-c",
		"user.name=Shots of Rhapsody",
		"-c",
		"user.email=shots@noreply.invalid",
		"commit",
		"--quiet",
		"-m",
		message,
	]);
}

async function readPresentationLedger(repoRoot) {
	return JSON.parse(
		await readFile(
			path.join(
				repoRoot,
				"provenance",
				"reviews",
				"presentation-signoffs-v2.json",
			),
			"utf8",
		),
	);
}

async function writePresentationLedger(repoRoot, ledger) {
	await writeFile(
		path.join(
			repoRoot,
			"provenance",
			"reviews",
			"presentation-signoffs-v2.json",
		),
		JSON.stringify(ledger),
	);
}

async function createReleaseFixture(
	context,
	{ target = TARGET, presentationRelease = "v1.0.0" } = {},
) {
	const root = await mkdtemp(path.join(tmpdir(), "release-target-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "provenance", "reviews"), { recursive: true });
	await mkdir(path.join(root, "src"), { recursive: true });
	await mkdir(path.join(root, "public"), { recursive: true });
	await mkdir(path.join(root, "dist"), { recursive: true });
	await writeFile(path.join(root, "src", "page.ts"), "export {};\n");
	await writeFile(path.join(root, "public", "mark.svg"), "<svg></svg>\n");
	await writeFile(path.join(root, "dist", "index.html"), "<h1>Work</h1>\n");
	await writeFile(
		path.join(root, "provenance", "release-target.json"),
		JSON.stringify(target),
	);
	git(root, ["init", "--quiet"]);
	commitFixture(root, "fixture");
	const evidence = presentationRelease
		? await collectPresentationEvidence({
				repoRoot: root,
				release: presentationRelease,
			})
		: null;
	const releases = presentationRelease
		? [
				{
					...evidence,
					reviewer: "Tai Song",
					reviewedAt: "2026-07-25T00:00:00.000Z",
					responsive: "passed",
					accessibility: "passed",
				},
			]
		: [];
	await writePresentationLedger(root, { version: 2, releases });
	return root;
}

test("release target accepts only the exact combined v1.0.0 contract", () => {
	assert.deepEqual(validateReleaseTarget(TARGET), TARGET);
	for (const value of [
		{},
		{ ...TARGET, schemaVersion: 1 },
		{ ...TARGET, release: "v1.1.0" },
		{ ...TARGET, draft: true },
		{ ...TARGET, expected: { ...TARGET.expected, mediumWriting: 23 } },
		{ ...TARGET, expected: { ...TARGET.expected, podcastEpisodes: 2 } },
		{
			...TARGET,
			expected: { ...TARGET.expected, unexpectedWriting: 1 },
		},
	]) {
		assert.throws(() => validateReleaseTarget(value), /Release target/u);
	}
});

test("combined release runs every content and presentation gate", async (context) => {
	const repoRoot = await createReleaseFixture(context);
	let builtOptions;
	let aggregateOptions;
	let mediumOptions;
	let podcastOptions;
	const result = await verifyRelease({
		repoRoot,
		dependencies: {
			verifyBuiltSite: async (options) => {
				builtOptions = options;
				return SITE;
			},
			verifyAggregateContent: async (options) => {
				aggregateOptions = options;
				return AGGREGATE;
			},
			verifyMediumArticles: async (options) => {
				mediumOptions = options;
				return MEDIUM;
			},
			verifyPodcastRelease: async (options) => {
				podcastOptions = options;
				return PODCAST;
			},
		},
	});
	assert.equal(result.target, "v1.0.0");
	assert.deepEqual(result.site, SITE);
	assert.deepEqual(builtOptions, {
		repoRoot,
		requireSignoff: true,
		releaseTarget: "catalog",
	});
	assert.deepEqual(aggregateOptions, { repoRoot, requireComplete: true });
	assert.deepEqual(mediumOptions, { repoRoot, requireComplete: true });
	assert.deepEqual(podcastOptions, {
		withBuilt: true,
		release: "v1.0.0",
	});
	assert.doesNotThrow(() =>
		validateCombinedReleaseSummary({
			target: TARGET,
			site: SITE,
			aggregate: AGGREGATE,
			medium: MEDIUM,
			podcast: PODCAST,
		}),
	);
});

test("combined release rejects missing target-specific presentation approval", async (context) => {
	const repoRoot = await createReleaseFixture(context, {
		presentationRelease: "v1.1.0",
	});
	await assert.rejects(
		verifyRelease({
			repoRoot,
			dependencies: {
				verifyBuiltSite: async () => SITE,
				verifyAggregateContent: async () => AGGREGATE,
				verifyMediumArticles: async () => MEDIUM,
				verifyPodcastRelease: async () => PODCAST,
			},
		}),
		/Presentation signoff is missing for v1\.0\.0/u,
	);
});

test("combined release rejects missing or extra Medium inventory", () => {
	for (const medium of [
		{ ...MEDIUM, expectedCount: 23, importedCount: 23 },
		{ ...MEDIUM, expectedCount: 25, importedCount: 25 },
	]) {
		assert.throws(
			() =>
				validateCombinedReleaseSummary({
					target: TARGET,
					site: SITE,
					aggregate: AGGREGATE,
					medium,
					podcast: PODCAST,
				}),
			/exactly 24/u,
		);
	}
	for (const importedCount of [23, 25]) {
		assert.throws(
			() =>
				validateCombinedReleaseSummary({
					target: TARGET,
					site: SITE,
					aggregate: {
						...AGGREGATE,
						sources: {
							...AGGREGATE.sources,
							medium: { importedCount, complete: true },
						},
					},
					medium: MEDIUM,
					podcast: PODCAST,
				}),
			/Medium inventory and aggregate catalog disagree/u,
		);
	}
});

test("combined release rejects missing or extra podcast episodes", () => {
	for (const episodes of [0, 2]) {
		assert.throws(
			() =>
				validateCombinedReleaseSummary({
					target: TARGET,
					site: SITE,
					aggregate: AGGREGATE,
					medium: MEDIUM,
					podcast: { ...PODCAST, episodes },
				}),
			/exactly 1 complete podcast/u,
		);
	}
});

test("combined release rejects writing-source and public-surface drift", () => {
	for (const aggregate of [
		{ ...AGGREGATE, publishedCount: 34 },
		{ ...AGGREGATE, publishedCount: 36 },
		{
			...AGGREGATE,
			sources: {
				...AGGREGATE.sources,
				firstParty: { importedCount: 1, complete: true },
			},
		},
	]) {
		assert.throws(
			() =>
				validateCombinedReleaseSummary({
					target: TARGET,
					site: SITE,
					aggregate,
					medium: MEDIUM,
					podcast: PODCAST,
				}),
			/exact approved writing sources/u,
		);
	}
	for (const site of [
		{ ...SITE, htmlPages: 44 },
		{ ...SITE, postPages: 36 },
		{ ...SITE, rssItems: 34 },
		{ ...SITE, pagefindRecords: 38 },
		{ ...SITE, archiveEntries: 34 },
		{ ...SITE, authorWorks: 36 },
		{ ...SITE, nonfictionEntries: 23 },
		{ ...SITE, podcastEpisodes: 2 },
	]) {
		assert.throws(
			() =>
				validateCombinedReleaseSummary({
					target: TARGET,
					site,
					aggregate: AGGREGATE,
					medium: MEDIUM,
					podcast: PODCAST,
				}),
			/release surfaces disagree/u,
		);
	}
});

test("combined release summary reports every independent surface drift", () => {
	assert.throws(
		() =>
			validateCombinedReleaseSummary({
				target: TARGET,
				site: { ...SITE, postPages: 34, rssItems: 36 },
				aggregate: { ...AGGREGATE, complete: false, publishedCount: 34 },
				medium: { ...MEDIUM, complete: false, importedCount: 23 },
				podcast: { ...PODCAST, complete: false, episodes: 0 },
			}),
		(error) => {
			assert.match(
				error.message,
				/aggregate content verification is incomplete/u,
			);
			assert.match(error.message, /exactly 24 complete, approved Medium/u);
			assert.match(error.message, /exactly 1 complete podcast/u);
			assert.match(error.message, /expected 35 postPages, received 34/u);
			assert.match(error.message, /expected 35 rssItems, received 36/u);
			return true;
		},
	);
});

test("combined release runs and reports every failed gate", async (context) => {
	const repoRoot = await createReleaseFixture(context);
	const calls = [];
	await assert.rejects(
		verifyRelease({
			repoRoot,
			dependencies: {
				verifyBuiltSite: async () => {
					calls.push("site");
					throw new Error("archive review pending");
				},
				verifyAggregateContent: async () => {
					calls.push("aggregate");
					throw new Error("catalog incomplete");
				},
				verifyMediumArticles: async () => {
					calls.push("medium");
					throw new Error("Medium approvals pending");
				},
				verifyPodcastRelease: async () => {
					calls.push("podcast");
					throw new Error("podcast transcript pending");
				},
			},
		}),
		(error) => {
			assert.match(error.message, /archive review pending/u);
			assert.match(error.message, /catalog incomplete/u);
			assert.match(error.message, /Medium approvals pending/u);
			assert.match(error.message, /podcast transcript pending/u);
			return true;
		},
	);
	assert.deepEqual(calls.toSorted(), [
		"aggregate",
		"medium",
		"podcast",
		"site",
	]);
});

test("presentation target validation rejects malformed or wrong-release ledgers", async (context) => {
	const validRoot = await createReleaseFixture(context);
	const expected = await collectPresentationEvidence({
		repoRoot: validRoot,
		release: "v1.0.0",
	});
	assert.deepEqual(
		await requirePresentationTarget({
			repoRoot: validRoot,
			release: "v1.0.0",
		}),
		expected,
	);
	const wrongRoot = await createReleaseFixture(context, {
		presentationRelease: "v1.1.0",
	});
	await assert.rejects(
		requirePresentationTarget({ repoRoot: wrongRoot, release: "v1.0.0" }),
		/missing for v1\.0\.0/u,
	);
});

test("presentation target rejects stale renderer and site hashes", async (context) => {
	for (const field of ["rendererSha256", "siteSha256"]) {
		const repoRoot = await createReleaseFixture(context);
		const ledger = await readPresentationLedger(repoRoot);
		ledger.releases[0][field] = `sha256:${"f".repeat(64)}`;
		await writePresentationLedger(repoRoot, ledger);
		await assert.rejects(
			requirePresentationTarget({ repoRoot, release: "v1.0.0" }),
			new RegExp(`stale ${field}`, "u"),
		);
	}
});

test("presentation target rejects a nonexistent reviewed commit", async (context) => {
	const repoRoot = await createReleaseFixture(context);
	const ledger = await readPresentationLedger(repoRoot);
	ledger.releases[0].reviewedCommit = "f".repeat(40);
	await writePresentationLedger(repoRoot, ledger);
	await assert.rejects(
		requirePresentationTarget({ repoRoot, release: "v1.0.0" }),
		/reviewed commit does not exist/u,
	);
});

test("presentation target rejects a reviewed commit outside release ancestry", async (context) => {
	const repoRoot = await createReleaseFixture(context);
	const tree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
	const unrelatedCommit = git(repoRoot, [
		"-c",
		"user.name=Shots of Rhapsody",
		"-c",
		"user.email=shots@noreply.invalid",
		"commit-tree",
		tree,
		"-m",
		"unrelated fixture",
	]);
	const ledger = await readPresentationLedger(repoRoot);
	ledger.releases[0].reviewedCommit = unrelatedCommit;
	await writePresentationLedger(repoRoot, ledger);
	await assert.rejects(
		requirePresentationTarget({ repoRoot, release: "v1.0.0" }),
		/reviewed commit is not a release ancestor/u,
	);
});
