#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ContractError, DEFAULT_REPO_ROOT } from "./lib/contract.js";
import { importArticles } from "./lib/pipeline.js";

const HELP = `Usage:
  node scripts/vocal/import.js --slug <slug> [--slug <slug> ...] [options]
  node scripts/vocal/import.js --all [options]

Options:
  --slug <slug>       Import one fixed-inventory slug; may be repeated
  --all               Import every article in the fixed inventory
  --captured-at <ISO> Required for the first write of an article
  --write             Apply the plan (default is read-only dry-run)
  --update            Safely update outputs that still match manifest hashes
  --json              Emit a machine-readable result
  --help              Show this help
`;

function parseOptions(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			slug: { type: "string", multiple: true },
			all: { type: "boolean", default: false },
			"captured-at": { type: "string" },
			write: { type: "boolean", default: false },
			update: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
		allowPositionals: false,
		strict: true,
	});
	if (!values.help) {
		const hasSlugs = Array.isArray(values.slug) && values.slug.length > 0;
		if (hasSlugs === values.all) {
			throw new ContractError("Select either --slug or --all, but not both");
		}
		if (values.update && !values.write) {
			throw new ContractError("--update requires --write");
		}
	}
	return values;
}

function printHumanResult(result) {
	console.log(`Vocal import ${result.mode}:`);
	for (const article of result.articles) {
		const actions = Object.entries(article.actions)
			.map(([name, action]) => `${name}=${action}`)
			.join(", ");
		console.log(`- ${article.slug}: ${actions}`);
		if (article.capturedAtRequired) {
			console.log("  first write requires --captured-at <canonical UTC ISO timestamp>");
		}
	}
	console.log(`- manifest=${result.manifestAction}`);
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
		const result = await importArticles({
			repoRoot: DEFAULT_REPO_ROOT,
			slugs: values.slug,
			all: values.all,
			write: values.write,
			update: values.update,
			capturedAt: values["captured-at"],
		});
		if (values.json) console.log(JSON.stringify(result));
		else printHumanResult(result);
		return 0;
	} catch (error) {
		if (error instanceof ContractError) {
			console.error(`Vocal import failed: ${error.message}`);
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
