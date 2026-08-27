import { createHash } from "node:crypto";
import { lstat, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	assertCanonicalUtc,
	assertNonEmptyString,
	assertOnlyKeys,
	assertPlainObject,
	assertSafeRepositoryPath,
	assertSha256,
	assertSlug,
	DEFAULT_REPO_ROOT,
	serializeJson,
} from "../medium/lib/contract.js";
import { cloudInventoryDigest, validateCloudCapture } from "./cloud.mjs";
import {
	loadExpectedBindings,
	ProtonContractError,
	verifyRawBinding,
} from "./lib.mjs";
import { assertMasterFolder, assignWindowsSafeCloudNames } from "./names.mjs";

export const PROTON_MASTER_SCHEMA_VERSION_V2 = 2;
export const PROTON_CAPTURE_SCHEMA_VERSION_V2 = 2;
export const PROTON_SEMANTIC_MODEL_VERSION = 1;
export const DEFAULT_LEDGER_PATH_V2 = "provenance/proton/master-ledger.v2.json";
export const DEFAULT_CAPTURE_PATH_V2 = ".proton-import/capture.v2.json";
export const DEFAULT_LEDGER_PATH_V1 = "provenance/proton/master-ledger.v1.json";

const EXPECTED_RECORD_COUNT = 35;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const PRIVATE_TEXT_PATTERNS = [
	/https?:\/\//iu,
	/\b(?:docs|drive)\.proton\.(?:me|ch)\b/iu,
	/\bprotonusercontent\.com\b/iu,
	/\bfile:\/\//iu,
	/\blocalhost\b/iu,
	/\b[A-Za-z]:[\\/]/u,
	/(?:^|[\s"'])\/(?:Users|home)\//u,
	/\.proton-import/iu,
];

function sha256(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function captureTimestampKey(value) {
	return value.replaceAll("-", "").replaceAll(":", "");
}

function assertInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new ProtonContractError(`${label} must be a non-negative integer`);
	}
	return value;
}

function assertSanitized(value, label) {
	const serialized = serializeJson(value);
	for (const pattern of PRIVATE_TEXT_PATTERNS) {
		if (pattern.test(serialized)) {
			throw new ProtonContractError(
				`${label} contains a URL, account reference, raw-source path, or local path`,
			);
		}
	}
}

async function readBoundedJson(absolutePath, label, { canonical = true } = {}) {
	let initial;
	try {
		initial = await lstat(absolutePath, { bigint: true });
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new ProtonContractError(`${label} is missing`);
		}
		throw error;
	}
	if (!initial.isFile() || initial.isSymbolicLink()) {
		throw new ProtonContractError(`${label} must be a regular file`);
	}
	const size = Number(initial.size);
	if (!Number.isSafeInteger(size) || size < 1 || size > MAX_JSON_BYTES) {
		throw new ProtonContractError(`${label} has an invalid size`);
	}
	const handle = await open(absolutePath, "r");
	try {
		const opened = await handle.stat({ bigint: true });
		if (
			opened.dev !== initial.dev ||
			opened.ino !== initial.ino ||
			Number(opened.size) !== size
		) {
			throw new ProtonContractError(`${label} changed while opening`);
		}
		const bytes = await handle.readFile();
		let value;
		try {
			value = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
		} catch (error) {
			throw new ProtonContractError(`${label} must be UTF-8 JSON`, {
				cause: error,
			});
		}
		if (canonical && !bytes.equals(Buffer.from(serializeJson(value), "utf8"))) {
			throw new ProtonContractError(
				`${label} must use canonical JSON formatting`,
			);
		}
		return { bytes, value };
	} finally {
		await handle.close().catch(() => {});
	}
}

function validateCaptureRecord(value, index) {
	const label = `capture.records[${index}]`;
	const record = assertPlainObject(value, label);
	assertOnlyKeys(
		record,
		new Set([
			"slug",
			"masterFolder",
			"articleTitle",
			"cloudName",
			"exportedAt",
			"documentFile",
			"heroFile",
		]),
		label,
	);
	const slug = assertSlug(record.slug, `${label}.slug`);
	const masterFolder = assertMasterFolder(
		record.masterFolder,
		`${label}.masterFolder`,
	);
	const exportedAt = assertCanonicalUtc(
		record.exportedAt,
		`${label}.exportedAt`,
	);
	const timestamp = captureTimestampKey(exportedAt);
	const expectedBase = `.proton-import/raw/${masterFolder}/${slug}/${timestamp}`;
	const documentFile = assertSafeRepositoryPath(
		record.documentFile,
		`${label}.documentFile`,
	);
	if (documentFile !== `${expectedBase}/document.html`) {
		throw new ProtonContractError(
			`${label}.documentFile must use the canonical sectioned capture path`,
		);
	}
	const normalized = {
		slug,
		masterFolder,
		articleTitle: assertNonEmptyString(
			record.articleTitle,
			`${label}.articleTitle`,
		),
		cloudName: assertNonEmptyString(record.cloudName, `${label}.cloudName`),
		exportedAt,
		documentFile,
	};
	if (masterFolder === "fiction") {
		const heroFile = assertSafeRepositoryPath(
			record.heroFile,
			`${label}.heroFile`,
		);
		if (heroFile !== `${expectedBase}/hero-original.png`) {
			throw new ProtonContractError(
				`${label}.heroFile must use the canonical Fiction hero path`,
			);
		}
		normalized.heroFile = heroFile;
	} else if (record.heroFile !== undefined) {
		throw new ProtonContractError(
			`${label}.heroFile is forbidden because Non-Fiction hero pixels are embedded and verified from HTML`,
		);
	}
	return normalized;
}

export function validateCaptureV2(value, { requireComplete = false } = {}) {
	const capture = assertPlainObject(value, "capture");
	assertOnlyKeys(
		capture,
		new Set(["schemaVersion", "capturedAt", "cloudInventorySha256", "records"]),
		"capture",
	);
	if (capture.schemaVersion !== PROTON_CAPTURE_SCHEMA_VERSION_V2) {
		throw new ProtonContractError(
			`capture.schemaVersion must equal ${PROTON_CAPTURE_SCHEMA_VERSION_V2}`,
		);
	}
	if (!Array.isArray(capture.records)) {
		throw new ProtonContractError("capture.records must be an array");
	}
	const slugs = new Set();
	const files = new Set();
	const records = capture.records.map((record, index) => {
		const normalized = validateCaptureRecord(record, index);
		if (slugs.has(normalized.slug)) {
			throw new ProtonContractError(`capture repeats slug ${normalized.slug}`);
		}
		for (const file of [normalized.documentFile, normalized.heroFile].filter(
			Boolean,
		)) {
			if (files.has(file)) {
				throw new ProtonContractError(`capture repeats file ${file}`);
			}
			files.add(file);
		}
		slugs.add(normalized.slug);
		return normalized;
	});
	if (requireComplete) {
		const fiction = records.filter(
			(record) => record.masterFolder === "fiction",
		).length;
		const nonfiction = records.length - fiction;
		if (
			records.length !== EXPECTED_RECORD_COUNT ||
			fiction !== 11 ||
			nonfiction !== 24
		) {
			throw new ProtonContractError(
				`Proton V2 capture must contain 11 Fiction and 24 Non-Fiction records, not ${fiction} and ${nonfiction}`,
			);
		}
	}
	const capturedAt = assertCanonicalUtc(
		capture.capturedAt,
		"capture.capturedAt",
	);
	for (const record of records) {
		if (new Date(record.exportedAt) > new Date(capturedAt)) {
			throw new ProtonContractError(
				`capture.capturedAt precedes exportedAt for ${record.slug}`,
			);
		}
	}
	const normalized = {
		schemaVersion: PROTON_CAPTURE_SCHEMA_VERSION_V2,
		capturedAt,
		cloudInventorySha256: assertSha256(
			capture.cloudInventorySha256,
			"capture.cloudInventorySha256",
		),
		records: records.sort((left, right) =>
			left.slug.localeCompare(right.slug, "en"),
		),
	};
	return normalized;
}

function validateLedgerRecord(value, index) {
	const label = `ledger.records[${index}]`;
	const record = assertPlainObject(value, label);
	assertOnlyKeys(
		record,
		new Set([
			"slug",
			"masterFolder",
			"articleTitle",
			"cloudName",
			"exportedAt",
			"exportSha256",
			"semanticSha256",
			"heroSha256",
			"heroPixelSha256",
			"heroSourceSha256",
			"sourceSnapshotSha256",
			"siteOutputSha256",
			"bodyBlockCount",
		]),
		label,
	);
	return {
		slug: assertSlug(record.slug, `${label}.slug`),
		masterFolder: assertMasterFolder(
			record.masterFolder,
			`${label}.masterFolder`,
		),
		articleTitle: assertNonEmptyString(
			record.articleTitle,
			`${label}.articleTitle`,
		),
		cloudName: assertNonEmptyString(record.cloudName, `${label}.cloudName`),
		exportedAt: assertCanonicalUtc(record.exportedAt, `${label}.exportedAt`),
		exportSha256: assertSha256(record.exportSha256, `${label}.exportSha256`),
		semanticSha256: assertSha256(
			record.semanticSha256,
			`${label}.semanticSha256`,
		),
		heroSha256: assertSha256(record.heroSha256, `${label}.heroSha256`),
		heroPixelSha256: assertSha256(
			record.heroPixelSha256,
			`${label}.heroPixelSha256`,
		),
		heroSourceSha256: assertSha256(
			record.heroSourceSha256,
			`${label}.heroSourceSha256`,
		),
		sourceSnapshotSha256: assertSha256(
			record.sourceSnapshotSha256,
			`${label}.sourceSnapshotSha256`,
		),
		siteOutputSha256: assertSha256(
			record.siteOutputSha256,
			`${label}.siteOutputSha256`,
		),
		bodyBlockCount: assertInteger(
			record.bodyBlockCount,
			`${label}.bodyBlockCount`,
		),
	};
}

export function validateLedgerV2(value, { requireComplete = false } = {}) {
	const ledger = assertPlainObject(value, "ledger");
	assertOnlyKeys(
		ledger,
		new Set([
			"schemaVersion",
			"semanticModelVersion",
			"expectedCount",
			"previousLedgerSha256",
			"cloudInventory",
			"records",
		]),
		"ledger",
	);
	if (ledger.schemaVersion !== PROTON_MASTER_SCHEMA_VERSION_V2) {
		throw new ProtonContractError(
			`ledger.schemaVersion must equal ${PROTON_MASTER_SCHEMA_VERSION_V2}`,
		);
	}
	if (ledger.semanticModelVersion !== PROTON_SEMANTIC_MODEL_VERSION) {
		throw new ProtonContractError(
			`ledger.semanticModelVersion must equal ${PROTON_SEMANTIC_MODEL_VERSION}`,
		);
	}
	if (ledger.expectedCount !== EXPECTED_RECORD_COUNT) {
		throw new ProtonContractError(
			`ledger.expectedCount must equal ${EXPECTED_RECORD_COUNT}`,
		);
	}
	const cloud = assertPlainObject(
		ledger.cloudInventory,
		"ledger.cloudInventory",
	);
	assertOnlyKeys(
		cloud,
		new Set(["phase", "capturedAt", "observedSha256", "targetSha256"]),
		"ledger.cloudInventory",
	);
	if (cloud.phase !== "preflight" && cloud.phase !== "final") {
		throw new ProtonContractError(
			"ledger.cloudInventory.phase must be preflight or final",
		);
	}
	if (!Array.isArray(ledger.records)) {
		throw new ProtonContractError("ledger.records must be an array");
	}
	const slugs = new Set();
	const exportHashes = new Set();
	let records = ledger.records.map((record, index) => {
		const normalized = validateLedgerRecord(record, index);
		if (slugs.has(normalized.slug)) {
			throw new ProtonContractError(`ledger repeats slug ${normalized.slug}`);
		}
		if (exportHashes.has(normalized.exportSha256)) {
			throw new ProtonContractError(
				`ledger reuses an HTML export for ${normalized.slug}`,
			);
		}
		slugs.add(normalized.slug);
		exportHashes.add(normalized.exportSha256);
		return normalized;
	});
	records = assignWindowsSafeCloudNames(records);
	for (const [index, record] of records.entries()) {
		if (record.cloudName !== ledger.records[index]?.cloudName) {
			throw new ProtonContractError(
				`ledger cloudName is not deterministically derived for ${record.slug}`,
			);
		}
	}
	if (requireComplete && records.length !== EXPECTED_RECORD_COUNT) {
		throw new ProtonContractError(
			`Proton V2 master ledger is incomplete: ${records.length}/${EXPECTED_RECORD_COUNT}`,
		);
	}
	const normalized = {
		schemaVersion: PROTON_MASTER_SCHEMA_VERSION_V2,
		semanticModelVersion: PROTON_SEMANTIC_MODEL_VERSION,
		expectedCount: EXPECTED_RECORD_COUNT,
		previousLedgerSha256: assertSha256(
			ledger.previousLedgerSha256,
			"ledger.previousLedgerSha256",
		),
		cloudInventory: {
			phase: cloud.phase,
			capturedAt: assertCanonicalUtc(
				cloud.capturedAt,
				"ledger.cloudInventory.capturedAt",
			),
			observedSha256: assertSha256(
				cloud.observedSha256,
				"ledger.cloudInventory.observedSha256",
			),
			targetSha256: assertSha256(
				cloud.targetSha256,
				"ledger.cloudInventory.targetSha256",
			),
		},
		records: [...records].sort((left, right) =>
			left.slug.localeCompare(right.slug, "en"),
		),
	};
	const targetProjection = normalized.records.map((record) => ({
		slug: record.slug,
		masterFolder: record.masterFolder,
		observedName: record.cloudName,
		targetCloudName: record.cloudName,
	}));
	if (
		normalized.cloudInventory.targetSha256 !==
		cloudInventoryDigest(targetProjection, { observed: false })
	) {
		throw new ProtonContractError(
			"ledger target cloud inventory digest does not match its records",
		);
	}
	if (
		(normalized.cloudInventory.phase === "final") !==
		(normalized.cloudInventory.observedSha256 ===
			normalized.cloudInventory.targetSha256)
	) {
		throw new ProtonContractError(
			"ledger cloud inventory phase and digests are inconsistent",
		);
	}
	const fiction = normalized.records.filter(
		(record) => record.masterFolder === "fiction",
	).length;
	const nonfiction = normalized.records.length - fiction;
	if (requireComplete && (fiction !== 11 || nonfiction !== 24)) {
		throw new ProtonContractError(
			`Proton V2 master ledger must contain 11 Fiction and 24 Non-Fiction records, not ${fiction} and ${nonfiction}`,
		);
	}
	assertSanitized(normalized, "Proton V2 master ledger");
	return normalized;
}

export async function loadCaptureV2({
	repoRoot = DEFAULT_REPO_ROOT,
	capturePath = DEFAULT_CAPTURE_PATH_V2,
	requireComplete = false,
} = {}) {
	assertSafeRepositoryPath(capturePath, "V2 capture path");
	if (!capturePath.startsWith(".proton-import/")) {
		throw new ProtonContractError(
			"V2 capture evidence must remain under .proton-import",
		);
	}
	const file = await readBoundedJson(
		path.join(repoRoot, ...capturePath.split("/")),
		"Proton V2 capture",
	);
	return validateCaptureV2(file.value, { requireComplete });
}

export async function writeCaptureV2NoOverwrite({
	repoRoot = DEFAULT_REPO_ROOT,
	capture,
	outputPath = DEFAULT_CAPTURE_PATH_V2,
} = {}) {
	assertSafeRepositoryPath(outputPath, "V2 capture output path");
	if (!outputPath.startsWith(".proton-import/")) {
		throw new ProtonContractError(
			"V2 capture output must remain under .proton-import",
		);
	}
	const normalized = validateCaptureV2(capture, { requireComplete: true });
	try {
		await writeFile(
			path.join(repoRoot, ...outputPath.split("/")),
			serializeJson(normalized),
			{ flag: "wx" },
		);
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new ProtonContractError(
				`Refusing to overwrite existing Proton V2 capture: ${outputPath}`,
			);
		}
		throw error;
	}
	return outputPath;
}

async function walkV2Section({
	absoluteDirectory,
	relativeDirectory,
	expectedFiles,
	seen,
}) {
	let status;
	try {
		status = await lstat(absoluteDirectory);
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new ProtonContractError(
				`Required V2 raw directory is missing: ${relativeDirectory}`,
			);
		}
		throw error;
	}
	if (!status.isDirectory() || status.isSymbolicLink()) {
		throw new ProtonContractError(
			`V2 raw directory must be a real directory: ${relativeDirectory}`,
		);
	}
	for (const entry of await readdir(absoluteDirectory, {
		withFileTypes: true,
	})) {
		const relative = `${relativeDirectory}/${entry.name}`;
		const absolute = path.join(absoluteDirectory, entry.name);
		const entryStatus = await lstat(absolute);
		if (entryStatus.isSymbolicLink()) {
			throw new ProtonContractError(
				`V2 raw evidence cannot contain links: ${relative}`,
			);
		}
		if (entryStatus.isDirectory()) {
			if (![...expectedFiles].some((file) => file.startsWith(`${relative}/`))) {
				throw new ProtonContractError(
					`V2 raw evidence contains an orphan directory: ${relative}`,
				);
			}
			await walkV2Section({
				absoluteDirectory: absolute,
				relativeDirectory: relative,
				expectedFiles,
				seen,
			});
			continue;
		}
		if (!entryStatus.isFile() || !expectedFiles.has(relative)) {
			throw new ProtonContractError(
				`V2 raw evidence contains an orphan file: ${relative}`,
			);
		}
		seen.add(relative);
	}
}

export async function verifyCaptureRawTree({
	repoRoot = DEFAULT_REPO_ROOT,
	capture,
} = {}) {
	const normalized = validateCaptureV2(capture, { requireComplete: true });
	const expectedFiles = new Set(
		normalized.records.flatMap((record) =>
			[record.documentFile, record.heroFile].filter(Boolean),
		),
	);
	const seen = new Set();
	for (const masterFolder of ["fiction", "nonfiction"]) {
		const relativeDirectory = `.proton-import/raw/${masterFolder}`;
		await walkV2Section({
			absoluteDirectory: path.join(repoRoot, ...relativeDirectory.split("/")),
			relativeDirectory,
			expectedFiles,
			seen,
		});
	}
	for (const expected of expectedFiles) {
		if (!seen.has(expected)) {
			throw new ProtonContractError(
				`V2 raw evidence is missing referenced file: ${expected}`,
			);
		}
	}
	return { referencedFileCount: expectedFiles.size };
}

export async function loadLedgerV2({
	repoRoot = DEFAULT_REPO_ROOT,
	ledgerPath = DEFAULT_LEDGER_PATH_V2,
	requireComplete = false,
} = {}) {
	assertSafeRepositoryPath(ledgerPath, "V2 ledger path");
	if (!ledgerPath.startsWith("provenance/proton/")) {
		throw new ProtonContractError(
			"V2 ledger must remain under provenance/proton",
		);
	}
	const file = await readBoundedJson(
		path.join(repoRoot, ...ledgerPath.split("/")),
		"Proton V2 master ledger",
	);
	return validateLedgerV2(file.value, { requireComplete });
}

export async function ledgerV2FileSha256({
	repoRoot = DEFAULT_REPO_ROOT,
	ledgerPath = DEFAULT_LEDGER_PATH_V2,
} = {}) {
	assertSafeRepositoryPath(ledgerPath, "V2 ledger path");
	const file = await readBoundedJson(
		path.join(repoRoot, ...ledgerPath.split("/")),
		"Proton V2 master ledger",
	);
	return sha256(file.bytes);
}

export async function v1LedgerSha256({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
	const file = await readBoundedJson(
		path.join(repoRoot, DEFAULT_LEDGER_PATH_V1),
		"Proton V1 master ledger",
	);
	return sha256(file.bytes);
}

function captureEntryBySlug(capture) {
	return new Map(capture.records.map((record) => [record.slug, record]));
}

export async function createLedgerV2FromCapture({
	repoRoot = DEFAULT_REPO_ROOT,
	capture,
	cloudCapture,
} = {}) {
	const normalizedCapture = validateCaptureV2(capture, {
		requireComplete: true,
	});
	await verifyCaptureRawTree({ repoRoot, capture: normalizedCapture });
	const normalizedCloud = validateCloudCapture(cloudCapture, {
		requireComplete: true,
	});
	if (
		normalizedCapture.cloudInventorySha256 !==
		normalizedCloud.targetInventorySha256
	) {
		throw new ProtonContractError(
			"Proton V2 capture is not bound to the target cloud inventory",
		);
	}
	const bindings = await loadExpectedBindings(repoRoot);
	const entries = captureEntryBySlug(normalizedCapture);
	const targetNames = new Map(
		assignWindowsSafeCloudNames(
			bindings.map((binding) => ({
				slug: binding.slug,
				masterFolder: binding.masterFolder,
				articleTitle: binding.articleTitle,
			})),
		).map((record) => [record.slug, record.cloudName]),
	);
	const records = [];
	for (const binding of bindings) {
		const entry = entries.get(binding.slug);
		if (
			!entry ||
			entry.masterFolder !== binding.masterFolder ||
			entry.articleTitle !== binding.articleTitle ||
			entry.cloudName !== targetNames.get(binding.slug)
		) {
			throw new ProtonContractError(
				`Proton V2 capture binding differs for ${binding.slug}`,
			);
		}
		const raw = await verifyRawBinding(repoRoot, binding, {
			slug: entry.slug,
			articleTitle: entry.articleTitle,
			exportedAt: entry.exportedAt,
			file: entry.documentFile,
			heroFile: entry.heroFile,
		});
		records.push({
			slug: binding.slug,
			masterFolder: binding.masterFolder,
			articleTitle: binding.articleTitle,
			cloudName: targetNames.get(binding.slug),
			exportedAt: entry.exportedAt,
			exportSha256: raw.exportSha256,
			semanticSha256: binding.semanticSha256V2,
			heroSha256: binding.heroSha256,
			heroPixelSha256: binding.heroPixelSha256,
			heroSourceSha256: raw.heroSourceSha256,
			sourceSnapshotSha256: binding.sourceSnapshotSha256,
			siteOutputSha256: binding.siteOutputSha256,
			bodyBlockCount: binding.bodyBlockCount,
		});
	}
	return validateLedgerV2(
		{
			schemaVersion: PROTON_MASTER_SCHEMA_VERSION_V2,
			semanticModelVersion: PROTON_SEMANTIC_MODEL_VERSION,
			expectedCount: EXPECTED_RECORD_COUNT,
			previousLedgerSha256: await v1LedgerSha256({ repoRoot }),
			cloudInventory: {
				phase: normalizedCloud.phase,
				capturedAt: normalizedCloud.capturedAt,
				observedSha256: normalizedCloud.observedInventorySha256,
				targetSha256: normalizedCloud.targetInventorySha256,
			},
			records,
		},
		{ requireComplete: true },
	);
}

export async function writeLedgerV2NoOverwrite({
	repoRoot = DEFAULT_REPO_ROOT,
	ledger,
	outputPath = DEFAULT_LEDGER_PATH_V2,
} = {}) {
	assertSafeRepositoryPath(outputPath, "V2 ledger output path");
	if (!outputPath.startsWith("provenance/proton/")) {
		throw new ProtonContractError(
			"V2 ledger output must remain under provenance/proton",
		);
	}
	const normalized = validateLedgerV2(ledger, { requireComplete: true });
	try {
		await writeFile(
			path.join(repoRoot, ...outputPath.split("/")),
			serializeJson(normalized),
			{ flag: "wx" },
		);
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new ProtonContractError(
				`Refusing to overwrite existing Proton V2 ledger: ${outputPath}`,
			);
		}
		throw error;
	}
	return outputPath;
}

export async function verifyLedgerV2Evidence({
	repoRoot = DEFAULT_REPO_ROOT,
	ledger,
	capture,
	cloudCapture,
	withRaw = false,
	withCloud = false,
	requireComplete = false,
	requireFinalCloud = false,
} = {}) {
	const normalizedLedger = validateLedgerV2(ledger, { requireComplete });
	if (
		normalizedLedger.previousLedgerSha256 !==
		(await v1LedgerSha256({ repoRoot }))
	) {
		throw new ProtonContractError(
			"Proton V2 ledger does not bind the immutable V1 ledger bytes",
		);
	}
	const bindings = await loadExpectedBindings(repoRoot);
	const expectedSlugs = new Set(bindings.map((binding) => binding.slug));
	for (const record of normalizedLedger.records) {
		if (!expectedSlugs.has(record.slug)) {
			throw new ProtonContractError(
				`V2 ledger contains unknown slug ${record.slug}`,
			);
		}
	}
	const expectedNames = new Map(
		assignWindowsSafeCloudNames(
			bindings.map((binding) => ({
				slug: binding.slug,
				masterFolder: binding.masterFolder,
				articleTitle: binding.articleTitle,
			})),
		).map((record) => [record.slug, record.cloudName]),
	);
	const bySlug = new Map(
		normalizedLedger.records.map((record) => [record.slug, record]),
	);
	for (const binding of bindings) {
		const record = bySlug.get(binding.slug);
		if (!record) {
			if (requireComplete) {
				throw new ProtonContractError(
					`V2 ledger has no record for ${binding.slug}`,
				);
			}
			continue;
		}
		const expected = {
			masterFolder: binding.masterFolder,
			articleTitle: binding.articleTitle,
			cloudName: expectedNames.get(binding.slug),
			semanticSha256: binding.semanticSha256V2,
			heroSha256: binding.heroSha256,
			heroPixelSha256: binding.heroPixelSha256,
			sourceSnapshotSha256: binding.sourceSnapshotSha256,
			siteOutputSha256: binding.siteOutputSha256,
			bodyBlockCount: binding.bodyBlockCount,
		};
		for (const [key, value] of Object.entries(expected)) {
			if (record[key] !== value) {
				throw new ProtonContractError(
					`V2 ledger ${key} binding differs for ${binding.slug}`,
				);
			}
		}
	}
	if (withRaw) {
		if (!cloudCapture) {
			throw new ProtonContractError(
				"Raw V2 verification requires the ignored cloud capture binding",
			);
		}
		const normalizedCapture = validateCaptureV2(capture, {
			requireComplete,
		});
		await verifyCaptureRawTree({ repoRoot, capture: normalizedCapture });
		const regenerated = await createLedgerV2FromCapture({
			repoRoot,
			capture: normalizedCapture,
			cloudCapture,
		});
		if (serializeJson(regenerated) !== serializeJson(normalizedLedger)) {
			throw new ProtonContractError(
				"Raw Proton V2 evidence or cloud binding differs from the committed ledger",
			);
		}
	}
	if (withCloud) {
		const normalizedCloud = validateCloudCapture(cloudCapture, {
			requireComplete,
		});
		if (
			normalizedCloud.capturedAt !==
				normalizedLedger.cloudInventory.capturedAt ||
			normalizedCloud.observedInventorySha256 !==
				normalizedLedger.cloudInventory.observedSha256 ||
			normalizedCloud.targetInventorySha256 !==
				normalizedLedger.cloudInventory.targetSha256 ||
			normalizedCloud.phase !== normalizedLedger.cloudInventory.phase
		) {
			throw new ProtonContractError(
				"Ignored cloud inventory differs from the committed V2 binding",
			);
		}
	}
	if (requireFinalCloud && normalizedLedger.cloudInventory.phase !== "final") {
		throw new ProtonContractError(
			"The Proton cloud inventory still requires Windows-safe renames",
		);
	}
	return {
		verifiedCount: normalizedLedger.records.length,
		expectedCount: EXPECTED_RECORD_COUNT,
		withRaw,
		withCloud,
		cloudPhase: normalizedLedger.cloudInventory.phase,
		complete: normalizedLedger.records.length === EXPECTED_RECORD_COUNT,
	};
}
