#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	DEFAULT_REPO_ROOT,
	MediumContractError,
	serializeJson,
} from "./lib/contract.js";
import { verifyMediumHeroAnchor } from "./lib/pipeline.js";

const HELP = `Usage:
  node scripts/medium/hero-anchor.js [--json]

Verifies the ignored 24-item acquisition ledger, committed durable anchor,
captured WebP bytes, metadata-free site-ready bytes, sanitization records, and
decoded-pixel equality. It performs no network requests and writes no files.
`;

export async function main(argv = process.argv.slice(2)) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: false,
			strict: true,
		});
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
		const result = await verifyMediumHeroAnchor({
			repoRoot: DEFAULT_REPO_ROOT,
		});
		if (parsed.values.json) process.stdout.write(serializeJson(result));
		else {
			console.log(
				`Medium durable hero anchor verified: ${result.itemCount} metadata-free, pixel-identical assets`,
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof MediumContractError) {
			console.error(`Medium hero anchor verification failed: ${error.message}`);
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
