#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ContractError, DEFAULT_REPO_ROOT } from "./lib/contract.js";
import { verifyArticles } from "./lib/pipeline.js";

const HELP = `Usage:
  node scripts/vocal/verify.js [--slug <slug> ...] [options]

Options:
  --slug <slug>       Verify one imported slug; may be repeated
  --with-raw          Re-extract and compare ignored local raw inputs
  --require-complete  Require every fixed-inventory article and word count
  --json              Emit a machine-readable result
  --help              Show this help
`;

function parseOptions(argv) {
	const { values } = parseArgs({
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
	});
	return values;
}

function printHumanResult(result) {
	for (const article of result.articles) {
		console.log(`- ${article.slug}: ${article.status}`);
	}
	console.log(
		`Verified ${result.importedCount}/${result.expectedCount} imported articles; complete=${result.complete}`,
	);
}

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseOptions(argv);
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
		const result = await verifyArticles({
			repoRoot: DEFAULT_REPO_ROOT,
			slugs: values.slug,
			withRaw: values["with-raw"],
			requireComplete: values["require-complete"],
		});
		if (values.json) console.log(JSON.stringify(result));
		else printHumanResult(result);
		return 0;
	} catch (error) {
		if (error instanceof ContractError) {
			console.error(`Vocal verification failed: ${error.message}`);
			return 1;
		}
		throw error;
	}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().then((exitCode) => {
		process.exitCode = exitCode;
	});
}
