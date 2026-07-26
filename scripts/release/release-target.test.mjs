import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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

async function createReleaseFixture(
	context,
	{ target = TARGET, presentationRelease = "v1.0.0" } = {},
) {
	const root = await mkdtemp(path.join(tmpdir(), "release-target-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "provenance", "reviews"), { recursive: true });
	await writeFile(
		path.join(root, "provenance", "release-target.json"),
		JSON.stringify(target),
	);
	const releases = presentationRelease
		? [
				{
					release: presentationRelease,
					reviewedCommit: "a".repeat(40),
					rendererSha256: `sha256:${"b".repeat(64)}`,
					siteSha256: `sha256:${"c".repeat(64)}`,
					reviewer: "Tai Song",
					reviewedAt: "2026-07-25T00:00:00.000Z",
					responsive: "passed",
					accessibility: "passed",
				},
			]
		: [];
	await writeFile(
		path.join(root, "provenance", "reviews", "presentation-signoffs-v2.json"),
		JSON.stringify({ version: 2, releases }),
	);
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

test("presentation target validation rejects malformed or wrong-release ledgers", async (context) => {
	const validRoot = await createReleaseFixture(context);
	await assert.doesNotReject(
		requirePresentationTarget({ repoRoot: validRoot, release: "v1.0.0" }),
	);
	const wrongRoot = await createReleaseFixture(context, {
		presentationRelease: "v1.1.0",
	});
	await assert.rejects(
		requirePresentationTarget({ repoRoot: wrongRoot, release: "v1.0.0" }),
		/missing for v1\.0\.0/u,
	);
});
