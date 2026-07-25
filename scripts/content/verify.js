#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	DEFAULT_REPO_ROOT,
	MediumContractError,
} from "../medium/lib/contract.js";
import { verifyAggregateContent } from "../medium/lib/pipeline.js";

const HELP = `Usage:
  node scripts/content/verify.js [--require-complete] [--json]
`;

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				"require-complete": { type: "boolean", default: false },
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
		const result = await verifyAggregateContent({
			repoRoot: DEFAULT_REPO_ROOT,
			requireComplete: values["require-complete"],
		});
		if (values.json) console.log(JSON.stringify(result));
		else {
			console.log(
				`Verified ${result.publishedCount} aggregate writing records; complete=${result.complete}`,
			);
		}
		return 0;
	} catch (error) {
		if (
			error instanceof MediumContractError ||
			error?.name === "ContractError"
		) {
			console.error(`Content verification failed: ${error.message}`);
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
