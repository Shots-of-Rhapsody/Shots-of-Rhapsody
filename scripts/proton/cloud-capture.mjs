#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	assertSafeRepositoryPath,
	DEFAULT_REPO_ROOT,
} from "../medium/lib/contract.js";
import {
	captureCloudInventory,
	DEFAULT_CLOUD_CAPTURE_PATH,
	PROTON_CLOUD_CAPTURE_SCHEMA_VERSION,
	ProtonCloudError,
	writeCloudCaptureNoOverwrite,
} from "./cloud.mjs";
import { expectedMasterRecordsV2 } from "./lib.mjs";

const HELP = `Usage:
  node scripts/proton/cloud-capture.mjs --cli <absolute-path> [options]

Runs only the two fixed, read-only Proton folder listings. Raw CLI JSON is
parsed in memory and is never printed or written. The ignored output contains
only public slugs, sanitized names, types, counts, timestamps, and digests.
The executable must match Proton's published Windows x64 0.6.0 SHA-512.

Options:
  --cli <path>     Absolute Proton Drive CLI executable path
  --output <path>  Ignored output (default: ${DEFAULT_CLOUD_CAPTURE_PATH})
  --json           Emit a sanitized summary
  --help           Show this help
`;

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				cli: { type: "string" },
				output: { type: "string", default: DEFAULT_CLOUD_CAPTURE_PATH },
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
		if (!values.cli) {
			throw new ProtonCloudError("--cli is required");
		}
		const outputPath = assertSafeRepositoryPath(values.output, "--output");
		if (!outputPath.startsWith(".proton-import/")) {
			throw new ProtonCloudError(
				"Cloud capture output must stay under .proton-import",
			);
		}
		const result = await captureCloudInventory({
			cliPath: values.cli,
			expectedRecords: await expectedMasterRecordsV2({
				repoRoot: DEFAULT_REPO_ROOT,
			}),
		});
		const capture = await writeCloudCaptureNoOverwrite(
			path.join(DEFAULT_REPO_ROOT, ...outputPath.split("/")),
			{
				schemaVersion: PROTON_CLOUD_CAPTURE_SCHEMA_VERSION,
				capturedAt: result.capturedAt,
				cliVersion: result.cliVersion,
				phase: result.phase,
				observedInventorySha256: result.observedInventorySha256,
				targetInventorySha256: result.targetInventorySha256,
				records: result.records,
			},
		);
		const summary = {
			outputPath,
			phase: capture.phase,
			fictionCount: capture.records.filter(
				(record) => record.masterFolder === "fiction",
			).length,
			nonfictionCount: capture.records.filter(
				(record) => record.masterFolder === "nonfiction",
			).length,
			renameCount: capture.records.filter(
				(record) => record.status === "rename-required",
			).length,
			observedInventorySha256: capture.observedInventorySha256,
			targetInventorySha256: capture.targetInventorySha256,
		};
		if (values.json) console.log(JSON.stringify(summary));
		else {
			console.log(
				`Captured ${summary.fictionCount} Fiction + ${summary.nonfictionCount} Non-Fiction native Docs; phase=${summary.phase}; safe renames=${summary.renameCount}`,
			);
		}
		return 0;
	} catch (error) {
		if (
			error instanceof ProtonCloudError ||
			error?.name === "MediumContractError" ||
			error?.name === "ProtonContractError" ||
			error?.name === "ProtonNameError"
		) {
			console.error(`Proton cloud capture failed: ${error.message}`);
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
