import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	requirePresentationTarget,
	validateReleaseTarget,
	validateV1SiteSummary,
	validateV11ReleaseSummary,
	verifyRelease,
} from "./verify-release.mjs";

const V1_SITE = Object.freeze({
	htmlPages: 17,
	postPages: 11,
	rssItems: 11,
	pagefindRecords: 11,
	archiveEntries: 11,
	authorWorks: 11,
	nonfictionEntries: 0,
	podcastEpisodes: 0,
});

const V11_SITE = Object.freeze({
	htmlPages: 22,
	postPages: 12,
	rssItems: 12,
	pagefindRecords: 14,
	archiveEntries: 12,
	authorWorks: 12,
	nonfictionEntries: 1,
	podcastEpisodes: 1,
});

const V11_AGGREGATE = Object.freeze({
	complete: true,
	publishedCount: 12,
	sources: {
		archive: { importedCount: 11, complete: true },
		medium: { importedCount: 1, complete: true },
		firstParty: { importedCount: 0, complete: true },
	},
});

const V11_MEDIUM = Object.freeze({
	complete: true,
	expectedCount: 1,
	importedCount: 1,
});

const V11_PODCAST = Object.freeze({
	complete: true,
	episodes: 1,
	builtArtifactsChecked: true,
});

async function createReleaseFixture(context, release, presentationRelease) {
	const root = await mkdtemp(path.join(tmpdir(), "release-target-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "provenance", "reviews"), { recursive: true });
	await writeFile(
		path.join(root, "provenance", "release-target.json"),
		JSON.stringify({ schemaVersion: 1, release }),
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

test("release target explicitly selects v1 or v1.1", () => {
	assert.equal(
		validateReleaseTarget({ schemaVersion: 1, release: "v1.0.0" }),
		"v1.0.0",
	);
	assert.equal(
		validateReleaseTarget({ schemaVersion: 1, release: "v1.1.0" }),
		"v1.1.0",
	);
});

test("release target rejects inferred or expanded modes", () => {
	for (const value of [
		{},
		{ schemaVersion: 1, release: "v1.2.0" },
		{ schemaVersion: 1, release: "v1.0.0", draft: true },
	]) {
		assert.throws(() => validateReleaseTarget(value), /Release target/u);
	}
});

test("v1 release remains fixed at eleven works and seventeen HTML pages", async (context) => {
	const repoRoot = await createReleaseFixture(context, "v1.0.0");
	let builtOptions;
	const result = await verifyRelease({
		repoRoot,
		dependencies: {
			verifyBuiltSite: async (options) => {
				builtOptions = options;
				return V1_SITE;
			},
			verifyAggregateContent: async () => assert.fail("v1 ran v1.1 content"),
			verifyMediumArticles: async () => assert.fail("v1 ran Medium"),
			verifyPodcastRelease: async () => assert.fail("v1 ran podcast"),
		},
	});
	assert.equal(result.target, "v1.0.0");
	assert.deepEqual(result.site, V1_SITE);
	assert.deepEqual(builtOptions, {
		repoRoot,
		requireSignoff: true,
		releaseTarget: "v1.0.0",
	});
	assert.throws(
		() => validateV1SiteSummary({ ...V1_SITE, htmlPages: 18 }),
		/requires 17 htmlPages/u,
	);
});

test("v1.1 release requires reconciled writing, podcast, and presentation gates", async (context) => {
	const repoRoot = await createReleaseFixture(context, "v1.1.0", "v1.1.0");
	let podcastOptions;
	const result = await verifyRelease({
		repoRoot,
		dependencies: {
			verifyBuiltSite: async () => V11_SITE,
			verifyAggregateContent: async (options) => {
				assert.deepEqual(options, { repoRoot, requireComplete: true });
				return V11_AGGREGATE;
			},
			verifyMediumArticles: async (options) => {
				assert.deepEqual(options, { repoRoot, requireComplete: true });
				return V11_MEDIUM;
			},
			verifyPodcastRelease: async (options) => {
				podcastOptions = options;
				return V11_PODCAST;
			},
		},
	});
	assert.equal(result.target, "v1.1.0");
	assert.deepEqual(podcastOptions, { withBuilt: true });
	assert.deepEqual(result.site, V11_SITE);
	assert.doesNotThrow(() =>
		validateV11ReleaseSummary({
			site: V11_SITE,
			aggregate: V11_AGGREGATE,
			medium: V11_MEDIUM,
			podcast: V11_PODCAST,
		}),
	);
});

test("v1.1 release rejects a missing target-specific presentation approval", async (context) => {
	const repoRoot = await createReleaseFixture(context, "v1.1.0", "v1.0.0");
	await assert.rejects(
		verifyRelease({
			repoRoot,
			dependencies: {
				verifyBuiltSite: async () => V11_SITE,
				verifyAggregateContent: async () => V11_AGGREGATE,
				verifyMediumArticles: async () => V11_MEDIUM,
				verifyPodcastRelease: async () => V11_PODCAST,
			},
		}),
		/Presentation signoff is missing for v1\.1\.0/u,
	);
});

test("v1.1 release summary fails closed on inventory and surface drift", () => {
	assert.throws(
		() =>
			validateV11ReleaseSummary({
				site: V11_SITE,
				aggregate: V11_AGGREGATE,
				medium: { ...V11_MEDIUM, expectedCount: 0, importedCount: 0 },
				podcast: V11_PODCAST,
			}),
		/at least one complete/u,
	);
	assert.throws(
		() =>
			validateV11ReleaseSummary({
				site: { ...V11_SITE, pagefindRecords: 13 },
				aggregate: V11_AGGREGATE,
				medium: V11_MEDIUM,
				podcast: V11_PODCAST,
			}),
		/PagefindRecords|pagefindRecords/u,
	);
	assert.throws(
		() =>
			validateV11ReleaseSummary({
				site: V11_SITE,
				aggregate: V11_AGGREGATE,
				medium: V11_MEDIUM,
				podcast: { ...V11_PODCAST, builtArtifactsChecked: false },
			}),
		/built artifacts/u,
	);
});

test("presentation target validation rejects malformed or wrong-release ledgers", async (context) => {
	const validRoot = await createReleaseFixture(context, "v1.1.0", "v1.1.0");
	await assert.doesNotReject(
		requirePresentationTarget({ repoRoot: validRoot, release: "v1.1.0" }),
	);
	const wrongRoot = await createReleaseFixture(context, "v1.1.0", "v1.0.0");
	await assert.rejects(
		requirePresentationTarget({ repoRoot: wrongRoot, release: "v1.1.0" }),
		/missing for v1\.1\.0/u,
	);
});
