#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePresentationSignoffsV2 } from "../content/signoffs.js";
import {
	verifyAggregateContent,
	verifyMediumArticles,
} from "../medium/lib/pipeline.js";
import { verifyPodcastRelease } from "../podcast/verify.mjs";
import { verifyBuiltSite } from "../verify-built-site.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const RELEASE_EXPECTATIONS = Object.freeze({
	archiveWriting: 11,
	mediumWriting: 24,
	podcastEpisodes: 1,
});

const defaultDependencies = Object.freeze({
	verifyBuiltSite,
	verifyAggregateContent,
	verifyMediumArticles,
	verifyPodcastRelease,
});

export function validateReleaseTarget(value) {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!hasExactKeys(value, new Set(["schemaVersion", "release", "expected"])) ||
		value.schemaVersion !== 2 ||
		value.release !== "v1.0.0" ||
		value.expected === null ||
		typeof value.expected !== "object" ||
		Array.isArray(value.expected) ||
		!hasExactKeys(value.expected, new Set(Object.keys(RELEASE_EXPECTATIONS))) ||
		Object.entries(RELEASE_EXPECTATIONS).some(
			([field, expected]) => value.expected[field] !== expected,
		)
	) {
		throw new Error(
			"Release target must be the exact schema version 2 contract for the combined v1.0.0 release",
		);
	}
	return value;
}

function hasExactKeys(value, expected) {
	const keys = Object.keys(value);
	return (
		keys.length === expected.size && keys.every((key) => expected.has(key))
	);
}

function assertInteger(value, label) {
	if (!Number.isInteger(value) || value < 0)
		throw new Error(`Release summary has an invalid ${label}`);
	return value;
}

export function validateCombinedReleaseSummary({
	target,
	site,
	aggregate,
	medium,
	podcast,
}) {
	const { archiveWriting, mediumWriting, podcastEpisodes } = target.expected;
	const publishedWriting = archiveWriting + mediumWriting;
	const publishedCount = assertInteger(
		aggregate?.publishedCount,
		"aggregate published count",
	);
	const mediumCount = assertInteger(
		medium?.expectedCount,
		"Medium expected count",
	);
	const podcastCount = assertInteger(
		podcast?.episodes,
		"podcast episode count",
	);
	if (aggregate?.complete !== true)
		throw new Error("v1.0.0 aggregate content verification is incomplete");
	if (
		medium?.complete !== true ||
		mediumCount !== mediumWriting ||
		medium?.importedCount !== mediumWriting
	)
		throw new Error(
			`v1.0.0 requires exactly ${mediumWriting} complete, approved Medium articles`,
		);
	if (
		aggregate?.sources?.medium?.importedCount !== mediumWriting ||
		aggregate?.sources?.medium?.complete !== true
	) {
		throw new Error("v1.0.0 Medium inventory and aggregate catalog disagree");
	}
	const firstPartyCount = assertInteger(
		aggregate?.sources?.firstParty?.importedCount,
		"first-party writing count",
	);
	if (
		aggregate?.sources?.archive?.importedCount !== archiveWriting ||
		aggregate?.sources?.archive?.complete !== true ||
		firstPartyCount !== 0 ||
		aggregate?.sources?.firstParty?.complete !== true ||
		publishedCount !== publishedWriting
	) {
		throw new Error(
			"v1.0.0 aggregate catalog does not reconcile its exact approved writing sources",
		);
	}
	if (
		podcast?.complete !== true ||
		podcast?.builtArtifactsChecked !== true ||
		podcastCount !== podcastEpisodes
	) {
		throw new Error(
			`v1.0.0 requires exactly ${podcastEpisodes} complete podcast episode with built artifacts`,
		);
	}
	for (const [field, expected] of [
		["postPages", publishedWriting],
		["rssItems", publishedWriting],
		["archiveEntries", publishedWriting],
		["authorWorks", publishedWriting],
		["nonfictionEntries", mediumWriting],
		["podcastEpisodes", podcastEpisodes],
		["pagefindRecords", publishedWriting + podcastEpisodes * 2],
		["htmlPages", publishedWriting + podcastEpisodes * 2 + 8],
	]) {
		if (site?.[field] !== expected) {
			throw new Error(
				`v1.0.0 release surfaces disagree: expected ${expected} ${field}, received ${site?.[field] ?? "missing"}`,
			);
		}
	}
	return { site, aggregate, medium, podcast };
}

export async function requirePresentationTarget({ repoRoot, release }) {
	let ledger;
	try {
		ledger = JSON.parse(
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
	} catch (error) {
		throw new Error(
			`Presentation signoff ledger is invalid (${error.message})`,
		);
	}
	const releases = validatePresentationSignoffsV2(ledger);
	if (!releases.some((record) => record.release === release)) {
		throw new Error(`Presentation signoff is missing for ${release}`);
	}
}

async function readReleaseTarget(repoRoot) {
	try {
		return validateReleaseTarget(
			JSON.parse(
				await readFile(
					path.join(repoRoot, "provenance", "release-target.json"),
					"utf8",
				),
			),
		);
	} catch (error) {
		throw new Error(`Release target is invalid (${error.message})`);
	}
}

export async function verifyRelease({
	repoRoot = repositoryRoot,
	dependencies: dependencyOverrides = {},
} = {}) {
	const dependencies = { ...defaultDependencies, ...dependencyOverrides };
	const target = await readReleaseTarget(repoRoot);
	const site = await dependencies.verifyBuiltSite({
		repoRoot,
		requireSignoff: true,
		releaseTarget: "catalog",
	});
	const aggregate = await dependencies.verifyAggregateContent({
		repoRoot,
		requireComplete: true,
	});
	const medium = await dependencies.verifyMediumArticles({
		repoRoot,
		requireComplete: true,
	});
	await requirePresentationTarget({ repoRoot, release: target.release });
	const podcast = await dependencies.verifyPodcastRelease({
		withBuilt: true,
		release: target.release,
	});
	validateCombinedReleaseSummary({
		target,
		site,
		aggregate,
		medium,
		podcast,
	});
	return { target: target.release, site, aggregate, medium, podcast };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	verifyRelease()
		.then(({ target, site }) => {
			console.log(
				`Release verification passed for ${target}: ${site.postPages} writing routes`,
			);
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
