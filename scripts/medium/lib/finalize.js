import {
	MEDIUM_EXPORT_CANDIDATE_COUNT,
	MEDIUM_RELEASE_ESSAY_COUNT,
	validateApprovedMediumAllowlist,
} from "./assets.js";
import {
	assertCanonicalUtc,
	assertNonEmptyString,
	assertOnlyKeys,
	assertPlainObject,
	assertSha256,
	assertSlug,
	CAPTURE_FORMAT,
	INVENTORY_SCHEMA_VERSION,
	MEDIUM_HERO_CAPTURE_FILE,
	MEDIUM_HERO_SITE_READY_FILE,
	MediumContractError,
	serializeJson,
} from "./contract.js";
import { sha256 } from "./integrity.js";
import {
	MEDIUM_PRESENTATION_SET_VERSION,
	validateMediumInventory,
} from "./model.js";
import { validateMediumInventoryReviewProposal } from "./review.js";

export const REVIEWED_INVENTORY_SCAFFOLD_VERSION = 1;
export const SUMMARY_FALLBACKS_VERSION = 1;

function indexedBy(items, field, label) {
	const index = new Map();
	for (const item of items) {
		const key = item?.[field];
		if (index.has(key)) {
			throw new MediumContractError(`${label} repeats ${field}`);
		}
		index.set(key, item);
	}
	return index;
}

function sourceHeroValue(record, label) {
	const value = assertPlainObject(record, label);
	assertOnlyKeys(value, new Set(["present", "value"]), label);
	if (value.present === false && value.value === null) return null;
	if (value.present !== true || typeof value.value !== "string") {
		throw new MediumContractError(
			`${label} must preserve an explicit source value or source absence`,
		);
	}
	return value.value;
}

export function buildMediumReviewedInventoryScaffold({
	proposal,
	approvedAllowlist,
	heroAssetLedger,
	heroChecklist,
	expectedCount = MEDIUM_RELEASE_ESSAY_COUNT,
	expectedCandidateCount = MEDIUM_EXPORT_CANDIDATE_COUNT,
} = {}) {
	const allowlist = validateApprovedMediumAllowlist(approvedAllowlist, {
		expectedCount,
		expectedCandidateCount,
	});
	const reviewedProposal = validateMediumInventoryReviewProposal(proposal, {
		approvedAllowlist: allowlist,
		expectedCount,
		expectedCandidateCount,
	});
	if (
		heroAssetLedger?.itemCount !== expectedCount ||
		!Array.isArray(heroAssetLedger?.items) ||
		heroAssetLedger.exportSha256 !== reviewedProposal.export.sha256 ||
		heroAssetLedger.candidateSetSha256 !== reviewedProposal.candidateSetSha256
	) {
		throw new MediumContractError(
			"Durable Medium hero anchor differs from the reviewed proposal",
		);
	}
	if (
		heroChecklist?.approvedTitleCount !== expectedCount ||
		!Array.isArray(heroChecklist?.items) ||
		heroChecklist.items.length !== expectedCount ||
		heroChecklist.export?.sha256 !== reviewedProposal.export.sha256 ||
		heroChecklist.export?.candidateSetSha256 !==
			reviewedProposal.candidateSetSha256
	) {
		throw new MediumContractError(
			"Medium hero checklist differs from the reviewed proposal",
		);
	}
	const candidatesByTitle = indexedBy(
		reviewedProposal.candidates.filter((candidate) => candidate.include),
		"title",
		"Included Medium candidates",
	);
	const assetsByTitle = indexedBy(
		heroAssetLedger.items,
		"title",
		"Durable Medium hero anchor",
	);
	const checklistByTitle = indexedBy(
		heroChecklist.items,
		"title",
		"Medium hero checklist",
	);
	const articles = allowlist.titles.map((exportTitle) => {
		const candidate = candidatesByTitle.get(exportTitle);
		const asset = assetsByTitle.get(exportTitle);
		const checklist = checklistByTitle.get(exportTitle);
		if (!candidate || !asset || !checklist) {
			throw new MediumContractError(
				`Medium reviewed inventory evidence is incomplete for ${JSON.stringify(exportTitle)}`,
			);
		}
		if (
			candidate.suggestedSlug !== asset.slug ||
			candidate.suggestedSlug !== checklist.slug ||
			candidate.canonicalUrlCandidate !== asset.canonicalUrl ||
			candidate.canonicalUrlCandidate !== checklist.canonicalUrl ||
			candidate.sourcePath !== checklist.sourcePath
		) {
			throw new MediumContractError(
				`Medium reviewed inventory identities differ for ${candidate.suggestedSlug}`,
			);
		}
		if (
			candidate.publishedAtCandidate === null ||
			candidate.canonicalUrlCandidate === null
		) {
			throw new MediumContractError(
				`Medium reviewed inventory source metadata is incomplete for ${candidate.suggestedSlug}`,
			);
		}
		const sourceAlt = sourceHeroValue(
			checklist.exportedHero?.alt,
			`${candidate.suggestedSlug} hero alt evidence`,
		);
		const sourceCaption = sourceHeroValue(
			checklist.exportedHero?.caption,
			`${candidate.suggestedSlug} hero caption evidence`,
		);
		return {
			slug: candidate.suggestedSlug,
			exportTitle: candidate.title,
			exportSummary: candidate.exportSummaryCandidate,
			title: candidate.displayTitleCandidate,
			subtitle: candidate.displaySubtitleCandidate,
			seriesLine: candidate.seriesLineCandidate,
			summary: candidate.exportSummaryCandidate,
			description: candidate.exportSummaryCandidate,
			publishedAt: candidate.publishedAtCandidate,
			canonicalUrl: candidate.canonicalUrlCandidate,
			sourcePath: candidate.sourcePath,
			sourceSha256: candidate.sourceSha256,
			category: "Nonfiction",
			tags: [],
			classification: { ...candidate.classification },
			assets: [
				{
					id: "hero",
					role: "hero",
					sourceUrl: checklist.exportedHero.sourceUrl,
					rawFile: MEDIUM_HERO_CAPTURE_FILE,
					siteReadyFile: MEDIUM_HERO_SITE_READY_FILE,
					outputFile: "hero.webp",
					sha256: asset.siteReady.sha256,
					acquisitionManifestSha256: heroAssetLedger.acquisitionManifestSha256,
					captureSha256: asset.capture.sha256,
					pixelSha256: asset.pixels.sha256,
					mimeType: asset.siteReady.mimeType,
					width: asset.siteReady.width,
					height: asset.siteReady.height,
					byteSize: asset.siteReady.byteSize,
					alt: sourceAlt,
					caption: sourceCaption ?? "",
				},
			],
			pendingAuthorInput:
				candidate.exportSummaryCandidate === null ? ["summaryFallback"] : [],
		};
	});
	const scaffold = {
		schemaVersion: REVIEWED_INVENTORY_SCAFFOLD_VERSION,
		state: "author-input-required",
		proposalSha256: sha256(
			Buffer.from(serializeJson(reviewedProposal), "utf8"),
		),
		presentationSetVersion: MEDIUM_PRESENTATION_SET_VERSION,
		presentationSetSha256: reviewedProposal.presentationSetSha256,
		export: reviewedProposal.export,
		candidateCount: reviewedProposal.candidateCount,
		candidateSetSha256: reviewedProposal.candidateSetSha256,
		candidates: reviewedProposal.candidates,
		expectedCount: reviewedProposal.expectedCount,
		articles,
		pendingSummarySlugs: articles
			.filter((article) => article.summary === null)
			.map((article) => article.slug),
	};
	return scaffold;
}

export function validateMediumSummaryFallbacks(value, scaffold) {
	const record = assertPlainObject(value, "Medium summary fallbacks");
	assertOnlyKeys(
		record,
		new Set([
			"schemaVersion",
			"proposalSha256",
			"presentationSetSha256",
			"fallbacks",
		]),
		"Medium summary fallbacks",
	);
	if (record.schemaVersion !== SUMMARY_FALLBACKS_VERSION) {
		throw new MediumContractError(
			`Medium summary fallbacks schemaVersion must equal ${SUMMARY_FALLBACKS_VERSION}`,
		);
	}
	if (
		assertSha256(record.proposalSha256, "summary fallbacks proposalSha256") !==
			scaffold.proposalSha256 ||
		assertSha256(
			record.presentationSetSha256,
			"summary fallbacks presentationSetSha256",
		) !== scaffold.presentationSetSha256
	) {
		throw new MediumContractError(
			"Medium summary fallbacks are not bound to the current proposal",
		);
	}
	if (!Array.isArray(record.fallbacks)) {
		throw new MediumContractError("Medium summary fallbacks must be an array");
	}
	const fallbacks = record.fallbacks.map((value, index) => {
		const label = `Medium summary fallbacks[${index}]`;
		const fallback = assertPlainObject(value, label);
		assertOnlyKeys(fallback, new Set(["slug", "summary"]), label);
		return {
			slug: assertSlug(fallback.slug, `${label}.slug`),
			summary: assertNonEmptyString(fallback.summary, `${label}.summary`),
		};
	});
	if (
		new Set(fallbacks.map((fallback) => fallback.slug)).size !==
		fallbacks.length
	) {
		throw new MediumContractError("Medium summary fallbacks repeat a slug");
	}
	const required = new Set(scaffold.pendingSummarySlugs);
	if (
		fallbacks.length !== required.size ||
		fallbacks.some((fallback) => !required.has(fallback.slug))
	) {
		throw new MediumContractError(
			"Medium summary fallbacks must resolve exactly the source-missing summaries",
		);
	}
	return new Map(
		fallbacks.map((fallback) => [fallback.slug, fallback.summary]),
	);
}

export function finalizeMediumReviewedInventory({
	scaffold,
	summaryFallbacks,
} = {}) {
	const fallbacks = validateMediumSummaryFallbacks(summaryFallbacks, scaffold);
	const articles = scaffold.articles.map(
		({ pendingAuthorInput: _pending, ...article }) => {
			const summary = article.exportSummary ?? fallbacks.get(article.slug);
			if (summary === undefined) {
				throw new MediumContractError(
					`Medium article ${article.slug} still lacks an approved summary fallback`,
				);
			}
			return { ...article, summary, description: summary };
		},
	);
	const inventory = {
		schemaVersion: INVENTORY_SCHEMA_VERSION,
		state: "reviewed",
		authority: { platform: "Medium", captureFormat: CAPTURE_FORMAT },
		author: {
			name: "Tai Song",
			profileUrl: "https://medium.com/@ShotsOfRhapsody",
		},
		export: {
			...scaffold.export,
			capturedAt: assertCanonicalUtc(
				scaffold.export.capturedAt,
				"scaffold.export.capturedAt",
			),
		},
		candidateCount: scaffold.candidateCount,
		candidateSetSha256: scaffold.candidateSetSha256,
		presentationSetVersion: scaffold.presentationSetVersion,
		presentationSetSha256: scaffold.presentationSetSha256,
		candidates: scaffold.candidates,
		expectedCount: scaffold.expectedCount,
		articles,
	};
	const { bySlug: _bySlug, ...serializable } =
		validateMediumInventory(inventory);
	return serializable;
}

export function serializeReviewedMediumInventory(inventory) {
	const { bySlug: _bySlug, ...serializable } = inventory;
	return serializeJson(serializable);
}
