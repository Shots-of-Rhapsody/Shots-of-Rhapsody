import assert from "node:assert/strict";
import test from "node:test";
import { validateClaimReviews } from "../claims.js";
import {
	requirePresentationSignoffV2,
	validateContentSignoffsV2,
	validatePresentationSignoffsV2,
} from "../signoffs.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

function claimReviewArticle(overrides = {}) {
	return {
		slug: "essay",
		sourceSha256: DIGEST_B,
		outputSha256: DIGEST_C,
		reviewer: "Tai Song",
		reviewedAt: "2026-07-25T12:00:00.000Z",
		outcome: "passed",
		notes: "",
		claims: [],
		...overrides,
	};
}

function supportedClaim() {
	return {
		id: "claim-one",
		statementSha256: DIGEST_A,
		material: true,
		status: "supported",
		sources: ["https://www.example.gov/primary-source"],
		notes: "The primary source supports the material statement.",
	};
}

test("empty v2 signoff ledgers are valid pending evidence", () => {
	assert.deepEqual(validateContentSignoffsV2({ version: 2, entries: [] }), []);
	assert.deepEqual(
		validatePresentationSignoffsV2({ version: 2, releases: [] }),
		[],
	);
});

test("material unsupported claims block a passed review", () => {
	assert.throws(
		() =>
			validateClaimReviews({
				version: 1,
				articles: [
					{
						slug: "essay",
						sourceSha256: `sha256:${"b".repeat(64)}`,
						outputSha256: `sha256:${"c".repeat(64)}`,
						reviewer: "Tai Song",
						reviewedAt: "2026-07-25T12:00:00.000Z",
						outcome: "passed",
						notes: "Review pending a correction.",
						claims: [
							{
								id: "claim-one",
								statementSha256: `sha256:${"a".repeat(64)}`,
								material: true,
								status: "unsupported",
								sources: [],
								notes: "No primary source found.",
							},
						],
					},
				],
			}),
		/unresolved material claim/u,
	);
});

test("claim-bearing version 1 reviews remain valid without a no-claims rationale", () => {
	const [review] = validateClaimReviews({
		version: 1,
		articles: [claimReviewArticle({ claims: [supportedClaim()] })],
	});

	assert.equal(review.claims.length, 1);
	assert.equal(Object.hasOwn(review, "noMaterialClaimsRationale"), false);
});

test("a passed review cannot omit both reviewed claims and a no-claims rationale", () => {
	assert.throws(
		() =>
			validateClaimReviews({
				version: 1,
				articles: [claimReviewArticle()],
			}),
		/at least one reviewed claim or an explicit noMaterialClaimsRationale/u,
	);
});

test("a passed review can explicitly explain why it has no material claims", () => {
	const rationale =
		"This personal reflection makes no material factual claim requiring source verification.";
	const [review] = validateClaimReviews({
		version: 1,
		articles: [claimReviewArticle({ noMaterialClaimsRationale: rationale })],
	});

	assert.equal(review.claims.length, 0);
	assert.equal(review.noMaterialClaimsRationale, rationale);
});

test("a no-claims rationale must contain non-whitespace text", () => {
	for (const noMaterialClaimsRationale of ["", " \t\r\n", null]) {
		assert.throws(
			() =>
				validateClaimReviews({
					version: 1,
					articles: [claimReviewArticle({ noMaterialClaimsRationale })],
				}),
			/noMaterialClaimsRationale must/u,
		);
	}
});

test("reviewed claims and a no-claims rationale are mutually exclusive", () => {
	assert.throws(
		() =>
			validateClaimReviews({
				version: 1,
				articles: [
					claimReviewArticle({
						claims: [supportedClaim()],
						noMaterialClaimsRationale:
							"This must not accompany a reviewed claim.",
					}),
				],
			}),
		/must not combine reviewed claims with noMaterialClaimsRationale/u,
	);
});

test("content signoffs require exact hashes and genuine passed review", () => {
	assert.throws(
		() =>
			validateContentSignoffsV2({
				version: 2,
				entries: [
					{
						slug: "essay",
						kind: "writing",
						sourceSha256: `sha256:${"a".repeat(64)}`,
						outputSha256: `sha256:${"b".repeat(64)}`,
						assetSha256: [`sha256:${"c".repeat(64)}`],
						reviewer: "Automation",
						reviewedAt: "2026-07-25T12:00:00.000Z",
						accuracy: "passed",
						rights: "passed",
					},
				],
			}),
		/lacks genuine passed review evidence/u,
	);
});

test("content signoffs reject repeated asset evidence", () => {
	const assetSha256 = `sha256:${"c".repeat(64)}`;
	assert.throws(
		() =>
			validateContentSignoffsV2({
				version: 2,
				entries: [
					{
						slug: "episode",
						kind: "podcast",
						sourceSha256: `sha256:${"a".repeat(64)}`,
						outputSha256: `sha256:${"b".repeat(64)}`,
						assetSha256: [assetSha256, assetSha256],
						reviewer: "Tai Song",
						reviewedAt: "2026-07-25T12:00:00.000Z",
						accuracy: "passed",
						rights: "passed",
					},
				],
			}),
		/unique digests/u,
	);
});

test("presentation signoffs require full commit binding", () => {
	assert.throws(
		() =>
			validatePresentationSignoffsV2({
				version: 2,
				releases: [
					{
						release: "v1.1.0",
						reviewedCommit: "abc123",
						rendererSha256: `sha256:${"a".repeat(64)}`,
						siteSha256: `sha256:${"b".repeat(64)}`,
						reviewer: "Tai Song",
						reviewedAt: "2026-07-25T12:00:00.000Z",
						responsive: "passed",
						accessibility: "passed",
					},
				],
			}),
		/full commit SHA/u,
	);
});

test("presentation release binding rejects stale renderer evidence", () => {
	const digestA = `sha256:${"a".repeat(64)}`;
	const digestB = `sha256:${"b".repeat(64)}`;
	const value = {
		version: 2,
		releases: [
			{
				release: "v1.1.0",
				reviewedCommit: "a".repeat(40),
				rendererSha256: digestA,
				siteSha256: digestB,
				reviewer: "Tai Song",
				reviewedAt: "2026-07-25T12:00:00.000Z",
				responsive: "passed",
				accessibility: "passed",
			},
		],
	};
	assert.throws(
		() =>
			requirePresentationSignoffV2(value, {
				release: "v1.1.0",
				reviewedCommit: "a".repeat(40),
				rendererSha256: digestB,
				siteSha256: digestB,
			}),
		/stale rendererSha256/u,
	);
});
