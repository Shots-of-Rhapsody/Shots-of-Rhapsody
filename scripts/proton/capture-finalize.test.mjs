import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serializeJson } from "../medium/lib/contract.js";
import { scanCanonicalCaptureV2 } from "./capture-finalize.mjs";
import { assignWindowsSafeCloudNames } from "./names.mjs";
import { verifyCaptureRawTree, writeCaptureV2NoOverwrite } from "./v2.mjs";

const EXPORTED_AT = "2026-07-28T12:34:56.789Z";
const CAPTURED_AT = "2026-07-29T12:34:56.789Z";
const TIMESTAMP = "20260728T123456.789Z";
const CLOUD_SHA = `sha256:${"a".repeat(64)}`;

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

async function createRawTree(repoRoot) {
	for (const record of expectedRecords()) {
		const directory = path.join(
			repoRoot,
			".proton-import",
			"raw",
			record.masterFolder,
			record.slug,
			TIMESTAMP,
		);
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, "document.html"), "<!doctype html>");
		if (record.masterFolder === "fiction") {
			await writeFile(path.join(directory, "hero-original.png"), "png");
		}
	}
	const legacy = path.join(repoRoot, ".proton-import", "raw", "legacy-v1-work");
	await mkdir(legacy, { recursive: true });
	await writeFile(path.join(legacy, "page.html"), "legacy");
}

async function withRawTree(callback) {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), "proton-v2-intake-"));
	try {
		await createRawTree(repoRoot);
		await callback(repoRoot);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
}

test("capture finalization deterministically binds all canonical timestamped exports", async () => {
	await withRawTree(async (repoRoot) => {
		const capture = await scanCanonicalCaptureV2({
			repoRoot,
			expectedRecords: expectedRecords(),
			cloudInventorySha256: CLOUD_SHA,
			capturedAt: CAPTURED_AT,
		});
		assert.equal(capture.records.length, 35);
		assert.equal(capture.records[0].exportedAt, EXPORTED_AT);
		assert.equal(capture.records[0].masterFolder, "fiction");
		assert.equal(capture.records[0].articleTitle, "Fiction: Work 1");
		assert.equal(capture.records[0].cloudName, "Fiction - Work 1");
		assert.doesNotMatch(serializeJson(capture), /approval|reviewer|passed/u);
		assert.equal(
			(await verifyCaptureRawTree({ repoRoot, capture })).referencedFileCount,
			46,
		);
	});
});

test("capture finalization rejects duplicate timestamps and section-root orphans", async () => {
	await withRawTree(async (repoRoot) => {
		const firstSlug = expectedRecords()[0];
		const duplicate = path.join(
			repoRoot,
			".proton-import",
			"raw",
			firstSlug.masterFolder,
			firstSlug.slug,
			"20260728T223456.789Z",
		);
		await mkdir(duplicate, { recursive: true });
		await writeFile(path.join(duplicate, "document.html"), "duplicate");
		await writeFile(path.join(duplicate, "hero-original.png"), "duplicate");
		await assert.rejects(
			scanCanonicalCaptureV2({
				repoRoot,
				expectedRecords: expectedRecords(),
				cloudInventorySha256: CLOUD_SHA,
				capturedAt: CAPTURED_AT,
			}),
			/exactly one timestamp directory/u,
		);
		await rm(duplicate, { recursive: true, force: true });

		const orphan = path.join(
			repoRoot,
			".proton-import",
			"raw",
			"fiction",
			"orphan-work",
		);
		await mkdir(orphan, { recursive: true });
		await assert.rejects(
			scanCanonicalCaptureV2({
				repoRoot,
				expectedRecords: expectedRecords(),
				cloudInventorySha256: CLOUD_SHA,
				capturedAt: CAPTURED_AT,
			}),
			/exactly 11 expected directories/u,
		);
	});
});

test("V2 raw verification rejects unreferenced files but preserves flat V1 evidence", async () => {
	await withRawTree(async (repoRoot) => {
		const capture = await scanCanonicalCaptureV2({
			repoRoot,
			expectedRecords: expectedRecords(),
			cloudInventorySha256: CLOUD_SHA,
			capturedAt: CAPTURED_AT,
		});
		const orphan = path.join(
			repoRoot,
			".proton-import",
			"raw",
			"fiction",
			"fiction-01",
			TIMESTAMP,
			"notes.txt",
		);
		await writeFile(orphan, "orphan");
		await assert.rejects(
			verifyCaptureRawTree({ repoRoot, capture }),
			/orphan file/u,
		);
	});
});

test("V2 capture writer refuses overwrite and paths outside ignored evidence", async () => {
	await withRawTree(async (repoRoot) => {
		const capture = await scanCanonicalCaptureV2({
			repoRoot,
			expectedRecords: expectedRecords(),
			cloudInventorySha256: CLOUD_SHA,
			capturedAt: CAPTURED_AT,
		});
		await writeCaptureV2NoOverwrite({ repoRoot, capture });
		await assert.rejects(
			writeCaptureV2NoOverwrite({ repoRoot, capture }),
			/Refusing to overwrite/u,
		);
		await assert.rejects(
			writeCaptureV2NoOverwrite({
				repoRoot,
				capture,
				outputPath: "provenance/proton/capture.v2.json",
			}),
			/must remain under .proton-import/u,
		);
	});
});
