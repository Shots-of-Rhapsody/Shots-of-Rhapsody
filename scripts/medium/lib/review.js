import {
	MEDIUM_EXPORT_CANDIDATE_COUNT,
	MEDIUM_RELEASE_ESSAY_COUNT,
	validateApprovedMediumAllowlist,
} from "./assets.js";
import {
	AUTHOR_NAME,
	AUTHOR_PROFILE_URL,
	AUTHORITY_PLATFORM,
	assertCanonicalUtc,
	assertHttpsUrl,
	assertInteger,
	assertNonEmptyString,
	assertNullableString,
	assertOnlyKeys,
	assertPlainObject,
	assertSafeRepositoryPath,
	assertSha256,
	assertSlug,
	assertString,
	CAPTURE_FORMAT,
	INVENTORY_SCHEMA_VERSION,
	MediumContractError,
} from "./contract.js";
import { mediumCandidateSetSha256 } from "./model.js";

export const MEDIUM_RESPONSE_EXCLUSION_REASON =
	"Excluded because the exported item is a response, not a standalone article.";

const CANDIDATE_KEYS = new Set([
	"suggestedSlug",
	"title",
	"descriptionCandidate",
	"exportSummaryCandidate",
	"displayTitleCandidate",
	"displaySubtitleCandidate",
	"seriesLineCandidate",
	"publishedAtCandidate",
	"canonicalUrlCandidate",
	"sourcePath",
	"sourceSha256",
	"include",
	"exclusionReason",
	"classification",
]);

function validateCandidateEvidence(value, label) {
	const candidate = assertPlainObject(value, label);
	assertOnlyKeys(candidate, CANDIDATE_KEYS, label);
	const sourcePath = assertSafeRepositoryPath(
		candidate.sourcePath,
		`${label}.sourcePath`,
	);
	if (!/(?:^|\/)posts\/[^/]+\.html$/u.test(sourcePath)) {
		throw new MediumContractError(
			`${label}.sourcePath must identify posts/*.html`,
		);
	}
	const canonicalUrlCandidate =
		candidate.canonicalUrlCandidate === null
			? null
			: assertHttpsUrl(
					candidate.canonicalUrlCandidate,
					`${label}.canonicalUrlCandidate`,
					{ hostname: "medium.com" },
				).toString();
	const displayTitleCandidate =
		candidate.displayTitleCandidate === null
			? null
			: assertNonEmptyString(
					candidate.displayTitleCandidate,
					`${label}.displayTitleCandidate`,
				);
	const displaySubtitleCandidate =
		candidate.displaySubtitleCandidate === null
			? null
			: assertNonEmptyString(
					candidate.displaySubtitleCandidate,
					`${label}.displaySubtitleCandidate`,
				);
	const seriesLineCandidate =
		candidate.seriesLineCandidate === null
			? null
			: assertNonEmptyString(
					candidate.seriesLineCandidate,
					`${label}.seriesLineCandidate`,
				);
	if (
		seriesLineCandidate !== null &&
		!seriesLineCandidate.startsWith("A Ledger Series article ")
	) {
		throw new MediumContractError(
			`${label}.seriesLineCandidate must begin with "A Ledger Series article"`,
		);
	}
	return {
		suggestedSlug: assertSlug(
			candidate.suggestedSlug,
			`${label}.suggestedSlug`,
		),
		title: assertNonEmptyString(candidate.title, `${label}.title`),
		descriptionCandidate: assertNullableString(
			candidate.descriptionCandidate,
			`${label}.descriptionCandidate`,
		),
		exportSummaryCandidate: assertNullableString(
			candidate.exportSummaryCandidate,
			`${label}.exportSummaryCandidate`,
		),
		displayTitleCandidate,
		displaySubtitleCandidate,
		seriesLineCandidate,
		publishedAtCandidate:
			candidate.publishedAtCandidate === null
				? null
				: assertCanonicalUtc(
						candidate.publishedAtCandidate,
						`${label}.publishedAtCandidate`,
					),
		canonicalUrlCandidate,
		sourcePath,
		sourceSha256: assertSha256(candidate.sourceSha256, `${label}.sourceSha256`),
	};
}

export function validateUnresolvedMediumCandidate(value, label) {
	const evidence = validateCandidateEvidence(value, label);
	const candidate = value;
	const classification = assertPlainObject(
		candidate.classification,
		`${label}.classification`,
	);
	assertOnlyKeys(
		classification,
		new Set(["visibility", "authorship", "format"]),
		`${label}.classification`,
	);
	if (
		candidate.include !== null ||
		candidate.exclusionReason !== "" ||
		classification.visibility !== null ||
		classification.authorship !== null ||
		classification.format !== null
	) {
		throw new MediumContractError(`${label} must remain unresolved`);
	}
	return {
		...evidence,
		include: null,
		exclusionReason: "",
		classification: { visibility: null, authorship: null, format: null },
	};
}

function validateProposedCandidate(value, label) {
	const evidence = validateCandidateEvidence(value, label);
	const candidate = value;
	const classification = assertPlainObject(
		candidate.classification,
		`${label}.classification`,
	);
	assertOnlyKeys(
		classification,
		new Set(["visibility", "authorship", "format"]),
		`${label}.classification`,
	);
	const exclusionReason = assertString(
		candidate.exclusionReason,
		`${label}.exclusionReason`,
	);
	if (typeof candidate.include !== "boolean") {
		throw new MediumContractError(`${label}.include must be boolean`);
	}
	if (candidate.include) {
		if (
			evidence.displayTitleCandidate === null ||
			evidence.displaySubtitleCandidate === null ||
			evidence.seriesLineCandidate === null ||
			exclusionReason !== "" ||
			classification.visibility !== "public" ||
			classification.authorship !== "original" ||
			classification.format !== "standalone"
		) {
			throw new MediumContractError(
				`${label} included disposition must be public, original, and standalone`,
			);
		}
	} else if (
		exclusionReason !== MEDIUM_RESPONSE_EXCLUSION_REASON ||
		classification.visibility !== "public" ||
		classification.authorship !== "response" ||
		classification.format !== "response"
	) {
		throw new MediumContractError(
			`${label} excluded disposition must identify an exact public response`,
		);
	}
	return {
		...evidence,
		include: candidate.include,
		exclusionReason,
		classification: {
			visibility: classification.visibility,
			authorship: classification.authorship,
			format: classification.format,
		},
	};
}

function validateExport(value, label) {
	const exportRecord = assertPlainObject(value, label);
	assertOnlyKeys(
		exportRecord,
		new Set(["fileName", "sha256", "capturedAt"]),
		label,
	);
	if (exportRecord.fileName !== "medium-export.zip") {
		throw new MediumContractError(
			`${label}.fileName must equal "medium-export.zip"`,
		);
	}
	return {
		fileName: exportRecord.fileName,
		sha256: assertSha256(exportRecord.sha256, `${label}.sha256`),
		capturedAt: assertCanonicalUtc(
			exportRecord.capturedAt,
			`${label}.capturedAt`,
		),
	};
}

function assertUniqueCandidates(candidates) {
	for (const field of [
		"suggestedSlug",
		"title",
		"sourcePath",
		"sourceSha256",
	]) {
		const values = candidates.map((candidate) => candidate[field]);
		if (new Set(values).size !== values.length) {
			throw new MediumContractError(
				`Medium inventory review proposal repeats candidate ${field}`,
			);
		}
	}
}

export function validateMediumInventoryReviewProposal(
	value,
	{
		approvedAllowlist,
		expectedCount = MEDIUM_RELEASE_ESSAY_COUNT,
		expectedCandidateCount = MEDIUM_EXPORT_CANDIDATE_COUNT,
	} = {},
) {
	const allowlist = validateApprovedMediumAllowlist(approvedAllowlist, {
		expectedCount,
		expectedCandidateCount,
	});
	const proposal = assertPlainObject(value, "Medium inventory review proposal");
	assertOnlyKeys(
		proposal,
		new Set([
			"schemaVersion",
			"state",
			"authority",
			"author",
			"authorEvidence",
			"export",
			"candidateCount",
			"candidateSetSha256",
			"expectedCount",
			"includedCount",
			"excludedResponseCount",
			"candidates",
		]),
		"Medium inventory review proposal",
	);
	if (
		proposal.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
		proposal.state !== "disposition-review-proposal"
	) {
		throw new MediumContractError(
			"Medium inventory review proposal must be the version 1 non-publishing proposal",
		);
	}
	const authority = assertPlainObject(proposal.authority, "proposal.authority");
	assertOnlyKeys(
		authority,
		new Set(["platform", "captureFormat"]),
		"proposal.authority",
	);
	if (
		authority.platform !== AUTHORITY_PLATFORM ||
		authority.captureFormat !== CAPTURE_FORMAT
	) {
		throw new MediumContractError(
			"Medium inventory review proposal authority is invalid",
		);
	}
	const author = assertPlainObject(proposal.author, "proposal.author");
	assertOnlyKeys(author, new Set(["name", "profileUrl"]), "proposal.author");
	if (author.name !== AUTHOR_NAME || author.profileUrl !== AUTHOR_PROFILE_URL) {
		throw new MediumContractError(
			"Medium inventory review proposal author is invalid",
		);
	}
	const authorEvidence = assertPlainObject(
		proposal.authorEvidence,
		"proposal.authorEvidence",
	);
	assertOnlyKeys(
		authorEvidence,
		new Set(["source", "matchedCandidateCount"]),
		"proposal.authorEvidence",
	);
	if (
		authorEvidence.source !== "official-export-footer" ||
		authorEvidence.matchedCandidateCount !== expectedCandidateCount
	) {
		throw new MediumContractError(
			"Medium inventory review proposal lacks complete source author evidence",
		);
	}
	const exportRecord = validateExport(proposal.export, "proposal.export");
	if (exportRecord.sha256 !== allowlist.exportSha256) {
		throw new MediumContractError(
			"Medium inventory review proposal export differs from its approved allowlist",
		);
	}
	if (!Array.isArray(proposal.candidates)) {
		throw new MediumContractError(
			"Medium inventory review proposal candidates must be an array",
		);
	}
	const candidates = proposal.candidates.map((candidate, index) =>
		validateProposedCandidate(candidate, `proposal.candidates[${index}]`),
	);
	assertUniqueCandidates(candidates);
	const candidateSetSha256 = assertSha256(
		proposal.candidateSetSha256,
		"proposal.candidateSetSha256",
	);
	if (
		candidateSetSha256 !== allowlist.candidateSetSha256 ||
		candidateSetSha256 !== mediumCandidateSetSha256(candidates)
	) {
		throw new MediumContractError(
			"Medium inventory review proposal candidate set differs from its approved allowlist",
		);
	}
	const candidateCount = assertInteger(
		proposal.candidateCount,
		"proposal.candidateCount",
		{ positive: true },
	);
	const included = candidates.filter((candidate) => candidate.include);
	const excluded = candidates.filter((candidate) => !candidate.include);
	if (
		candidateCount !== expectedCandidateCount ||
		candidates.length !== expectedCandidateCount ||
		proposal.expectedCount !== expectedCount ||
		proposal.includedCount !== expectedCount ||
		proposal.excludedResponseCount !== expectedCandidateCount - expectedCount ||
		included.length !== expectedCount ||
		excluded.length !== expectedCandidateCount - expectedCount
	) {
		throw new MediumContractError(
			"Medium inventory review proposal disposition counts are inconsistent",
		);
	}
	const approvedTitles = new Set(allowlist.titles);
	if (
		included.some((candidate) => !approvedTitles.has(candidate.title)) ||
		allowlist.titles.some(
			(title) => !included.some((candidate) => candidate.title === title),
		)
	) {
		throw new MediumContractError(
			"Medium inventory review proposal does not exactly match its approved titles",
		);
	}
	return {
		schemaVersion: INVENTORY_SCHEMA_VERSION,
		state: "disposition-review-proposal",
		authority: { platform: AUTHORITY_PLATFORM, captureFormat: CAPTURE_FORMAT },
		author: { name: AUTHOR_NAME, profileUrl: AUTHOR_PROFILE_URL },
		authorEvidence: {
			source: "official-export-footer",
			matchedCandidateCount: expectedCandidateCount,
		},
		export: exportRecord,
		candidateCount,
		candidateSetSha256,
		expectedCount,
		includedCount: included.length,
		excludedResponseCount: excluded.length,
		candidates,
	};
}

export function buildMediumInventoryReviewProposal({
	candidates,
	approvedAllowlist,
	exportRecord,
	authorEvidenceCount,
	expectedCount = MEDIUM_RELEASE_ESSAY_COUNT,
	expectedCandidateCount = MEDIUM_EXPORT_CANDIDATE_COUNT,
} = {}) {
	const allowlist = validateApprovedMediumAllowlist(approvedAllowlist, {
		expectedCount,
		expectedCandidateCount,
	});
	if (!Array.isArray(candidates)) {
		throw new MediumContractError(
			"Unresolved Medium inventory candidates must be an array",
		);
	}
	const unresolved = candidates.map((candidate, index) =>
		validateUnresolvedMediumCandidate(
			candidate,
			`inventory candidates[${index}]`,
		),
	);
	const reviewedExport = validateExport(exportRecord, "exportRecord");
	const approvedTitles = new Set(allowlist.titles);
	const proposed = unresolved.map((candidate) => {
		const include = approvedTitles.has(candidate.title);
		return {
			...candidate,
			include,
			exclusionReason: include ? "" : MEDIUM_RESPONSE_EXCLUSION_REASON,
			classification: include
				? {
						visibility: "public",
						authorship: "original",
						format: "standalone",
					}
				: {
						visibility: "public",
						authorship: "response",
						format: "response",
					},
		};
	});
	return validateMediumInventoryReviewProposal(
		{
			schemaVersion: INVENTORY_SCHEMA_VERSION,
			state: "disposition-review-proposal",
			authority: {
				platform: AUTHORITY_PLATFORM,
				captureFormat: CAPTURE_FORMAT,
			},
			author: { name: AUTHOR_NAME, profileUrl: AUTHOR_PROFILE_URL },
			authorEvidence: {
				source: "official-export-footer",
				matchedCandidateCount: authorEvidenceCount,
			},
			export: reviewedExport,
			candidateCount: proposed.length,
			candidateSetSha256: mediumCandidateSetSha256(proposed),
			expectedCount,
			includedCount: proposed.filter((candidate) => candidate.include).length,
			excludedResponseCount: proposed.filter((candidate) => !candidate.include)
				.length,
			candidates: proposed,
		},
		{ approvedAllowlist: allowlist, expectedCount, expectedCandidateCount },
	);
}
