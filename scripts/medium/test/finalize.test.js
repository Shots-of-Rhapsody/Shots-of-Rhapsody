import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	buildMediumReviewedInventoryScaffold,
	finalizeMediumReviewedInventory,
} from "../lib/finalize.js";
import { sha256 } from "../lib/integrity.js";
import {
	mediumCandidateSetSha256,
	mediumPresentationSetSha256,
	validateMediumInventory,
} from "../lib/model.js";
import {
	createPendingMediumReviewScaffold,
	reconcileAggregateReleaseTarget,
	replaceAwaitingMediumInventory,
	validateAggregateReviewIdentitySets,
	verifyMediumSummaryFallbackEvidence,
} from "../lib/pipeline.js";
import { buildMediumInventoryReviewProposal } from "../lib/review.js";
import { buildPendingMediumReviewScaffold } from "../lib/review-scaffold.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const USER_FALLBACK =
	"In a system where structure keeps the peace but limits the self, true freedom remains both desired and impossible.";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function unresolvedCandidate() {
	return {
		suggestedSlug: "what-we-call-freedom-isnt-really-freedom",
		title: "What We Call Freedom Isn’t Really Freedom",
		descriptionCandidate: null,
		exportSummaryCandidate: null,
		displayTitleCandidate: "The Architecture of\u00a0Freedom",
		displaySubtitleCandidate: "An exact authored subtitle.",
		seriesLineCandidate:
			"A Ledger Series article on liberty, order, and the boundaries of choice.",
		publishedAtCandidate: "2025-04-01T12:00:00.000Z",
		canonicalUrlCandidate:
			"https://medium.com/@ShotsOfRhapsody/what-we-call-freedom-isnt-really-freedom-0123456789ab",
		sourcePath:
			"posts/2025-04-01_What-We-Call-Freedom-Isnt-Really-Freedom-0123456789ab.html",
		sourceSha256: DIGEST,
		include: null,
		exclusionReason: "",
		classification: { visibility: null, authorship: null, format: null },
	};
}

function fixture() {
	const candidate = unresolvedCandidate();
	const candidates = [candidate];
	const approvedAllowlist = {
		schemaVersion: 1,
		expectedCount: 1,
		expectedCandidateCount: 1,
		exportSha256: DIGEST,
		candidateSetSha256: mediumCandidateSetSha256(candidates),
		titles: [candidate.title],
	};
	const proposal = buildMediumInventoryReviewProposal({
		candidates,
		approvedAllowlist,
		exportRecord: {
			fileName: "medium-export.zip",
			sha256: DIGEST,
			capturedAt: "2026-07-26T12:00:00.000Z",
		},
		authorEvidenceCount: 1,
		expectedCount: 1,
		expectedCandidateCount: 1,
	});
	const heroAssetLedger = {
		exportSha256: DIGEST,
		candidateSetSha256: approvedAllowlist.candidateSetSha256,
		acquisitionManifestSha256: DIGEST,
		itemCount: 1,
		items: [
			{
				slug: candidate.suggestedSlug,
				title: candidate.title,
				canonicalUrl: candidate.canonicalUrlCandidate,
				capture: {
					sha256: DIGEST,
					mimeType: "image/webp",
					byteSize: 100,
					width: 1800,
					height: 1800,
				},
				siteReady: {
					sha256: DIGEST,
					mimeType: "image/webp",
					byteSize: 200,
					width: 1800,
					height: 1800,
				},
				pixels: { sha256: DIGEST },
			},
		],
	};
	const heroChecklist = {
		export: {
			sha256: DIGEST,
			candidateSetSha256: approvedAllowlist.candidateSetSha256,
		},
		approvedTitleCount: 1,
		items: [
			{
				slug: candidate.suggestedSlug,
				title: candidate.title,
				canonicalUrl: candidate.canonicalUrlCandidate,
				sourcePath: candidate.sourcePath,
				exportedHero: {
					sourceUrl: "https://cdn-images-1.medium.com/max/800/hero.webp",
					alt: { present: false, value: null },
					caption: { present: false, value: null },
				},
			},
		],
	};
	const scaffold = buildMediumReviewedInventoryScaffold({
		proposal,
		approvedAllowlist,
		heroAssetLedger,
		heroChecklist,
		expectedCount: 1,
		expectedCandidateCount: 1,
	});
	return { candidate, scaffold };
}

function fallbackRecord(scaffold, summary = USER_FALLBACK) {
	return {
		schemaVersion: 1,
		proposalSha256: scaffold.proposalSha256,
		presentationSetSha256: scaffold.presentationSetSha256,
		fallbacks: [
			{
				slug: "what-we-call-freedom-isnt-really-freedom",
				summary,
			},
		],
	};
}

test("reviewed inventory scaffold preserves title roles and requests only missing summary input", () => {
	const { candidate, scaffold } = fixture();
	assert.equal(scaffold.presentationSetVersion, 1);
	assert.equal(
		scaffold.presentationSetSha256,
		mediumPresentationSetSha256(scaffold.candidates),
	);
	assert.deepEqual(scaffold.pendingSummarySlugs, [candidate.suggestedSlug]);
	assert.equal(scaffold.articles[0].exportTitle, candidate.title);
	assert.equal(scaffold.articles[0].title, candidate.displayTitleCandidate);
	assert.equal(scaffold.articles[0].exportSummary, null);
	assert.equal(scaffold.articles[0].summary, null);
	assert.equal(Object.hasOwn(scaffold, "reviewer"), false);
	assert.equal(Object.hasOwn(scaffold, "approved"), false);
});

test("exact author fallback finalizes public summary without inventing an exported summary or signoff", () => {
	const { scaffold } = fixture();
	const inventory = finalizeMediumReviewedInventory({
		scaffold,
		summaryFallbacks: fallbackRecord(scaffold),
	});
	assert.equal(inventory.articles[0].exportSummary, null);
	assert.equal(inventory.articles[0].summary, USER_FALLBACK);
	assert.equal(inventory.articles[0].description, USER_FALLBACK);
	assert.equal(Object.hasOwn(inventory, "reviewer"), false);
	assert.doesNotThrow(() => validateMediumInventory(inventory));
});

test("summary fallback is hash-bound and cannot broaden into unrelated input", () => {
	const { scaffold } = fixture();
	const wrongBinding = fallbackRecord(scaffold);
	wrongBinding.presentationSetSha256 = `sha256:${"0".repeat(64)}`;
	assert.throws(
		() =>
			finalizeMediumReviewedInventory({
				scaffold,
				summaryFallbacks: wrongBinding,
			}),
		/not bound to the current proposal/u,
	);
	const extra = fallbackRecord(scaffold);
	extra.fallbacks.push({ slug: "unrelated", summary: "Not allowed." });
	assert.throws(
		() =>
			finalizeMediumReviewedInventory({
				scaffold,
				summaryFallbacks: extra,
			}),
		/exactly the source-missing summaries|repeat/u,
	);
});

async function createCommittedFallbackFixture(context, fallbackValue) {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), "medium-fallback-"));
	context.after(() => rm(repoRoot, { recursive: true, force: true }));
	const provenanceRoot = path.join(repoRoot, "provenance", "medium");
	await mkdir(provenanceRoot, { recursive: true });
	await writeFile(
		path.join(provenanceRoot, "approved-titles.v1.json"),
		await readFile(
			path.join(REPO_ROOT, "provenance", "medium", "approved-titles.v1.json"),
		),
	);
	if (fallbackValue !== undefined) {
		await writeFile(
			path.join(provenanceRoot, "summary-fallbacks.v1.json"),
			`${JSON.stringify(fallbackValue, null, "\t")}\n`,
		);
	}
	return repoRoot;
}

async function committedFallbackFixtureValues() {
	const [inventoryValue, fallbackValue] = await Promise.all([
		readFile(
			path.join(REPO_ROOT, "provenance", "medium", "inventory.json"),
			"utf8",
		).then(JSON.parse),
		readFile(
			path.join(REPO_ROOT, "provenance", "medium", "summary-fallbacks.v1.json"),
			"utf8",
		).then(JSON.parse),
	]);
	return { inventoryValue, fallbackValue };
}

test("committed summary fallback evidence is required and bound to source-null summaries", async (context) => {
	const { inventoryValue, fallbackValue } =
		await committedFallbackFixtureValues();
	const repoRoot = await createCommittedFallbackFixture(context, fallbackValue);
	const result = await verifyMediumSummaryFallbackEvidence({
		repoRoot,
		inventoryValue,
	});
	assert.equal(result.fallbackCount, 1);
	assert.equal(
		result.fallbacks.get("what-we-call-freedom-isnt-really-freedom"),
		USER_FALLBACK,
	);
});

test("summary fallback verification rejects deletion", async (context) => {
	const { inventoryValue } = await committedFallbackFixtureValues();
	const repoRoot = await createCommittedFallbackFixture(context);
	await assert.rejects(
		verifyMediumSummaryFallbackEvidence({ repoRoot, inventoryValue }),
		/Committed Medium summary fallbacks is missing/u,
	);
});

test("summary fallback verification rejects mutation", async (context) => {
	const { inventoryValue, fallbackValue } =
		await committedFallbackFixtureValues();
	fallbackValue.fallbacks[0].summary = "A changed and unapproved summary.";
	const repoRoot = await createCommittedFallbackFixture(context, fallbackValue);
	await assert.rejects(
		verifyMediumSummaryFallbackEvidence({ repoRoot, inventoryValue }),
		/differs from the reviewed inventory/u,
	);
});

test("summary fallback verification rejects extra records", async (context) => {
	const { inventoryValue, fallbackValue } =
		await committedFallbackFixtureValues();
	fallbackValue.fallbacks.push({
		slug: "unrelated",
		summary: "This record does not resolve a source-missing summary.",
	});
	const repoRoot = await createCommittedFallbackFixture(context, fallbackValue);
	await assert.rejects(
		verifyMediumSummaryFallbackEvidence({ repoRoot, inventoryValue }),
		/must resolve exactly the source-missing summaries/u,
	);
});

test("aggregate completion uses the release target instead of an empty Medium placeholder", () => {
	assert.throws(
		() =>
			reconcileAggregateReleaseTarget({
				target: {
					schemaVersion: 2,
					release: "v1.0.0",
					expected: {
						archiveWriting: 11,
						mediumWriting: 24,
						podcastEpisodes: 1,
					},
				},
				archive: { importedCount: 11, complete: true },
				medium: {
					importedCount: 0,
					expectedCount: 0,
					complete: false,
				},
			}),
		/archive 11\/11, Medium 0\/24/u,
	);
});

test("aggregate review evidence accepts only the exact 24-writing and one-podcast identity set", () => {
	const mediumSlugs = Array.from(
		{ length: 24 },
		(_, index) => `essay-${String(index + 1).padStart(2, "0")}`,
	);
	const claimReviews = mediumSlugs.map((slug) => ({ slug }));
	const contentSignoffs = [
		...mediumSlugs.map((slug) => ({ slug, kind: "writing" })),
		{ slug: "modular-ethics", kind: "podcast" },
	];
	assert.deepEqual(
		validateAggregateReviewIdentitySets({
			mediumSlugs,
			claimReviews,
			contentSignoffs,
		}),
		{ claimReviewCount: 24, contentSignoffCount: 25 },
	);

	for (const changedClaims of [
		claimReviews.slice(1),
		[...claimReviews, { slug: "excluded-response" }],
	]) {
		assert.throws(
			() =>
				validateAggregateReviewIdentitySets({
					mediumSlugs,
					claimReviews: changedClaims,
					contentSignoffs,
				}),
			/Medium claim reviews must exactly match/u,
		);
	}
	for (const changedSignoffs of [
		contentSignoffs.slice(1),
		[...contentSignoffs, { slug: "excluded-response", kind: "writing" }],
		contentSignoffs.map((entry, index) =>
			index === 0 ? { ...entry, kind: "podcast" } : entry,
		),
		contentSignoffs.filter(
			(entry) => `${entry.kind}:${entry.slug}` !== "podcast:modular-ethics",
		),
	]) {
		assert.throws(
			() =>
				validateAggregateReviewIdentitySets({
					mediumSlugs,
					claimReviews,
					contentSignoffs: changedSignoffs,
				}),
			/Content signoffs must exactly match/u,
		);
	}
});

test("review scaffold carries current hashes but cannot impersonate human approval", () => {
	const scaffold = buildPendingMediumReviewScaffold({
		schemaVersion: 1,
		state: "active",
		authority: { platform: "Medium", captureFormat: "account-export-zip" },
		author: {
			name: "Tai Song",
			profileUrl: "https://medium.com/@ShotsOfRhapsody",
		},
		inventoryPath: "provenance/medium/inventory.json",
		inventorySha256: DIGEST,
		presentationSetVersion: 1,
		presentationSetSha256: DIGEST,
		articles: [
			{
				slug: "exact-essay",
				hashes: { rawSource: DIGEST, markdown: DIGEST },
				assets: [{ sha256: `sha256:${"b".repeat(64)}` }],
			},
		],
		bySlug: new Map(),
	});
	assert.equal(scaffold.articleCount, 1);
	assert.equal(scaffold.articles[0].sourceSha256, DIGEST);
	assert.equal(scaffold.articles[0].claimReview.reviewer, null);
	assert.equal(scaffold.articles[0].claimReview.outcome, "pending");
	assert.equal(
		scaffold.articles[0].claimReview.noMaterialClaimsRationale,
		null,
	);
	assert.equal(scaffold.articles[0].contentSignoff.reviewer, null);
	assert.equal(scaffold.articles[0].contentSignoff.accuracy, "pending");
	assert.equal(scaffold.articles[0].contentSignoff.rights, "pending");
});

test("active manifest produces a pending review scaffold through the repository path", async (context) => {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), "medium-scaffold-"));
	context.after(() => rm(repoRoot, { recursive: true, force: true }));
	const manifestPath = path.join(
		repoRoot,
		"provenance",
		"medium",
		"manifest.json",
	);
	await mkdir(path.dirname(manifestPath), { recursive: true });
	const manifest = {
		schemaVersion: 1,
		state: "active",
		authority: { platform: "Medium", captureFormat: "account-export-zip" },
		author: {
			name: "Tai Song",
			profileUrl: "https://medium.com/@ShotsOfRhapsody",
		},
		inventoryPath: "provenance/medium/inventory.json",
		inventorySha256: DIGEST,
		presentationSetVersion: 1,
		presentationSetSha256: DIGEST,
		articles: [
			{
				slug: "exact-essay",
				capturedAt: "2026-07-26T12:00:00.000Z",
				canonicalUrl:
					"https://medium.com/@ShotsOfRhapsody/exact-essay-0123456789ab",
				paths: {
					snapshot: "provenance/medium/posts/exact-essay.json",
					markdown: "src/content/posts/exact-essay/index.md",
				},
				hashes: {
					rawExport: DIGEST,
					rawSource: DIGEST,
					snapshot: DIGEST,
					markdown: DIGEST,
					bodyText: DIGEST,
				},
				content: {
					title: "Authored title",
					subtitle: "Authored subtitle.",
					seriesLine: "A Ledger Series article on exact fixtures.",
					bodyBlockCount: 1,
				},
				assets: [
					{
						id: "hero",
						role: "hero",
						path: "src/content/posts/exact-essay/hero.webp",
						sha256: DIGEST,
						acquisitionManifestSha256: DIGEST,
						captureSha256: DIGEST,
						pixelSha256: DIGEST,
						mimeType: "image/webp",
						width: 1200,
						height: 1200,
						byteSize: 123,
					},
				],
			},
		],
	};
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	const result = await createPendingMediumReviewScaffold({
		repoRoot,
		write: true,
	});
	assert.equal(result.mode, "write");
	assert.equal(result.scaffold.articleCount, 1);
	assert.equal(result.scaffold.articles[0].slug, "exact-essay");
	const written = JSON.parse(
		await readFile(
			path.join(repoRoot, ".medium-import", "pending-review-scaffolds.json"),
			"utf8",
		),
	);
	assert.deepEqual(written, result.scaffold);
	await assert.rejects(
		createPendingMediumReviewScaffold({ repoRoot, write: true }),
		/already exists/u,
	);
});

test("inventory promotion replaces only an awaiting-export placeholder", async (context) => {
	const { scaffold } = fixture();
	const inventory = finalizeMediumReviewedInventory({
		scaffold,
		summaryFallbacks: fallbackRecord(scaffold),
	});
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), "medium-finalize-"));
	context.after(() => rm(repoRoot, { recursive: true, force: true }));
	const inventoryPath = path.join(
		repoRoot,
		"provenance",
		"medium",
		"inventory.json",
	);
	await mkdir(path.dirname(inventoryPath), { recursive: true });
	const awaiting = {
		schemaVersion: 1,
		state: "awaiting-export",
		authority: { platform: "Medium", captureFormat: "account-export-zip" },
		author: {
			name: "Tai Song",
			profileUrl: "https://medium.com/@ShotsOfRhapsody",
		},
		export: null,
		candidateCount: 0,
		candidateSetSha256: null,
		candidates: [],
		expectedCount: 0,
		articles: [],
	};
	await writeFile(inventoryPath, `${JSON.stringify(awaiting, null, 2)}\n`);
	await replaceAwaitingMediumInventory(repoRoot, inventory);
	const written = validateMediumInventory(
		JSON.parse(await readFile(inventoryPath, "utf8")),
	);
	assert.equal(written.state, "reviewed");
	await assert.rejects(
		replaceAwaitingMediumInventory(repoRoot, inventory),
		/not the known awaiting-export placeholder/u,
	);
	assert.equal(
		sha256(await readFile(inventoryPath)),
		sha256(await readFile(inventoryPath)),
	);
});
