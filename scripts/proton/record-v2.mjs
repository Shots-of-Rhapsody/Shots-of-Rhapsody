#!/usr/bin/env node

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
	DEFAULT_LEDGER_PATH_V2,
	loadCaptureV2,
	writeLedgerV2NoOverwrite,
} from "./v2.mjs";

const HELP = `Usage:
  node scripts/proton/record-v2.mjs --cloud <path> [options]

Creates the first committed V2 ledger from 35 fresh, timestamped HTML exports.
The command requires a final cloud inventory and never overwrites a ledger.

Options:
  --capture <path>  Ignored V2 export capture (default: ${DEFAULT_CAPTURE_PATH_V2})
  --cloud <path>    Explicit ignored final cloud capture
  --output <path>   New committed ledger (default: ${DEFAULT_LEDGER_PATH_V2})
  --json            Emit machine-readable output
  --help            Show this help
`;

function ignoredPath(value, label) {
	const safe = assertSafeRepositoryPath(value, label);
	if (!safe.startsWith(".proton-import/")) {
		throw new ProtonContractError(`${label} must stay under .proton-import`);
	}
	return safe;
}

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				capture: { type: "string", default: DEFAULT_CAPTURE_PATH_V2 },
				cloud: { type: "string" },
				output: { type: "string", default: DEFAULT_LEDGER_PATH_V2 },
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
		const capturePath = ignoredPath(values.capture, "--capture");
		const cloudPath = ignoredPath(values.cloud, "--cloud");
		const outputPath = assertSafeRepositoryPath(values.output, "--output");
		if (!outputPath.startsWith("provenance/proton/")) {
			throw new ProtonContractError(
				"--output must stay under provenance/proton",
			);
		}
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
		const capture = await loadCaptureV2({
			repoRoot: DEFAULT_REPO_ROOT,
			capturePath,
			requireComplete: true,
		});
		const ledger = await createLedgerV2FromCapture({
			repoRoot: DEFAULT_REPO_ROOT,
			capture,
			cloudCapture,
		});
		await writeLedgerV2NoOverwrite({
			repoRoot: DEFAULT_REPO_ROOT,
			ledger,
			outputPath,
		});
		const summary = {
			outputPath,
			recordCount: ledger.records.length,
			fictionCount: ledger.records.filter(
				(record) => record.masterFolder === "fiction",
			).length,
			nonfictionCount: ledger.records.filter(
				(record) => record.masterFolder === "nonfiction",
			).length,
			cloudPhase: ledger.cloudInventory.phase,
			previousLedgerSha256: ledger.previousLedgerSha256,
		};
		if (values.json) console.log(JSON.stringify(summary));
		else {
			console.log(
				`Created Proton V2 ledger with ${summary.fictionCount} Fiction and ${summary.nonfictionCount} Non-Fiction records; cloud=${summary.cloudPhase}`,
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
			console.error(`Proton V2 ledger creation failed: ${error.message}`);
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
