import assert from "node:assert/strict";
import test from "node:test";
import { validateClaimReviews } from "../claims.js";
import {
	requirePresentationSignoffV2,
	validateContentSignoffsV2,
	validatePresentationSignoffsV2,
} from "../signoffs.js";

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
