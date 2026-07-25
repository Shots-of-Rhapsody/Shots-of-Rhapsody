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
const V1_SITE_SUMMARY = Object.freeze({
	htmlPages: 17,
	postPages: 11,
	rssItems: 11,
	pagefindRecords: 11,
	archiveEntries: 11,
	authorWorks: 11,
	nonfictionEntries: 0,
	podcastEpisodes: 0,
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
		Object.keys(value).length !== 2 ||
		value.schemaVersion !== 1 ||
		(value.release !== "v1.0.0" && value.release !== "v1.1.0")
	) {
		throw new Error(
			"Release target must be the exact version 1 contract for v1.0.0 or v1.1.0",
		);
	}
	return value.release;
}

function assertInteger(value, label) {
	if (!Number.isInteger(value) || value < 0)
		throw new Error(`Release summary has an invalid ${label}`);
	return value;
}

export function validateV1SiteSummary(site) {
	for (const [field, expected] of Object.entries(V1_SITE_SUMMARY)) {
		if (site?.[field] !== expected) {
			throw new Error(
				`v1.0.0 requires ${expected} ${field}; received ${site?.[field] ?? "missing"}`,
			);
		}
	}
	return site;
}

export function validateV11ReleaseSummary({
	site,
	aggregate,
	medium,
	podcast,
}) {
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
		throw new Error("v1.1.0 aggregate content verification is incomplete");
	if (medium?.complete !== true || mediumCount < 1)
		throw new Error(
			"v1.1.0 requires at least one complete, approved Medium article",
		);
	if (
		medium?.importedCount !== mediumCount ||
		aggregate?.sources?.medium?.importedCount !== mediumCount ||
		aggregate?.sources?.medium?.complete !== true
	) {
		throw new Error("v1.1.0 Medium inventory and aggregate catalog disagree");
	}
	const firstPartyCount = assertInteger(
		aggregate?.sources?.firstParty?.importedCount,
		"first-party writing count",
	);
	if (
		aggregate?.sources?.archive?.importedCount !== 11 ||
		aggregate?.sources?.archive?.complete !== true ||
		aggregate?.sources?.firstParty?.complete !== true ||
		publishedCount !== 11 + mediumCount + firstPartyCount
	) {
		throw new Error(
			"v1.1.0 aggregate catalog does not reconcile its approved writing sources",
		);
	}
	if (
		podcast?.complete !== true ||
		podcast?.builtArtifactsChecked !== true ||
		podcastCount < 1
	) {
		throw new Error(
			"v1.1.0 requires at least one complete podcast episode with built artifacts",
		);
	}
	for (const [field, expected] of [
		["postPages", publishedCount],
		["rssItems", publishedCount],
		["archiveEntries", publishedCount],
		["authorWorks", publishedCount],
		["podcastEpisodes", podcastCount],
		["pagefindRecords", publishedCount + podcastCount * 2],
		["htmlPages", publishedCount + podcastCount * 2 + 8],
	]) {
		if (site?.[field] !== expected) {
			throw new Error(
				`v1.1.0 release surfaces disagree: expected ${expected} ${field}, received ${site?.[field] ?? "missing"}`,
			);
		}
	}
	if (
		!Number.isInteger(site?.nonfictionEntries) ||
		site.nonfictionEntries < mediumCount ||
		site.nonfictionEntries > publishedCount
	) {
		throw new Error(
			"v1.1.0 nonfiction entries do not cover the approved Medium inventory",
		);
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
		releaseTarget: target,
	});
	if (target === "v1.0.0") {
		validateV1SiteSummary(site);
		return { target, site };
	}

	const aggregate = await dependencies.verifyAggregateContent({
		repoRoot,
		requireComplete: true,
	});
	const medium = await dependencies.verifyMediumArticles({
		repoRoot,
		requireComplete: true,
	});
	await requirePresentationTarget({ repoRoot, release: target });
	const podcast = await dependencies.verifyPodcastRelease({ withBuilt: true });
	validateV11ReleaseSummary({ site, aggregate, medium, podcast });
	return { target, site, aggregate, medium, podcast };
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
