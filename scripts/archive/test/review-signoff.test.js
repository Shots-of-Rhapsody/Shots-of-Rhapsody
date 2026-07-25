import assert from "node:assert/strict";
import test from "node:test";
import {
	evaluateReviewSignoffs,
	REVIEW_SIGNOFF_VERSION,
	validateReviewSignoffs,
} from "../lib/review-signoff.js";

const manifest = {
	articles: [
		{
			slug: "first-work",
			capturedAt: "2026-01-01T00:00:00.000Z",
			hashes: {
				snapshot: `sha256:${"1".repeat(64)}`,
				markdown: `sha256:${"2".repeat(64)}`,
				image: `sha256:${"3".repeat(64)}`,
			},
		},
		{
			slug: "second-work",
			capturedAt: "2026-01-02T00:00:00.000Z",
			hashes: {
				snapshot: `sha256:${"4".repeat(64)}`,
				markdown: `sha256:${"5".repeat(64)}`,
				image: `sha256:${"6".repeat(64)}`,
			},
		},
	],
};

function signoff(article, reviewedAt) {
	return {
		slug: article.slug,
		snapshotSha256: article.hashes.snapshot,
		markdownSha256: article.hashes.markdown,
		imageSha256: article.hashes.image,
		reviewedCommit: "a".repeat(40),
		reviewer: "Tai Song",
		reviewedAt,
		textAccuracy: "passed",
		presentation: "passed",
		notes: "Compared side-by-side with the author master.",
	};
}

function completeRecord() {
	return {
		version: REVIEW_SIGNOFF_VERSION,
		articles: [
			signoff(manifest.articles[0], "2026-01-03T00:00:00.000Z"),
			signoff(manifest.articles[1], "2026-01-03T01:00:00.000Z"),
		],
	};
}

test("ReviewSignoffV1 accepts exact per-article hash-bound reviews", () => {
	assert.deepEqual(
		validateReviewSignoffs({
			record: completeRecord(),
			manifest,
			now: new Date("2026-01-04T00:00:00.000Z"),
		}),
		[],
	);
});

test("ReviewSignoffV1 requires one reviewed commit for the complete review", () => {
	const record = completeRecord();
	record.articles[1].reviewedCommit = "b".repeat(40);
	assert.deepEqual(
		validateReviewSignoffs({
			record,
			manifest,
			now: new Date("2026-01-04T00:00:00.000Z"),
		}),
		["human review signoffs must all use the same reviewedCommit"],
	);
});

test("ReviewSignoffV1 fails closed while the pending template is empty", () => {
	assert.match(
		validateReviewSignoffs({
			record: { version: 1, articles: [] },
			manifest,
			now: new Date("2026-01-04T00:00:00.000Z"),
		}).join("\n"),
		/0 signoffs|missing first-work/u,
	);
});

test("ReviewSignoffV1 requires Tai Song, passed reviews, and canonical evidence", () => {
	const record = completeRecord();
	record.articles[0].reviewer = "Example Reviewer";
	record.articles[0].reviewedCommit = "short";
	record.articles[1].presentation = "pending";
	record.articles[1].notes =
		"C:\\Users\\someone\\.proton-import\\raw\\second-work\\page.html";
	assert.match(
		validateReviewSignoffs({
			record,
			manifest,
			now: new Date("2026-01-04T00:00:00.000Z"),
		}).join("\n"),
		/private|full lowercase Git SHA|reviewer must be Tai Song|presentation/u,
	);
});

test("ReviewSignoffV1 identifies the exact article whose evidence changed", () => {
	const changedManifest = structuredClone(manifest);
	changedManifest.unrelatedMetadata = "does not invalidate reviews";
	assert.deepEqual(
		validateReviewSignoffs({
			record: completeRecord(),
			manifest: changedManifest,
			now: new Date("2026-01-04T00:00:00.000Z"),
		}),
		[],
	);

	changedManifest.articles[1].hashes.markdown = `sha256:${"f".repeat(64)}`;
	const failures = validateReviewSignoffs({
		record: completeRecord(),
		manifest: changedManifest,
		now: new Date("2026-01-04T00:00:00.000Z"),
	});
	assert.deepEqual(failures, [
		"review signoff 2 markdownSha256 differs from the manifest",
	]);
});

test("release signoff gate requires an exact 11-article record", () => {
	const releaseManifest = {
		articles: Array.from({ length: 11 }, (_, index) => ({
			slug: `work-${String(index + 1).padStart(2, "0")}`,
			hashes: {
				snapshot: `sha256:${"1".repeat(64)}`,
				markdown: `sha256:${"2".repeat(64)}`,
				image: `sha256:${"3".repeat(64)}`,
			},
		})),
	};
	const pendingRecord = { version: REVIEW_SIGNOFF_VERSION, articles: [] };
	const completeReleaseRecord = {
		version: REVIEW_SIGNOFF_VERSION,
		articles: releaseManifest.articles.map((article) =>
			signoff(article, "2026-01-03T00:00:00.000Z"),
		),
	};
	const now = new Date("2026-01-04T00:00:00.000Z");

	assert.deepEqual(
		evaluateReviewSignoffs({
			record: pendingRecord,
			manifest: releaseManifest,
			now,
		}),
		{ status: "pending", failures: [] },
	);
	assert.match(
		evaluateReviewSignoffs({
			record: pendingRecord,
			manifest: releaseManifest,
			requireSignoff: true,
			now,
		}).failures.join("\n"),
		/0 signoffs|missing work-01/u,
	);
	assert.deepEqual(
		evaluateReviewSignoffs({
			record: completeReleaseRecord,
			manifest: releaseManifest,
			requireSignoff: true,
			now,
		}),
		{ status: "complete", failures: [] },
	);

	const incompleteReleaseRecord = structuredClone(completeReleaseRecord);
	incompleteReleaseRecord.articles.pop();
	assert.match(
		evaluateReviewSignoffs({
			record: incompleteReleaseRecord,
			manifest: releaseManifest,
			requireSignoff: true,
			now,
		}).failures.join("\n"),
		/10 signoffs|missing work-11/u,
	);
});
