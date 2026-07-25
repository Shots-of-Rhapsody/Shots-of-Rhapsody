#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT, MediumContractError } from "./lib/contract.js";
import { verifyMediumArticles } from "./lib/pipeline.js";

const HELP = `Usage:
  node scripts/medium/verify.js [--slug <slug> ...] [options]

Options:
  --slug <slug>       Verify one imported slug; may be repeated
  --with-raw          Re-extract ignored official-export evidence
  --require-complete  Require every reviewed Medium article
  --json              Emit machine-readable output
  --help              Show this help
`;

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				slug: { type: "string", multiple: true },
				"with-raw": { type: "boolean", default: false },
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
		const result = await verifyMediumArticles({
			repoRoot: DEFAULT_REPO_ROOT,
			slugs: values.slug,
			withRaw: values["with-raw"],
			requireComplete: values["require-complete"],
		});
		if (values.json) console.log(JSON.stringify(result));
		else {
			for (const article of result.articles) {
				console.log(`- ${article.slug}: ${article.status}`);
			}
			console.log(
				`Verified ${result.importedCount}/${result.expectedCount} Medium articles; complete=${result.complete}`,
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof MediumContractError) {
			console.error(`Medium verification failed: ${error.message}`);
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
