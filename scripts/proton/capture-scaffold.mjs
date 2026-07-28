#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	assertCanonicalUtc,
	assertSafeRepositoryPath,
	DEFAULT_REPO_ROOT,
	serializeJson,
} from "../medium/lib/contract.js";
import {
	DEFAULT_CLOUD_CAPTURE_PATH,
	loadCloudCapture,
	ProtonCloudError,
	verifyCloudCaptureAgainstExpected,
} from "./cloud.mjs";
import { expectedMasterRecordsV2 } from "./lib.mjs";

export const PROTON_CAPTURE_SCAFFOLD_VERSION = 2;
export const DEFAULT_CAPTURE_SCAFFOLD_PATH =
	".proton-import/capture-scaffold.v2.json";
const EXPORT_TIMESTAMP_PLACEHOLDER = "<YYYYMMDDTHHmmss.sssZ>";

const HELP = `Usage:
  node scripts/proton/capture-scaffold.mjs --generated-at <UTC> [options]

Creates an ignored, no-overwrite pending export checklist. It creates no
approval, review identity, pass status, raw export, or committed evidence.

Options:
  --generated-at <UTC>  Canonical UTC scaffold timestamp
  --cloud <path>        Ignored cloud capture (default: ${DEFAULT_CLOUD_CAPTURE_PATH})
  --output <path>       Ignored scaffold (default: ${DEFAULT_CAPTURE_SCAFFOLD_PATH})
  --json                Emit machine-readable output
  --help                Show this help
`;

export function createCaptureScaffold({ generatedAt, cloudCapture, expected }) {
	const bySlug = new Map(
		cloudCapture.records.map((record) => [record.slug, record]),
	);
	const records = expected.map((record) => {
		const cloud = bySlug.get(record.slug);
		if (
			!cloud ||
			cloud.masterFolder !== record.masterFolder ||
			cloud.targetCloudName !== record.cloudName
		) {
			throw new ProtonCloudError(
				`Cloud target binding differs for ${record.slug}`,
			);
		}
		return {
			slug: record.slug,
			masterFolder: record.masterFolder,
			articleTitle: record.articleTitle,
			cloudName: record.cloudName,
			exportedAt: null,
			timestampDirectoryFormat: "YYYYMMDDTHHmmss.sssZ",
			captureDirectory: `.proton-import/raw/${record.masterFolder}/${record.slug}/${EXPORT_TIMESTAMP_PLACEHOLDER}`,
			documentFile: `.proton-import/raw/${record.masterFolder}/${record.slug}/${EXPORT_TIMESTAMP_PLACEHOLDER}/document.html`,
			...(record.masterFolder === "fiction"
				? {
						heroFile: `.proton-import/raw/${record.masterFolder}/${record.slug}/${EXPORT_TIMESTAMP_PLACEHOLDER}/hero-original.png`,
					}
				: {}),
			expected: {
				sourceSnapshotSha256: record.sourceSnapshotSha256,
				siteOutputSha256: record.siteOutputSha256,
				heroSha256: record.heroSha256,
				heroPixelSha256: record.heroPixelSha256,
			},
			status: "pending",
		};
	});
	return {
		schemaVersion: PROTON_CAPTURE_SCAFFOLD_VERSION,
		generatedAt,
		cloudPhase: cloudCapture.phase,
		cloudInventorySha256: cloudCapture.targetInventorySha256,
		expectedCount: records.length,
		records,
	};
}

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				"generated-at": { type: "string" },
				cloud: { type: "string", default: DEFAULT_CLOUD_CAPTURE_PATH },
				output: { type: "string", default: DEFAULT_CAPTURE_SCAFFOLD_PATH },
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
		if (!values["generated-at"]) {
			throw new ProtonCloudError("--generated-at is required");
		}
		const generatedAt = assertCanonicalUtc(
			values["generated-at"],
			"--generated-at",
		);
		for (const [label, value] of [
			["--cloud", values.cloud],
			["--output", values.output],
		]) {
			assertSafeRepositoryPath(value, label);
			if (!value.startsWith(".proton-import/")) {
				throw new ProtonCloudError(`${label} must stay under .proton-import`);
			}
		}
		const loadedCloudCapture = await loadCloudCapture(
			path.join(DEFAULT_REPO_ROOT, ...values.cloud.split("/")),
		);
		const expected = await expectedMasterRecordsV2({
			repoRoot: DEFAULT_REPO_ROOT,
		});
		const cloudCapture = verifyCloudCaptureAgainstExpected(
			loadedCloudCapture,
			expected,
			{ requireComplete: true },
		);
		const scaffold = createCaptureScaffold({
			generatedAt,
			cloudCapture,
			expected,
		});
		try {
			await writeFile(
				path.join(DEFAULT_REPO_ROOT, ...values.output.split("/")),
				serializeJson(scaffold),
				{ flag: "wx" },
			);
		} catch (error) {
			if (error?.code === "EEXIST") {
				throw new ProtonCloudError(
					"Refusing to overwrite the existing pending Proton capture scaffold",
				);
			}
			throw error;
		}
		const summary = {
			outputPath: values.output,
			recordCount: scaffold.records.length,
			cloudPhase: scaffold.cloudPhase,
			approvalsCreated: 0,
		};
		if (values.json) console.log(JSON.stringify(summary));
		else {
			console.log(
				`Created pending Proton export scaffold for ${summary.recordCount} works; approvals created=0`,
			);
		}
		return 0;
	} catch (error) {
		if (
			error instanceof ProtonCloudError ||
			error?.name === "ProtonContractError" ||
			error?.name === "ProtonNameError" ||
			error?.name === "MediumContractError"
		) {
			console.error(`Proton capture scaffold failed: ${error.message}`);
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
