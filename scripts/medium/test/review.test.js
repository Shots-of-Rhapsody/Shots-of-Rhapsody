import assert from "node:assert/strict";
import test from "node:test";
import { extractMediumAuthorEvidence } from "../lib/html.js";
import { mediumCandidateSetSha256 } from "../lib/model.js";
import {
	buildMediumInventoryReviewProposal,
	MEDIUM_RESPONSE_EXCLUSION_REASON,
	validateMediumInventoryReviewProposal,
} from "../lib/review.js";

const EXPORT_DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;

function candidate({
	title,
	slug,
	id,
	description = "Exact export description.",
	exportSummary = "Exact outer export summary.",
	displayTitle = title,
	displaySubtitle = "Exact public subtitle.",
	seriesLine = "A Ledger Series article on exact evidence.",
}) {
	return {
		suggestedSlug: slug,
		title,
		descriptionCandidate: description,
		exportSummaryCandidate: exportSummary,
		displayTitleCandidate: displayTitle,
		displaySubtitleCandidate: displaySubtitle,
		seriesLineCandidate: seriesLine,
		publishedAtCandidate: "2025-04-01T12:00:00.000Z",
		canonicalUrlCandidate: `https://medium.com/@ShotsOfRhapsody/${slug}-${id}`,
		sourcePath: `posts/2025-04-01_${slug}-${id}.html`,
		sourceSha256: `sha256:${id.padEnd(64, "0")}`,
		include: null,
		exclusionReason: "",
		classification: { visibility: null, authorship: null, format: null },
	};
}

function fixture() {
	const candidates = [
		candidate({ title: "Approved Essay", slug: "approved-essay", id: "1" }),
		candidate({
			title: "Exact response text…",
			slug: "exact-response-text",
			id: "2",
			description: null,
			exportSummary: null,
			displayTitle: null,
			displaySubtitle: null,
			seriesLine: null,
		}),
	];
	const approvedAllowlist = {
		schemaVersion: 1,
		expectedCount: 1,
		expectedCandidateCount: 2,
		exportSha256: EXPORT_DIGEST,
		candidateSetSha256: mediumCandidateSetSha256(candidates),
		titles: ["Approved Essay"],
	};
	const options = { expectedCount: 1, expectedCandidateCount: 2 };
	const proposal = buildMediumInventoryReviewProposal({
		candidates,
		approvedAllowlist,
		exportRecord: {
			fileName: "medium-export.zip",
			sha256: EXPORT_DIGEST,
			capturedAt: "2026-07-25T14:11:15.789Z",
		},
		authorEvidenceCount: 2,
		...options,
	});
	return { candidates, approvedAllowlist, options, proposal };
}

test("review proposal preserves all candidate evidence and records exact dispositions", () => {
	const { candidates, proposal } = fixture();
	assert.equal(proposal.state, "disposition-review-proposal");
	assert.equal(proposal.candidateCount, 2);
	assert.equal(proposal.includedCount, 1);
	assert.equal(proposal.excludedResponseCount, 1);
	assert.deepEqual(proposal.authorEvidence, {
		source: "official-export-footer",
		matchedCandidateCount: 2,
	});
	assert.equal(Object.hasOwn(proposal, "articles"), false);
	assert.equal(Object.hasOwn(proposal, "reviewer"), false);
	for (const [index, source] of candidates.entries()) {
		for (const field of [
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
		]) {
			assert.equal(proposal.candidates[index][field], source[field]);
		}
	}
	assert.deepEqual(proposal.candidates[0].classification, {
		visibility: "public",
		authorship: "original",
		format: "standalone",
	});
	assert.equal(proposal.candidates[0].exclusionReason, "");
	assert.deepEqual(proposal.candidates[1].classification, {
		visibility: "public",
		authorship: "response",
		format: "response",
	});
	assert.equal(
		proposal.candidates[1].exclusionReason,
		MEDIUM_RESPONSE_EXCLUSION_REASON,
	);
});

test("review proposal keeps export metadata separate from public presentation", () => {
	const { proposal } = fixture();
	const included = proposal.candidates[0];
	assert.equal(included.title, "Approved Essay");
	assert.equal(included.descriptionCandidate, "Exact export description.");
	assert.equal(included.exportSummaryCandidate, "Exact outer export summary.");
	assert.equal(included.displayTitleCandidate, "Approved Essay");
	assert.equal(included.displaySubtitleCandidate, "Exact public subtitle.");
	assert.equal(
		included.seriesLineCandidate,
		"A Ledger Series article on exact evidence.",
	);
	assert.equal(proposal.candidates[1].displayTitleCandidate, null);
	assert.equal(proposal.candidates[1].exportSummaryCandidate, null);
	assert.equal(proposal.candidates[1].displaySubtitleCandidate, null);
	assert.equal(proposal.candidates[1].seriesLineCandidate, null);
});

test("review proposal rejects altered evidence, dispositions, and author counts", () => {
	const { approvedAllowlist, options, proposal } = fixture();
	const alteredEvidence = structuredClone(proposal);
	alteredEvidence.candidates[0].sourceSha256 = OTHER_DIGEST;
	assert.throws(
		() =>
			validateMediumInventoryReviewProposal(alteredEvidence, {
				approvedAllowlist,
				...options,
			}),
		/candidate set differs/u,
	);

	const alteredDisposition = structuredClone(proposal);
	alteredDisposition.candidates[1].classification.format = "standalone";
	assert.throws(
		() =>
			validateMediumInventoryReviewProposal(alteredDisposition, {
				approvedAllowlist,
				...options,
			}),
		/exact public response/u,
	);

	const incompleteAuthorEvidence = structuredClone(proposal);
	incompleteAuthorEvidence.authorEvidence.matchedCandidateCount = 1;
	assert.throws(
		() =>
			validateMediumInventoryReviewProposal(incompleteAuthorEvidence, {
				approvedAllowlist,
				...options,
			}),
		/complete source author evidence/u,
	);
});

test("included essays require the complete public presentation shell", () => {
	const { approvedAllowlist, options, proposal } = fixture();
	for (const field of [
		"displayTitleCandidate",
		"displaySubtitleCandidate",
		"seriesLineCandidate",
	]) {
		const missing = structuredClone(proposal);
		missing.candidates[0][field] = null;
		assert.throws(
			() =>
				validateMediumInventoryReviewProposal(missing, {
					approvedAllowlist,
					...options,
				}),
			/public, original, and standalone/u,
		);
	}

	const wrongSeries = structuredClone(proposal);
	wrongSeries.candidates[0].seriesLineCandidate = "An unrelated introduction.";
	assert.throws(
		() =>
			validateMediumInventoryReviewProposal(wrongSeries, {
				approvedAllowlist,
				...options,
			}),
		/must begin with "A Ledger Series article"/u,
	);
});

test("review proposal requires the exact bound export and approved title set", () => {
	const { candidates, approvedAllowlist, options } = fixture();
	assert.throws(
		() =>
			buildMediumInventoryReviewProposal({
				candidates,
				approvedAllowlist,
				exportRecord: {
					fileName: "medium-export.zip",
					sha256: OTHER_DIGEST,
					capturedAt: "2026-07-25T14:11:15.789Z",
				},
				authorEvidenceCount: 2,
				...options,
			}),
		/export differs/u,
	);
	assert.throws(
		() =>
			buildMediumInventoryReviewProposal({
				candidates,
				approvedAllowlist: {
					...approvedAllowlist,
					titles: ["Missing Essay"],
				},
				exportRecord: {
					fileName: "medium-export.zip",
					sha256: EXPORT_DIGEST,
					capturedAt: "2026-07-25T14:11:15.789Z",
				},
				authorEvidenceCount: 2,
				...options,
			}),
		/disposition counts|approved titles/u,
	);
});

test("official export author evidence must uniquely match Tai Song", () => {
	const credit =
		'<a href="https://medium.com/@ShotsOfRhapsody" class="p-author h-card">Tai Song</a>';
	const officialExport = (footerContents) =>
		`<html><body><article class="h-entry"><footer><p>${footerContents}</p></footer></article></body></html>`;
	assert.deepEqual(
		extractMediumAuthorEvidence(officialExport(credit), "story"),
		{
			name: "Tai Song",
			profileUrl: "https://medium.com/@ShotsOfRhapsody",
		},
	);
	assert.throws(
		() =>
			extractMediumAuthorEvidence(
				officialExport(`${credit}${credit}`),
				"story",
			),
		/exactly one official Medium author credit inside its article footer/u,
	);
	assert.throws(
		() =>
			extractMediumAuthorEvidence(
				officialExport(
					'<a href="https://medium.com/@ShotsOfRhapsody" class="p-author h-card">Someone Else</a>',
				),
				"story",
			),
		/does not match Tai Song/u,
	);
	assert.throws(
		() =>
			extractMediumAuthorEvidence(
				`<html><body><article class="h-entry"><p>Body.</p></article>${credit}</body></html>`,
				"story",
			),
		/exactly one direct official article footer/u,
	);
});
