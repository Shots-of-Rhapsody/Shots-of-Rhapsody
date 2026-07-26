#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPresentationSignoffV2 } from "../content/presentation.js";
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

function collectInteger(value, label, failures) {
	if (!Number.isInteger(value) || value < 0) {
		failures.push(`Release summary has an invalid ${label}`);
		return undefined;
	}
	return value;
}

export function validateCombinedReleaseSummary({
	target,
	site,
	aggregate,
	medium,
	podcast,
}) {
	const failures = [];
	const { archiveWriting, mediumWriting, podcastEpisodes } = target.expected;
	const publishedWriting = archiveWriting + mediumWriting;
	const publishedCount = collectInteger(
		aggregate?.publishedCount,
		"aggregate published count",
		failures,
	);
	const mediumCount = collectInteger(
		medium?.expectedCount,
		"Medium expected count",
		failures,
	);
	const podcastCount = collectInteger(
		podcast?.episodes,
		"podcast episode count",
		failures,
	);
	if (aggregate?.complete !== true)
		failures.push("v1.0.0 aggregate content verification is incomplete");
	if (
		medium?.complete !== true ||
		mediumCount !== mediumWriting ||
		medium?.importedCount !== mediumWriting
	)
		failures.push(
			`v1.0.0 requires exactly ${mediumWriting} complete, approved Medium articles`,
		);
	if (
		aggregate?.sources?.medium?.importedCount !== mediumWriting ||
		aggregate?.sources?.medium?.complete !== true
	) {
		failures.push("v1.0.0 Medium inventory and aggregate catalog disagree");
	}
	const firstPartyCount = collectInteger(
		aggregate?.sources?.firstParty?.importedCount,
		"first-party writing count",
		failures,
	);
	if (
		aggregate?.sources?.archive?.importedCount !== archiveWriting ||
		aggregate?.sources?.archive?.complete !== true ||
		firstPartyCount !== 0 ||
		aggregate?.sources?.firstParty?.complete !== true ||
		publishedCount !== publishedWriting
	) {
		failures.push(
			"v1.0.0 aggregate catalog does not reconcile its exact approved writing sources",
		);
	}
	if (
		podcast?.complete !== true ||
		podcast?.builtArtifactsChecked !== true ||
		podcastCount !== podcastEpisodes
	) {
		failures.push(
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
			failures.push(
				`v1.0.0 release surfaces disagree: expected ${expected} ${field}, received ${site?.[field] ?? "missing"}`,
			);
		}
	}
	if (failures.length > 0) {
		throw new Error(
			`Combined release summary is invalid:\n- ${failures.join("\n- ")}`,
		);
	}
	return { site, aggregate, medium, podcast };
}

function failureMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function settledValue(result) {
	return result.status === "fulfilled" ? result.value : undefined;
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
	return verifyPresentationSignoffV2({ ledger, repoRoot, release });
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
	const checks = [
		[
			"built site and archive signoffs",
			() =>
				dependencies.verifyBuiltSite({
					repoRoot,
					requireSignoff: true,
					releaseTarget: "catalog",
				}),
		],
		[
			"aggregate writing catalog",
			() =>
				dependencies.verifyAggregateContent({
					repoRoot,
					requireComplete: true,
				}),
		],
		[
			"Medium writing",
			() =>
				dependencies.verifyMediumArticles({
					repoRoot,
					requireComplete: true,
				}),
		],
		[
			"presentation signoff",
			() => requirePresentationTarget({ repoRoot, release: target.release }),
		],
		[
			"podcast release",
			() =>
				dependencies.verifyPodcastRelease({
					withBuilt: true,
					release: target.release,
				}),
		],
	];
	const settled = await Promise.allSettled(checks.map(([, run]) => run()));
	const failures = settled.flatMap((result, index) =>
		result.status === "rejected"
			? [`${checks[index][0]}: ${failureMessage(result.reason)}`]
			: [],
	);
	const [siteResult, aggregateResult, mediumResult, , podcastResult] = settled;
	const site = settledValue(siteResult);
	const aggregate = settledValue(aggregateResult);
	const medium = settledValue(mediumResult);
	const podcast = settledValue(podcastResult);
	try {
		validateCombinedReleaseSummary({
			target,
			site,
			aggregate,
			medium,
			podcast,
		});
	} catch (error) {
		failures.push(failureMessage(error));
	}
	if (failures.length > 0) {
		throw new Error(
			`Combined release verification failed:\n- ${failures.join("\n- ")}`,
		);
	}
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
