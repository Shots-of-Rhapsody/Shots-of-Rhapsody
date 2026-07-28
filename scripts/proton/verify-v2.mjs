#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	assertSafeRepositoryPath,
	DEFAULT_REPO_ROOT,
} from "../medium/lib/contract.js";
import {
	DEFAULT_CLOUD_CAPTURE_PATH,
	loadCloudCapture,
	ProtonCloudError,
	verifyCloudCaptureAgainstExpected,
} from "./cloud.mjs";
import { expectedMasterRecordsV2, ProtonContractError } from "./lib.mjs";
import {
	DEFAULT_CAPTURE_PATH_V2,
	DEFAULT_LEDGER_PATH_V2,
	loadCaptureV2,
	loadLedgerV2,
	verifyLedgerV2Evidence,
} from "./v2.mjs";

const HELP = `Usage:
  node scripts/proton/verify-v2.mjs [options]

Verifies the committed V2 master ledger. Raw mode also reparses all 35 ignored,
timestamped HTML exports and requires the exact sanitized cloud binding.

Options:
  --with-raw            Reparse and compare ignored HTML/image exports
  --with-cloud          Compare the ignored sanitized cloud capture
  --require-complete    Require exactly 11 Fiction and 24 Non-Fiction records
  --require-final-cloud Require final Windows-safe cloud names
  --capture <path>      Ignored V2 export capture (default: ${DEFAULT_CAPTURE_PATH_V2})
  --cloud <path>        Ignored cloud capture (default: ${DEFAULT_CLOUD_CAPTURE_PATH})
  --ledger <path>       Committed V2 ledger (default: ${DEFAULT_LEDGER_PATH_V2})
  --json                Emit machine-readable output
  --help                Show this help
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
				"with-raw": { type: "boolean", default: false },
				"with-cloud": { type: "boolean", default: false },
				"require-complete": { type: "boolean", default: false },
				"require-final-cloud": { type: "boolean", default: false },
				capture: { type: "string", default: DEFAULT_CAPTURE_PATH_V2 },
				cloud: { type: "string", default: DEFAULT_CLOUD_CAPTURE_PATH },
				ledger: { type: "string", default: DEFAULT_LEDGER_PATH_V2 },
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
		const requireComplete = values["require-complete"];
		const withRaw = values["with-raw"];
		const withCloud = values["with-cloud"] || withRaw;
		const ledgerPath = assertSafeRepositoryPath(values.ledger, "--ledger");
		if (!ledgerPath.startsWith("provenance/proton/")) {
			throw new ProtonContractError(
				"--ledger must stay under provenance/proton",
			);
		}
		const capturePath = ignoredPath(values.capture, "--capture");
		const cloudPath = ignoredPath(values.cloud, "--cloud");
		const ledger = await loadLedgerV2({
			repoRoot: DEFAULT_REPO_ROOT,
			ledgerPath,
			requireComplete,
		});
		const capture = withRaw
			? await loadCaptureV2({
					repoRoot: DEFAULT_REPO_ROOT,
					capturePath,
					requireComplete,
				})
			: undefined;
		const cloudCapture = withCloud
			? verifyCloudCaptureAgainstExpected(
					await loadCloudCapture(
						path.join(DEFAULT_REPO_ROOT, ...cloudPath.split("/")),
					),
					await expectedMasterRecordsV2({ repoRoot: DEFAULT_REPO_ROOT }),
					{
						requireComplete,
						requireFinal: values["require-final-cloud"],
					},
				)
			: undefined;
		const result = await verifyLedgerV2Evidence({
			repoRoot: DEFAULT_REPO_ROOT,
			ledger,
			capture,
			cloudCapture,
			withRaw,
			withCloud,
			requireComplete,
			requireFinalCloud: values["require-final-cloud"],
		});
		if (values.json) console.log(JSON.stringify(result));
		else {
			console.log(
				`Verified ${result.verifiedCount}/${result.expectedCount} Proton V2 master bindings; raw=${result.withRaw}; cloud=${result.withCloud}; phase=${result.cloudPhase}`,
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
			console.error(`Proton V2 verification failed: ${error.message}`);
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
