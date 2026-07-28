import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_REPO_ROOT, serializeJson } from "../medium/lib/contract.js";
import { createCaptureScaffold } from "./capture-scaffold.mjs";
import {
	cloudInventoryDigest,
	PROTON_CLI_VERSION,
	PROTON_CLOUD_CAPTURE_SCHEMA_VERSION,
	verifyCloudCaptureAgainstExpected,
} from "./cloud.mjs";
import { expectedMasterRecordsV2 } from "./lib.mjs";
import { assignWindowsSafeCloudNames } from "./names.mjs";
import { createLedgerUpdatePlan, replaceLedgerIfUnchanged } from "./update.mjs";
import {
	PROTON_CAPTURE_SCHEMA_VERSION_V2,
	PROTON_MASTER_SCHEMA_VERSION_V2,
	PROTON_SEMANTIC_MODEL_VERSION,
	v1LedgerSha256,
	validateCaptureV2,
	validateLedgerV2,
	verifyLedgerV2Evidence,
	writeLedgerV2NoOverwrite,
} from "./v2.mjs";

const FIRST_CAPTURED_AT = "2026-07-28T12:34:56.789Z";
const SECOND_CAPTURED_AT = "2026-07-29T12:34:56.789Z";

function digest(index) {
	return `sha256:${index.toString(16).padStart(64, "0")}`;
}

function canonicalSha(value) {
	return `sha256:${createHash("sha256")
		.update(Buffer.from(serializeJson(value), "utf8"))
		.digest("hex")}`;
}

function expectedRecords() {
	return assignWindowsSafeCloudNames([
		...Array.from({ length: 11 }, (_, index) => ({
			slug: `fiction-${String(index + 1).padStart(2, "0")}`,
			masterFolder: "fiction",
			articleTitle: `Fiction: Work ${index + 1}`,
		})),
		...Array.from({ length: 24 }, (_, index) => ({
			slug: `nonfiction-${String(index + 1).padStart(2, "0")}`,
			masterFolder: "nonfiction",
			articleTitle: `Non-Fiction Work ${index + 1}`,
		})),
	]);
}

function finalCloudCapture() {
	const records = expectedRecords().map((record) => ({
		slug: record.slug,
		masterFolder: record.masterFolder,
		observedName: record.cloudName,
		targetCloudName: record.cloudName,
		type: "document",
		status: "exact",
	}));
	const target = cloudInventoryDigest(records, { observed: false });
	return {
		schemaVersion: PROTON_CLOUD_CAPTURE_SCHEMA_VERSION,
		capturedAt: FIRST_CAPTURED_AT,
		cliVersion: PROTON_CLI_VERSION,
		phase: "final",
		observedInventorySha256: target,
		targetInventorySha256: target,
		records,
	};
}

function captureV2() {
	const timestamp = "20260728T123456.789Z";
	return {
		schemaVersion: PROTON_CAPTURE_SCHEMA_VERSION_V2,
		capturedAt: FIRST_CAPTURED_AT,
		cloudInventorySha256: finalCloudCapture().targetInventorySha256,
		records: expectedRecords().map((record) => {
			const base = `.proton-import/raw/${record.masterFolder}/${record.slug}/${timestamp}`;
			return {
				slug: record.slug,
				masterFolder: record.masterFolder,
				articleTitle: record.articleTitle,
				cloudName: record.cloudName,
				exportedAt: FIRST_CAPTURED_AT,
				documentFile: `${base}/document.html`,
				...(record.masterFolder === "fiction"
					? { heroFile: `${base}/hero-original.png` }
					: {}),
			};
		}),
	};
}

function ledgerV2() {
	const cloud = finalCloudCapture();
	return {
		schemaVersion: PROTON_MASTER_SCHEMA_VERSION_V2,
		semanticModelVersion: PROTON_SEMANTIC_MODEL_VERSION,
		expectedCount: 35,
		previousLedgerSha256: digest(900),
		cloudInventory: {
			phase: "final",
			capturedAt: cloud.capturedAt,
			observedSha256: cloud.observedInventorySha256,
			targetSha256: cloud.targetInventorySha256,
		},
		records: expectedRecords().map((record, index) => ({
			slug: record.slug,
			masterFolder: record.masterFolder,
			articleTitle: record.articleTitle,
			cloudName: record.cloudName,
			exportedAt: FIRST_CAPTURED_AT,
			exportSha256: digest(index + 1),
			semanticSha256: digest(index + 101),
			heroSha256: digest(index + 201),
			heroPixelSha256: digest(index + 301),
			heroSourceSha256: digest(index + 401),
			sourceSnapshotSha256: digest(index + 501),
			siteOutputSha256: digest(index + 601),
			bodyBlockCount: index + 1,
		})),
	};
}

let actualLedgerPromise;

function actualBoundLedger() {
	actualLedgerPromise ??= (async () => {
		const expected = await expectedMasterRecordsV2({
			repoRoot: DEFAULT_REPO_ROOT,
		});
		const targetRecords = expected.map((record) => ({
			slug: record.slug,
			masterFolder: record.masterFolder,
			observedName: record.cloudName,
			targetCloudName: record.cloudName,
		}));
		const cloudSha = cloudInventoryDigest(targetRecords, { observed: false });
		return validateLedgerV2(
			{
				schemaVersion: PROTON_MASTER_SCHEMA_VERSION_V2,
				semanticModelVersion: PROTON_SEMANTIC_MODEL_VERSION,
				expectedCount: 35,
				previousLedgerSha256: await v1LedgerSha256({
					repoRoot: DEFAULT_REPO_ROOT,
				}),
				cloudInventory: {
					phase: "final",
					capturedAt: FIRST_CAPTURED_AT,
					observedSha256: cloudSha,
					targetSha256: cloudSha,
				},
				records: expected.map((record, index) => ({
					slug: record.slug,
					masterFolder: record.masterFolder,
					articleTitle: record.articleTitle,
					cloudName: record.cloudName,
					exportedAt: FIRST_CAPTURED_AT,
					exportSha256: digest(1_000 + index),
					semanticSha256: record.semanticSha256,
					heroSha256: record.heroSha256,
					heroPixelSha256: record.heroPixelSha256,
					heroSourceSha256: digest(2_000 + index),
					sourceSnapshotSha256: record.sourceSnapshotSha256,
					siteOutputSha256: record.siteOutputSha256,
					bodyBlockCount: record.bodyBlockCount,
				})),
			},
			{ requireComplete: true },
		);
	})();
	return actualLedgerPromise;
}

function cloudCaptureForLedger(ledger) {
	return {
		schemaVersion: PROTON_CLOUD_CAPTURE_SCHEMA_VERSION,
		capturedAt: ledger.cloudInventory.capturedAt,
		cliVersion: PROTON_CLI_VERSION,
		phase: "final",
		observedInventorySha256: ledger.cloudInventory.observedSha256,
		targetInventorySha256: ledger.cloudInventory.targetSha256,
		records: ledger.records.map((record) => ({
			slug: record.slug,
			masterFolder: record.masterFolder,
			observedName: record.cloudName,
			targetCloudName: record.cloudName,
			type: "document",
			status: "exact",
		})),
	};
}

test("V2 capture requires timestamped paths and exact 11/24 folder counts", () => {
	const capture = captureV2();
	const normalized = validateCaptureV2(capture, { requireComplete: true });
	assert.equal(normalized.records.length, 35);
	assert.equal(
		normalized.records.filter((record) => record.masterFolder === "fiction")
			.length,
		11,
	);

	const flatPath = structuredClone(capture);
	flatPath.records[0].documentFile =
		".proton-import/raw/fiction/fiction-01/document.html";
	assert.throws(
		() => validateCaptureV2(flatPath),
		/canonical sectioned capture path/u,
	);

	const wrongFolders = structuredClone(capture);
	const moved = wrongFolders.records.find(
		(record) => record.masterFolder === "nonfiction",
	);
	moved.masterFolder = "fiction";
	const base = `.proton-import/raw/fiction/${moved.slug}/20260728T123456.789Z`;
	moved.documentFile = `${base}/document.html`;
	moved.heroFile = `${base}/hero-original.png`;
	assert.throws(
		() => validateCaptureV2(wrongFolders, { requireComplete: true }),
		/11 Fiction and 24 Non-Fiction/u,
	);

	const impossibleChronology = structuredClone(capture);
	impossibleChronology.capturedAt = "2026-07-27T12:34:56.789Z";
	assert.throws(
		() => validateCaptureV2(impossibleChronology),
		/precedes exportedAt/u,
	);
});

test("V2 ledger is complete, Windows-safe, V1-bound, and cloud-digest-bound", () => {
	const ledger = ledgerV2();
	const normalized = validateLedgerV2(ledger, { requireComplete: true });
	assert.equal(normalized.records.length, 35);
	assert.equal(normalized.previousLedgerSha256, digest(900));
	assert.ok(
		normalized.records.every(
			(record) => !/[<>:"/\\|?*]/u.test(record.cloudName),
		),
	);

	const wrongCloud = structuredClone(ledger);
	wrongCloud.cloudInventory.targetSha256 = digest(999);
	wrongCloud.cloudInventory.observedSha256 = digest(999);
	assert.throws(
		() => validateLedgerV2(wrongCloud),
		/target cloud inventory digest/u,
	);
});

test("capture scaffold exposes the required timestamp directory contract without approvals", () => {
	const expected = expectedRecords().map((record, index) => ({
		...record,
		sourceSnapshotSha256: digest(index + 1),
		siteOutputSha256: digest(index + 101),
		heroSha256: digest(index + 201),
		heroPixelSha256: digest(index + 301),
	}));
	const scaffold = createCaptureScaffold({
		generatedAt: FIRST_CAPTURED_AT,
		cloudCapture: finalCloudCapture(),
		expected,
	});
	assert.equal(scaffold.records.length, 35);
	assert.equal(scaffold.records[0].exportedAt, null);
	assert.match(
		scaffold.records[0].documentFile,
		/\/fiction-01\/<YYYYMMDDTHHmmss\.sssZ>\/document\.html$/u,
	);
	assert.match(
		scaffold.records[0].heroFile,
		/<YYYYMMDDTHHmmss\.sssZ>\/hero-original\.png$/u,
	);
	assert.equal(
		"heroFile" in
			scaffold.records.find((record) => record.masterFolder === "nonfiction"),
		false,
	);
	assert.doesNotMatch(serializeJson(scaffold), /reviewer|approved|passed/u);
});

test("update plan permits exactly one evidence-bearing work and rejects unrelated drift", () => {
	const previous = ledgerV2();
	const next = structuredClone(previous);
	next.cloudInventory.capturedAt = SECOND_CAPTURED_AT;
	const changed = next.records[0];
	changed.exportedAt = SECOND_CAPTURED_AT;
	changed.exportSha256 = digest(700);
	changed.semanticSha256 = digest(701);
	changed.sourceSnapshotSha256 = digest(702);
	changed.siteOutputSha256 = digest(703);
	const plan = createLedgerUpdatePlan({
		previousLedger: previous,
		nextLedger: next,
		previousLedgerSha256: canonicalSha(previous),
		slug: changed.slug,
	});
	assert.equal(plan.slug, changed.slug);
	assert.deepEqual(plan.invalidatedContentApprovals, [changed.slug]);
	assert.equal(plan.nonTargetChanges, 0);
	assert.ok(plan.changedFields.includes("semanticSha256"));
	assert.throws(
		() =>
			createLedgerUpdatePlan({
				previousLedger: previous,
				nextLedger: next,
				previousLedgerSha256: digest(800),
				slug: changed.slug,
			}),
		/canonical previous ledger/u,
	);

	const unrelated = structuredClone(next);
	unrelated.records[1].siteOutputSha256 = digest(704);
	assert.throws(
		() =>
			createLedgerUpdatePlan({
				previousLedger: previous,
				nextLedger: unrelated,
				previousLedgerSha256: canonicalSha(previous),
				slug: changed.slug,
			}),
		/must change only/u,
	);

	const bookkeepingOnly = structuredClone(previous);
	bookkeepingOnly.records[0].exportedAt = SECOND_CAPTURED_AT;
	bookkeepingOnly.records[0].exportSha256 = digest(705);
	assert.throws(
		() =>
			createLedgerUpdatePlan({
				previousLedger: previous,
				nextLedger: bookkeepingOnly,
				previousLedgerSha256: canonicalSha(previous),
				slug: previous.records[0].slug,
			}),
		/no content evidence/u,
	);
});

test("guarded V2 write rejects stale bytes and replaces only an exact ledger", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "proton-v2-update-"));
	try {
		const ledgerPath = path.join(directory, "master-ledger.v2.json");
		const previous = ledgerV2();
		const previousBytes = Buffer.from(serializeJson(previous), "utf8");
		await writeFile(ledgerPath, previousBytes);
		const previousSha = `sha256:${createHash("sha256").update(previousBytes).digest("hex")}`;
		const next = structuredClone(previous);
		next.cloudInventory.capturedAt = SECOND_CAPTURED_AT;
		next.records[0].exportedAt = SECOND_CAPTURED_AT;
		next.records[0].exportSha256 = digest(710);
		next.records[0].semanticSha256 = digest(711);

		await assert.rejects(
			replaceLedgerIfUnchanged({
				absolutePath: ledgerPath,
				expectedSha256: digest(999),
				nextLedger: next,
			}),
			/bytes changed/u,
		);
		assert.deepEqual(await readFile(ledgerPath), previousBytes);

		await replaceLedgerIfUnchanged({
			absolutePath: ledgerPath,
			expectedSha256: previousSha,
			nextLedger: next,
		});
		assert.equal(
			await readFile(ledgerPath, "utf8"),
			serializeJson(validateLedgerV2(next, { requireComplete: true })),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("V2 verification binds current semantics, immutable V1 ancestry, and known slugs", async () => {
	const ledger = await actualBoundLedger();
	const verified = await verifyLedgerV2Evidence({
		repoRoot: DEFAULT_REPO_ROOT,
		ledger,
		requireComplete: true,
	});
	assert.equal(verified.verifiedCount, 35);

	const semanticDrift = structuredClone(ledger);
	semanticDrift.records[0].semanticSha256 = digest(3_000);
	await assert.rejects(
		verifyLedgerV2Evidence({
			repoRoot: DEFAULT_REPO_ROOT,
			ledger: semanticDrift,
			requireComplete: true,
		}),
		/semanticSha256 binding differs/u,
	);

	const wrongAncestry = structuredClone(ledger);
	wrongAncestry.previousLedgerSha256 = digest(3_001);
	await assert.rejects(
		verifyLedgerV2Evidence({
			repoRoot: DEFAULT_REPO_ROOT,
			ledger: wrongAncestry,
		}),
		/immutable V1 ledger bytes/u,
	);

	const unknown = structuredClone(ledger);
	unknown.records[0].slug = "unknown-work";
	const cloudSha = cloudInventoryDigest(
		unknown.records.map((record) => ({
			slug: record.slug,
			masterFolder: record.masterFolder,
			observedName: record.cloudName,
			targetCloudName: record.cloudName,
		})),
		{ observed: false },
	);
	unknown.cloudInventory.observedSha256 = cloudSha;
	unknown.cloudInventory.targetSha256 = cloudSha;
	await assert.rejects(
		verifyLedgerV2Evidence({ repoRoot: DEFAULT_REPO_ROOT, ledger: unknown }),
		/unknown slug/u,
	);
});

test("V2 cloud verification reconciles expected names and exact capture timestamp", async () => {
	const ledger = await actualBoundLedger();
	const expected = await expectedMasterRecordsV2({
		repoRoot: DEFAULT_REPO_ROOT,
	});
	const cloud = verifyCloudCaptureAgainstExpected(
		cloudCaptureForLedger(ledger),
		expected,
		{ requireComplete: true, requireFinal: true },
	);
	const verified = await verifyLedgerV2Evidence({
		repoRoot: DEFAULT_REPO_ROOT,
		ledger,
		cloudCapture: cloud,
		withCloud: true,
		requireComplete: true,
		requireFinalCloud: true,
	});
	assert.equal(verified.cloudPhase, "final");

	const wrongTimestamp = structuredClone(cloud);
	wrongTimestamp.capturedAt = SECOND_CAPTURED_AT;
	await assert.rejects(
		verifyLedgerV2Evidence({
			repoRoot: DEFAULT_REPO_ROOT,
			ledger,
			cloudCapture: wrongTimestamp,
			withCloud: true,
		}),
		/cloud inventory differs/u,
	);

	await assert.rejects(
		verifyLedgerV2Evidence({
			repoRoot: DEFAULT_REPO_ROOT,
			ledger,
			withRaw: true,
		}),
		/requires the ignored cloud capture/u,
	);
});

test("V2 ledger writer is path-scoped and refuses overwrite", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "proton-v2-record-"));
	try {
		await mkdir(path.join(directory, "provenance", "proton"), {
			recursive: true,
		});
		const ledger = await actualBoundLedger();
		await writeLedgerV2NoOverwrite({
			repoRoot: directory,
			ledger,
		});
		await assert.rejects(
			writeLedgerV2NoOverwrite({ repoRoot: directory, ledger }),
			/Refusing to overwrite/u,
		);
		await assert.rejects(
			writeLedgerV2NoOverwrite({
				repoRoot: directory,
				ledger,
				outputPath: "../outside.json",
			}),
			/normalized repository-relative path|remain under provenance/u,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
