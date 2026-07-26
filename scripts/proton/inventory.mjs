#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT } from "../medium/lib/contract.js";
import {
	DEFAULT_CAPTURE_PATH,
	expectedInventory,
	loadCapture,
	ProtonContractError,
	verifyCaptureInventory,
} from "./lib.mjs";

const HELP = `Usage:
  node scripts/proton/inventory.mjs [options]

Options:
  --capture <path>  Ignored normalized capture (default: ${DEFAULT_CAPTURE_PATH})
  --expected        Print the exact committed slug/title inventory without raw evidence
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
				expected: { type: "boolean", default: false },
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
		const result = values.expected
			? await expectedInventory({ repoRoot: DEFAULT_REPO_ROOT })
			: await verifyCaptureInventory({
					repoRoot: DEFAULT_REPO_ROOT,
					capture: await loadCapture({
						repoRoot: DEFAULT_REPO_ROOT,
						capturePath: values.capture,
					}),
				});
		if (values.json) console.log(JSON.stringify(result));
		else if (values.expected) {
			console.log(
				`Expected Proton inventory: ${result.sections.fiction.length} Fiction + ${result.sections.nonfiction.length} Non-Fiction = ${result.expectedCount}`,
			);
		} else {
			console.log(
				`Verified Proton inventory: ${result.fictionCount} Fiction + ${result.nonfictionCount} Non-Fiction = ${result.totalCount}`,
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof ProtonContractError) {
			console.error(`Proton inventory verification failed: ${error.message}`);
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
