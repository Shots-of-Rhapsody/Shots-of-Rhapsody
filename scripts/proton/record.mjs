#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT } from "../medium/lib/contract.js";
import {
	createLedgerFromCapture,
	DEFAULT_CAPTURE_PATH,
	DEFAULT_LEDGER_PATH,
	loadCapture,
	ProtonContractError,
	writeLedgerNoOverwrite,
} from "./lib.mjs";

const HELP = `Usage:
  node scripts/proton/record.mjs [options]

Verifies all raw HTML exports and creates a sanitized 35-record ledger. This
command never edits article files, creates approvals, or overwrites a ledger.

Options:
  --capture <path>  Ignored normalized capture (default: ${DEFAULT_CAPTURE_PATH})
  --output <path>   New committed ledger path (default: ${DEFAULT_LEDGER_PATH})
  --json            Emit machine-readable output
  --help            Show this help
`;

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				capture: { type: "string", default: DEFAULT_CAPTURE_PATH },
				output: { type: "string", default: DEFAULT_LEDGER_PATH },
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
		const capture = await loadCapture({
			repoRoot: DEFAULT_REPO_ROOT,
			capturePath: values.capture,
		});
		const ledger = await createLedgerFromCapture({
			repoRoot: DEFAULT_REPO_ROOT,
			capture,
		});
		const outputPath = await writeLedgerNoOverwrite({
			repoRoot: DEFAULT_REPO_ROOT,
			ledger,
			outputPath: values.output,
		});
		const result = {
			outputPath,
			recordCount: ledger.records.length,
			complete: true,
		};
		if (values.json) console.log(JSON.stringify(result));
		else
			console.log(
				`Created ${outputPath} with ${result.recordCount} verified records`,
			);
		return 0;
	} catch (error) {
		if (error instanceof ProtonContractError) {
			console.error(`Proton ledger creation failed: ${error.message}`);
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
