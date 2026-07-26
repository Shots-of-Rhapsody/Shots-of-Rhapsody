import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	validateMediumHeroAcquisition,
	validateMediumHeroAssetLedger,
} from "../lib/acquisition.js";
import { DEFAULT_REPO_ROOT, serializeJson } from "../lib/contract.js";
import { sha256 } from "../lib/integrity.js";
import { verifyMediumArticles } from "../lib/pipeline.js";

const approvedPath = path.join(
	DEFAULT_REPO_ROOT,
	"provenance",
	"medium",
	"approved-titles.v1.json",
);
const assetLedgerPath = path.join(
	DEFAULT_REPO_ROOT,
	"provenance",
	"medium",
	"hero-assets.v1.json",
);

async function committedEvidence() {
	const [approved, assetLedgerValue] = await Promise.all([
		readFile(approvedPath, "utf8").then(JSON.parse),
		readFile(assetLedgerPath, "utf8").then(JSON.parse),
	]);
	return {
		approved,
		assetLedgerValue,
		assetLedger: validateMediumHeroAssetLedger(assetLedgerValue, approved),
	};
}

function acquisitionFor(assetLedger) {
	return {
		schemaVersion: 1,
		state: "captured-unreviewed",
		captureMethod: "logged-in Medium article page via pageAssets",
		capturePolicy: {
			rawCaptureUse: "ignored-verification-evidence-only",
			websiteInput: "sanitized-copy-only",
			highestObservedResponsiveCandidate: "resize:fit:4800/format:webp",
			viewportCssPixels: { width: 4800, height: 3000 },
			claim:
				"These are the highest responsive bytes observed on each article page, not claimed to be the original upload bytes.",
		},
		export: {
			sha256: assetLedger.exportSha256,
			candidateSetSha256: assetLedger.candidateSetSha256,
		},
		itemCount: assetLedger.itemCount,
		items: assetLedger.items.map((item, index) => ({
			slug: item.slug,
			storyId: item.storyId,
			approvedExportTitle: item.title,
			currentMediumTitle: item.title,
			canonicalUrl: item.canonicalUrl,
			heroImageId: item.heroImageId,
			observedUrl: item.observedUrl,
			contentType: item.capture.mimeType,
			width: item.capture.width,
			height: item.capture.height,
			byteSize: item.capture.byteSize,
			sha256: item.capture.sha256,
			localPath: `.medium-import/raw/assets/${item.slug}/hero-medium.webp`,
			capturedAt: `2026-07-26T08:${String(index).padStart(2, "0")}:00.000Z`,
		})),
	};
}

function validateSyntheticAcquisition(acquisition, assetLedger) {
	const acquisitionManifestSha256 = sha256(
		Buffer.from(serializeJson(acquisition), "utf8"),
	);
	return validateMediumHeroAcquisition(acquisition, {
		assetLedger: {
			...assetLedger,
			acquisitionManifestSha256,
		},
		acquisitionManifestSha256,
	});
}

test("committed Medium hero ledger binds all 24 approved titles in order", async () => {
	const { approved, assetLedger } = await committedEvidence();
	assert.equal(assetLedger.itemCount, 24);
	assert.deepEqual(
		assetLedger.items.map((item) => item.title),
		approved.titles,
	);
	assert.equal(new Set(assetLedger.items.map((item) => item.slug)).size, 24);
	assert.equal(new Set(assetLedger.items.map((item) => item.storyId)).size, 24);
	assert.equal(
		new Set(assetLedger.items.map((item) => item.heroImageId)).size,
		24,
	);
	assert.equal(
		new Set(assetLedger.items.map((item) => item.canonicalUrl)).size,
		24,
	);
});

test("exact 24-item acquisition ledger validates against the durable anchor", async () => {
	const { assetLedger } = await committedEvidence();
	const acquisition = acquisitionFor(assetLedger);
	const result = validateSyntheticAcquisition(acquisition, assetLedger);
	assert.equal(result.itemCount, 24);
	assert.deepEqual(
		result.items.map((item) => item.slug),
		assetLedger.items.map((item) => item.slug),
	);
});

test("24-item acquisition ledger rejects every identity, path, and byte-evidence mismatch", async (t) => {
	const { assetLedger } = await committedEvidence();
	const original = acquisitionFor(assetLedger);
	const mutations = [
		[
			"export SHA",
			(value) => (value.export.sha256 = `sha256:${"0".repeat(64)}`),
		],
		[
			"candidate-set SHA",
			(value) => (value.export.candidateSetSha256 = `sha256:${"0".repeat(64)}`),
		],
		[
			"item order",
			(value) =>
				([value.items[0], value.items[1]] = [value.items[1], value.items[0]]),
		],
		[
			"duplicate item",
			(value) => (value.items[1] = structuredClone(value.items[0])),
		],
		["slug", (value) => (value.items[0].slug = "wrong-slug")],
		["story ID", (value) => (value.items[0].storyId = "000000000000")],
		[
			"hero image ID",
			(value) => (value.items[0].heroImageId = "1*wrong@2x.jpeg"),
		],
		[
			"canonical URL",
			(value) =>
				(value.items[0].canonicalUrl =
					"https://medium.com/@ShotsOfRhapsody/wrong-slug-000000000000"),
		],
		[
			"observed URL",
			(value) =>
				(value.items[0].observedUrl =
					"https://miro.medium.com/v2/resize:fit:4800/format:webp/1*wrong@2x.jpeg"),
		],
		[
			"local path",
			(value) =>
				(value.items[0].localPath =
					".medium-import/raw/assets/wrong/hero-medium.webp"),
		],
		[
			"capture SHA",
			(value) => (value.items[0].sha256 = `sha256:${"0".repeat(64)}`),
		],
		["byte size", (value) => (value.items[0].byteSize += 1)],
		["width", (value) => (value.items[0].width += 1)],
		["height", (value) => (value.items[0].height += 1)],
	];

	for (const [name, mutate] of mutations) {
		await t.test(name, () => {
			const changed = structuredClone(original);
			mutate(changed);
			assert.throws(() => validateSyntheticAcquisition(changed, assetLedger));
		});
	}
});

test("acquisition manifest hash must equal the durable anchor", async () => {
	const { assetLedger } = await committedEvidence();
	const acquisition = acquisitionFor(assetLedger);
	const acquisitionManifestSha256 = sha256(
		Buffer.from(serializeJson(acquisition), "utf8"),
	);
	assert.throws(
		() =>
			validateMediumHeroAcquisition(acquisition, {
				assetLedger: {
					...assetLedger,
					acquisitionManifestSha256: `sha256:${"f".repeat(64)}`,
				},
				acquisitionManifestSha256,
			}),
		/acquisition manifest SHA-256 differs/u,
	);
});

test("asset planning cannot impersonate imported article completeness", async (context) => {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), "medium-planning-"));
	context.after(() => rm(repoRoot, { recursive: true, force: true }));
	const provenanceRoot = path.join(repoRoot, "provenance", "medium");
	await mkdir(provenanceRoot, { recursive: true });
	const awaitingInventory = {
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
	const awaitingManifest = {
		schemaVersion: 1,
		state: "awaiting-export",
		authority: { platform: "Medium", captureFormat: "account-export-zip" },
		author: {
			name: "Tai Song",
			profileUrl: "https://medium.com/@ShotsOfRhapsody",
		},
		inventoryPath: "provenance/medium/inventory.json",
		inventorySha256: null,
		articles: [],
	};
	await Promise.all([
		writeFile(
			path.join(provenanceRoot, "approved-titles.v1.json"),
			await readFile(approvedPath),
		),
		writeFile(
			path.join(provenanceRoot, "hero-assets.v1.json"),
			await readFile(assetLedgerPath),
		),
		writeFile(
			path.join(provenanceRoot, "inventory.json"),
			`${JSON.stringify(awaitingInventory, null, 2)}\n`,
		),
		writeFile(
			path.join(provenanceRoot, "manifest.json"),
			`${JSON.stringify(awaitingManifest, null, 2)}\n`,
		),
	]);
	const result = await verifyMediumArticles({
		repoRoot,
		requireComplete: false,
	});
	assert.equal(result.importedCount, 0);
	assert.equal(result.expectedCount, 0);
	assert.equal(result.plannedAssetCount, 24);
	assert.equal(result.complete, false);
});
