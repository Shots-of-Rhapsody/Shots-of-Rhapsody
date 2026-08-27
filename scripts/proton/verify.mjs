#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT } from "../medium/lib/contract.js";
import {
	DEFAULT_CAPTURE_PATH,
	DEFAULT_LEDGER_PATH,
	loadCapture,
	loadLedger,
	ProtonContractError,
	verifyLedgerEvidence,
} from "./lib.mjs";

const HELP = `Usage:
  node scripts/proton/verify.mjs [options]

Options:
  --with-raw          Re-parse and compare ignored HTML exports
  --require-complete  Require exactly 35 records and raw captures when requested
  --capture <path>    Ignored normalized capture (default: ${DEFAULT_CAPTURE_PATH})
  --ledger <path>     Sanitized committed ledger (default: ${DEFAULT_LEDGER_PATH})
  --json              Emit machine-readable output
  --help              Show this help
`;

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				"with-raw": { type: "boolean", default: false },
				"require-complete": { type: "boolean", default: false },
				capture: { type: "string", default: DEFAULT_CAPTURE_PATH },
				ledger: { type: "string", default: DEFAULT_LEDGER_PATH },
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
		const ledger = await loadLedger({
			repoRoot: DEFAULT_REPO_ROOT,
			ledgerPath: values.ledger,
			requireComplete: values["require-complete"],
		});
		const capture = values["with-raw"]
			? await loadCapture({
					repoRoot: DEFAULT_REPO_ROOT,
					capturePath: values.capture,
				})
			: undefined;
		const result = await verifyLedgerEvidence({
			repoRoot: DEFAULT_REPO_ROOT,
			ledger,
			capture,
			withRaw: values["with-raw"],
			requireComplete: values["require-complete"],
		});
		if (values.json) console.log(JSON.stringify(result));
		else {
			console.log(
				`Verified ${result.verifiedCount}/${result.expectedCount} Proton master bindings; raw=${result.withRaw}; complete=${result.complete}`,
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof ProtonContractError) {
			console.error(`Proton master verification failed: ${error.message}`);
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
