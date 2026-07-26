import path from "node:path";
import {
	assertHttpsUrl,
	assertNonEmptyString,
	assertOnlyKeys,
	assertPlainObject,
	assertSha256,
	assertSlug,
	MEDIUM_HERO_CAPTURE_FILE,
	MEDIUM_HERO_SITE_READY_FILE,
	MediumContractError,
} from "./contract.js";
import { decodeUtf8, extractMediumHeroEvidence } from "./html.js";

export const MEDIUM_RELEASE_ESSAY_COUNT = 24;
export const MEDIUM_EXPORT_CANDIDATE_COUNT = 33;

function assertExpectedCount(value) {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new MediumContractError(
			"Medium hero checklist expectedCount must be a positive safe integer",
		);
	}
	return value;
}

export function validateApprovedMediumTitles(
	value,
	{ expectedCount = MEDIUM_RELEASE_ESSAY_COUNT } = {},
) {
	assertExpectedCount(expectedCount);
	if (!Array.isArray(value)) {
		throw new MediumContractError(
			"Approved Medium titles must be a JSON array",
		);
	}
	const titles = value.map((title, index) =>
		assertNonEmptyString(title, `approvedTitles[${index}]`),
	);
	if (titles.length !== expectedCount) {
		throw new MediumContractError(
			`Approved Medium title allowlist must contain exactly ${expectedCount} titles; found ${titles.length}`,
		);
	}
	if (new Set(titles).size !== titles.length) {
		throw new MediumContractError(
			"Approved Medium title allowlist repeats a title",
		);
	}
	return titles;
}

export function validateApprovedMediumAllowlist(
	value,
	{
		expectedCount = MEDIUM_RELEASE_ESSAY_COUNT,
		expectedCandidateCount = MEDIUM_EXPORT_CANDIDATE_COUNT,
	} = {},
) {
	const allowlist = assertPlainObject(value, "Approved Medium title allowlist");
	assertOnlyKeys(
		allowlist,
		new Set([
			"schemaVersion",
			"expectedCount",
			"expectedCandidateCount",
			"exportSha256",
			"candidateSetSha256",
			"titles",
		]),
		"Approved Medium title allowlist",
	);
	if (allowlist.schemaVersion !== 1) {
		throw new MediumContractError(
			"Approved Medium title allowlist schemaVersion must equal 1",
		);
	}
	if (allowlist.expectedCount !== expectedCount) {
		throw new MediumContractError(
			`Approved Medium title allowlist expectedCount must equal ${expectedCount}`,
		);
	}
	if (allowlist.expectedCandidateCount !== expectedCandidateCount) {
		throw new MediumContractError(
			`Approved Medium title allowlist expectedCandidateCount must equal ${expectedCandidateCount}`,
		);
	}
	return {
		schemaVersion: 1,
		expectedCount,
		expectedCandidateCount,
		exportSha256: assertSha256(
			allowlist.exportSha256,
			"Approved Medium title allowlist exportSha256",
		),
		candidateSetSha256: assertSha256(
			allowlist.candidateSetSha256,
			"Approved Medium title allowlist candidateSetSha256",
		),
		titles: validateApprovedMediumTitles(allowlist.titles, { expectedCount }),
	};
}

export function parseApprovedMediumTitleFile(
	contents,
	{
		expectedCount = MEDIUM_RELEASE_ESSAY_COUNT,
		expectedCandidateCount = MEDIUM_EXPORT_CANDIDATE_COUNT,
	} = {},
) {
	let value;
	try {
		value = JSON.parse(contents);
	} catch (error) {
		throw new MediumContractError(
			"Approved Medium title allowlist is not valid JSON",
			{ cause: error },
		);
	}
	return validateApprovedMediumAllowlist(value, {
		expectedCount,
		expectedCandidateCount,
	});
}

function mediumStoryId(sourcePath, canonicalUrl, title) {
	const sourceId = path.posix
		.basename(sourcePath)
		.match(/-([0-9a-f]{12})\.html$/u)?.[1];
	const canonical = assertHttpsUrl(canonicalUrl, `${title} canonical URL`, {
		hostname: "medium.com",
	});
	const canonicalId = canonical.pathname.match(/-([0-9a-f]{12})\/?$/u)?.[1];
	if (!sourceId || !canonicalId || sourceId !== canonicalId) {
		throw new MediumContractError(
			`Approved Medium story ${JSON.stringify(title)} has inconsistent export and canonical ids`,
		);
	}
	return { id: sourceId, canonicalUrl };
}

function assertUnique(items, selector, label) {
	const seen = new Set();
	for (const item of items) {
		const value = selector(item);
		if (seen.has(value)) {
			throw new MediumContractError(
				`Medium hero checklist repeats ${label} ${JSON.stringify(value)}`,
			);
		}
		seen.add(value);
	}
}

export function buildMediumHeroChecklist({
	entries,
	candidates,
	approvedAllowlist,
	exportFileName,
	exportSha256,
	candidateSetSha256,
	expectedCount = MEDIUM_RELEASE_ESSAY_COUNT,
	expectedCandidateCount = MEDIUM_EXPORT_CANDIDATE_COUNT,
} = {}) {
	const allowlist = validateApprovedMediumAllowlist(approvedAllowlist, {
		expectedCount,
		expectedCandidateCount,
	});
	const titles = allowlist.titles;
	assertExpectedCount(expectedCandidateCount);
	if (expectedCandidateCount < expectedCount) {
		throw new MediumContractError(
			"Medium export expectedCandidateCount cannot be smaller than its approved title count",
		);
	}
	if (!(entries instanceof Map)) {
		throw new MediumContractError("Medium export entries must be a Map");
	}
	assertSha256(exportSha256, "exportSha256");
	assertSha256(candidateSetSha256, "candidateSetSha256");
	if (exportSha256 !== allowlist.exportSha256) {
		throw new MediumContractError(
			"Official Medium export SHA-256 differs from the approved title allowlist binding",
		);
	}
	if (candidateSetSha256 !== allowlist.candidateSetSha256) {
		throw new MediumContractError(
			"Medium candidate-set SHA-256 differs from the approved title allowlist binding",
		);
	}
	if (!Array.isArray(candidates)) {
		throw new MediumContractError("Medium export candidates must be an array");
	}
	if (candidates.length !== expectedCandidateCount) {
		throw new MediumContractError(
			`Medium export must contain exactly ${expectedCandidateCount} candidates; found ${candidates.length}`,
		);
	}
	assertNonEmptyString(exportFileName, "exportFileName");

	const candidatesByTitle = new Map();
	for (const [index, candidate] of candidates.entries()) {
		const title = assertNonEmptyString(
			candidate?.title,
			`candidates[${index}].title`,
		);
		const matches = candidatesByTitle.get(title) ?? [];
		matches.push(candidate);
		candidatesByTitle.set(title, matches);
	}
	const missing = titles.filter(
		(title) => (candidatesByTitle.get(title)?.length ?? 0) === 0,
	);
	const ambiguous = titles.filter(
		(title) => (candidatesByTitle.get(title)?.length ?? 0) > 1,
	);
	if (missing.length > 0 || ambiguous.length > 0) {
		throw new MediumContractError(
			[
				"Approved Medium title allowlist does not match the export exactly",
				...(missing.length > 0
					? [
							`missing: ${missing.map((title) => JSON.stringify(title)).join(", ")}`,
						]
					: []),
				...(ambiguous.length > 0
					? [
							`ambiguous: ${ambiguous.map((title) => JSON.stringify(title)).join(", ")}`,
						]
					: []),
			].join("; "),
		);
	}

	const items = titles.map((title) => {
		const candidate = candidatesByTitle.get(title)[0];
		const slug = assertSlug(candidate.suggestedSlug, `${title} suggestedSlug`);
		const displayTitleCandidate = assertNonEmptyString(
			candidate.displayTitleCandidate,
			`${title} displayTitleCandidate`,
		);
		const displaySubtitleCandidate = assertNonEmptyString(
			candidate.displaySubtitleCandidate,
			`${title} displaySubtitleCandidate`,
		);
		const seriesLineCandidate = assertNonEmptyString(
			candidate.seriesLineCandidate,
			`${title} seriesLineCandidate`,
		);
		if (!seriesLineCandidate.startsWith("A Ledger Series article ")) {
			throw new MediumContractError(
				`${title} seriesLineCandidate must begin with "A Ledger Series article"`,
			);
		}
		const sourcePath = assertNonEmptyString(
			candidate.sourcePath,
			`${title} sourcePath`,
		);
		const source = entries.get(sourcePath);
		if (!Buffer.isBuffer(source)) {
			throw new MediumContractError(
				`Approved Medium story ${JSON.stringify(title)} is missing from the export`,
			);
		}
		const story = mediumStoryId(
			sourcePath,
			candidate.canonicalUrlCandidate,
			title,
		);
		const hero = extractMediumHeroEvidence(decodeUtf8(source, sourcePath), {
			slug,
			exportTitle: title,
			exportSummary: candidate.exportSummaryCandidate,
			title: displayTitleCandidate,
			subtitle: displaySubtitleCandidate,
			seriesLine: seriesLineCandidate,
		});
		return {
			storyId: story.id,
			heroImageId: hero.imageId,
			slug,
			title,
			descriptionCandidate: candidate.descriptionCandidate,
			exportSummaryCandidate: candidate.exportSummaryCandidate,
			displayTitleCandidate,
			displaySubtitleCandidate,
			seriesLineCandidate,
			canonicalUrl: story.canonicalUrl,
			sourcePath,
			exportedHero: {
				identificationEvidence: hero.identificationEvidence,
				sourceUrl: hero.sourceUrl,
				declaredWidth: hero.declaredWidth,
				declaredHeight: hero.declaredHeight,
				alt: hero.alt,
				caption: hero.caption,
			},
			requiredCapturePath: `.medium-import/raw/assets/${slug}/${MEDIUM_HERO_CAPTURE_FILE}`,
			requiredSiteReadyPath: `.medium-import/site-ready/assets/${slug}/${MEDIUM_HERO_SITE_READY_FILE}`,
		};
	});

	for (const [selector, label] of [
		[(item) => item.storyId, "story id"],
		[(item) => item.heroImageId, "hero image id"],
		[(item) => item.slug, "slug"],
		[(item) => new URL(item.canonicalUrl).toString(), "canonical URL"],
		[
			(item) => new URL(item.exportedHero.sourceUrl).toString(),
			"hero source URL",
		],
	]) {
		assertUnique(items, selector, label);
	}

	return {
		schemaVersion: 1,
		state: "asset-acquisition-checklist",
		assetPolicy: {
			exportedSourceUrlUse: "comparison-reference-only",
			browserCaptureRequired: true,
			captureKind: "highest-observed-medium-responsive-derivative",
			originalUploadClaimed: false,
			automatedDownloadAllowed: false,
			metadataStrippingRequired: true,
		},
		export: {
			fileName: exportFileName,
			sha256: exportSha256,
			candidateSetSha256,
		},
		exportedCandidateCount: candidates.length,
		expectedCandidateCount,
		approvedTitleCount: titles.length,
		unapprovedCandidateCount: candidates.length - titles.length,
		items,
	};
}
