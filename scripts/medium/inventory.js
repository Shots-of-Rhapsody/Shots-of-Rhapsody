#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT, MediumContractError } from "./lib/contract.js";
import { createInventoryCandidate } from "./lib/pipeline.js";

const HELP = `Usage:
  node scripts/medium/inventory.js <.medium-import/raw/export.zip> [options]

Reads only a locally downloaded official Medium account export. It never signs
in to, requests, or scrapes Medium. Output remains a review candidate until Tai
Song classifies every story.

Options:
  --captured-at <ISO>  Required with --write
  --write              Save ignored .medium-import/inventory-candidate.json
  --json               Emit machine-readable output
  --help               Show this help
`;

export async function main(argv = process.argv.slice(2)) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				"captured-at": { type: "string" },
				write: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: true,
			strict: true,
		});
		if (!parsed.values.help && parsed.positionals.length !== 1) {
			throw new MediumContractError("Provide exactly one official export ZIP");
		}
	} catch (error) {
		console.error(`Usage error: ${error.message}`);
		console.error(HELP);
		return 2;
	}
	if (parsed.values.help) {
		console.log(HELP);
		return 0;
	}
	try {
		const result = await createInventoryCandidate({
			repoRoot: DEFAULT_REPO_ROOT,
			exportPath: parsed.positionals[0],
			capturedAt: parsed.values["captured-at"],
			write: parsed.values.write,
		});
		if (parsed.values.json) console.log(JSON.stringify(result));
		else {
			console.log(
				`Medium inventory ${result.mode}: ${result.candidate.candidateCount} exported story candidates`,
			);
			console.log(
				"Every candidate still requires author review for public/original/standalone inclusion.",
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof MediumContractError) {
			console.error(`Medium inventory failed: ${error.message}`);
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
