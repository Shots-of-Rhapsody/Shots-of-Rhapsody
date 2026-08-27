#!/usr/bin/env node

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	assertSafeRepositoryPath,
	DEFAULT_REPO_ROOT,
} from "../medium/lib/contract.js";
import {
	loadCloudCapture,
	ProtonCloudError,
	verifyCloudCaptureAgainstExpected,
} from "./cloud.mjs";
import { expectedMasterRecordsV2, ProtonContractError } from "./lib.mjs";
import {
	createLedgerV2FromCapture,
	DEFAULT_CAPTURE_PATH_V2,
	PROTON_CAPTURE_SCHEMA_VERSION_V2,
	validateCaptureV2,
	verifyCaptureRawTree,
	writeCaptureV2NoOverwrite,
} from "./v2.mjs";

const TIMESTAMP_DIRECTORY =
	/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/u;

const HELP = `Usage:
  node scripts/proton/capture-finalize.mjs --cloud <path> [options]

Scans only .proton-import/raw/fiction and raw/nonfiction, requires one canonical
timestamped export per expected work, verifies all HTML/image semantics, and
creates the ignored V2 capture without approvals. Nothing is uploaded or read
from the network, and existing output is never overwritten.

Options:
  --cloud <path>   Explicit ignored final cloud capture
  --output <path>  New ignored V2 capture (default: ${DEFAULT_CAPTURE_PATH_V2})
  --json           Emit machine-readable output
  --help           Show this help
`;

function ignoredPath(value, label) {
	const safe = assertSafeRepositoryPath(value, label);
	if (!safe.startsWith(".proton-import/")) {
		throw new ProtonContractError(`${label} must stay under .proton-import`);
	}
	return safe;
}

function exportedAtFromDirectory(name) {
	const match = TIMESTAMP_DIRECTORY.exec(name);
	if (!match) {
		throw new ProtonContractError(
			"V2 export directory must use YYYYMMDDTHHmmss.sssZ",
		);
	}
	const exportedAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
	if (new Date(exportedAt).toISOString() !== exportedAt) {
		throw new ProtonContractError(
			"V2 export directory contains an invalid UTC timestamp",
		);
	}
	return exportedAt;
}

async function listRealDirectory(absolutePath, label) {
	let status;
	try {
		status = await lstat(absolutePath);
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new ProtonContractError(`${label} is missing`);
		}
		throw error;
	}
	if (!status.isDirectory() || status.isSymbolicLink()) {
		throw new ProtonContractError(`${label} must be a real directory`);
	}
	const entries = [];
	for (const entry of await readdir(absolutePath, { withFileTypes: true })) {
		const entryPath = path.join(absolutePath, entry.name);
		const entryStatus = await lstat(entryPath);
		if (entryStatus.isSymbolicLink()) {
			throw new ProtonContractError(`${label} cannot contain links`);
		}
		entries.push({
			name: entry.name,
			path: entryPath,
			isDirectory: entryStatus.isDirectory(),
			isFile: entryStatus.isFile(),
		});
	}
	return entries.sort((left, right) =>
		left.name.localeCompare(right.name, "en"),
	);
}

function requireExactNames(entries, expectedNames, label, { directories }) {
	const expected = [...expectedNames].sort((left, right) =>
		left.localeCompare(right, "en"),
	);
	const actual = entries.map((entry) => entry.name);
	if (
		actual.length !== expected.length ||
		actual.some((name, index) => name !== expected[index]) ||
		entries.some((entry) => (directories ? !entry.isDirectory : !entry.isFile))
	) {
		throw new ProtonContractError(
			`${label} must contain exactly ${expected.length} expected ${directories ? "directories" : "files"}`,
		);
	}
}

export async function scanCanonicalCaptureV2({
	repoRoot = DEFAULT_REPO_ROOT,
	expectedRecords,
	cloudInventorySha256,
	capturedAt = new Date().toISOString(),
} = {}) {
	if (!Array.isArray(expectedRecords) || expectedRecords.length !== 35) {
		throw new ProtonContractError(
			"V2 capture finalization requires exactly 35 expected works",
		);
	}
	const records = [];
	for (const masterFolder of ["fiction", "nonfiction"]) {
		const expected = expectedRecords
			.filter((record) => record.masterFolder === masterFolder)
			.sort((left, right) => left.slug.localeCompare(right.slug, "en"));
		const sectionPath = path.join(
			repoRoot,
			".proton-import",
			"raw",
			masterFolder,
		);
		const slugEntries = await listRealDirectory(
			sectionPath,
			`V2 ${masterFolder} raw directory`,
		);
		requireExactNames(
			slugEntries,
			expected.map((record) => record.slug),
			`V2 ${masterFolder} raw directory`,
			{ directories: true },
		);
		const slugEntryByName = new Map(
			slugEntries.map((entry) => [entry.name, entry]),
		);
		for (const expectedRecord of expected) {
			const slugEntry = slugEntryByName.get(expectedRecord.slug);
			const timestampEntries = await listRealDirectory(
				slugEntry.path,
				`V2 raw slug directory ${expectedRecord.slug}`,
			);
			if (timestampEntries.length !== 1 || !timestampEntries[0].isDirectory) {
				throw new ProtonContractError(
					`V2 raw slug ${expectedRecord.slug} must contain exactly one timestamp directory`,
				);
			}
			const timestampEntry = timestampEntries[0];
			const exportedAt = exportedAtFromDirectory(timestampEntry.name);
			const expectedFiles =
				masterFolder === "fiction"
					? ["document.html", "hero-original.png"]
					: ["document.html"];
			const files = await listRealDirectory(
				timestampEntry.path,
				`V2 raw timestamp directory ${expectedRecord.slug}`,
			);
			requireExactNames(
				files,
				expectedFiles,
				`V2 raw timestamp directory ${expectedRecord.slug}`,
				{ directories: false },
			);
			const base = `.proton-import/raw/${masterFolder}/${expectedRecord.slug}/${timestampEntry.name}`;
			records.push({
				slug: expectedRecord.slug,
				masterFolder,
				articleTitle: expectedRecord.articleTitle,
				cloudName: expectedRecord.cloudName,
				exportedAt,
				documentFile: `${base}/document.html`,
				...(masterFolder === "fiction"
					? { heroFile: `${base}/hero-original.png` }
					: {}),
			});
		}
	}
	const capture = validateCaptureV2(
		{
			schemaVersion: PROTON_CAPTURE_SCHEMA_VERSION_V2,
			capturedAt,
			cloudInventorySha256,
			records,
		},
		{ requireComplete: true },
	);
	await verifyCaptureRawTree({ repoRoot, capture });
	return capture;
}

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				cloud: { type: "string" },
				output: { type: "string", default: DEFAULT_CAPTURE_PATH_V2 },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: false,
			strict: true,
		}).values;
	} catch (error) {
		console.error(`Usage error: ${error.message}`);
		console.error(HELP);
		return 2;
	}
	if (values.help) {
		console.log(HELP);
		return 0;
	}
	try {
		if (!values.cloud) {
			throw new ProtonCloudError("--cloud is required");
		}
		const cloudPath = ignoredPath(values.cloud, "--cloud");
		const outputPath = ignoredPath(values.output, "--output");
		const expected = await expectedMasterRecordsV2({
			repoRoot: DEFAULT_REPO_ROOT,
		});
		const cloudCapture = verifyCloudCaptureAgainstExpected(
			await loadCloudCapture(
				path.join(DEFAULT_REPO_ROOT, ...cloudPath.split("/")),
			),
			expected,
			{ requireComplete: true, requireFinal: true },
		);
		const capture = await scanCanonicalCaptureV2({
			repoRoot: DEFAULT_REPO_ROOT,
			expectedRecords: expected,
			cloudInventorySha256: cloudCapture.targetInventorySha256,
		});
		await createLedgerV2FromCapture({
			repoRoot: DEFAULT_REPO_ROOT,
			capture,
			cloudCapture,
		});
		await writeCaptureV2NoOverwrite({
			repoRoot: DEFAULT_REPO_ROOT,
			capture,
			outputPath,
		});
		const summary = {
			outputPath,
			recordCount: capture.records.length,
			fictionCount: capture.records.filter(
				(record) => record.masterFolder === "fiction",
			).length,
			nonfictionCount: capture.records.filter(
				(record) => record.masterFolder === "nonfiction",
			).length,
			approvalsCreated: 0,
		};
		if (values.json) console.log(JSON.stringify(summary));
		else {
			console.log(
				`Finalized Proton V2 capture for ${summary.fictionCount} Fiction and ${summary.nonfictionCount} Non-Fiction works; approvals created=0`,
			);
		}
		return 0;
	} catch (error) {
		if (
			error instanceof ProtonContractError ||
			error instanceof ProtonCloudError ||
			error?.name === "ProtonNameError" ||
			error?.name === "MediumContractError"
		) {
			console.error(`Proton V2 capture finalization failed: ${error.message}`);
			return 1;
		}
		throw error;
	}
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main().then((exitCode) => {
		process.exitCode = exitCode;
	});
}
