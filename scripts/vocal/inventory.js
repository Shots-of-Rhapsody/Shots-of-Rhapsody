#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ContractError, DEFAULT_REPO_ROOT } from "./lib/contract.js";
import { inspectInventoryArticles } from "./lib/pipeline.js";

const HELP = `Usage:
  node scripts/vocal/inventory.js --slug <slug> [--slug <slug> ...] [options]
  node scripts/vocal/inventory.js --all [options]

Reads only locally saved page.html files. It never downloads images or pages.

Options:
  --slug <slug>  Inspect one fixed-inventory slug; may be repeated
  --all          Inspect every article in the fixed inventory
  --json         Emit a machine-readable result
  --help         Show this help
`;

function parseOptions(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			slug: { type: "string", multiple: true },
			all: { type: "boolean", default: false },
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
	}
	return values;
}

function printHumanResult(result) {
	for (const article of result.articles) {
		console.log(`${article.slug}:`);
		console.log(`  title: ${article.title}`);
		console.log(`  source: ${article.sourceUrl}`);
		console.log(`  hero-original.png: ${article.heroImageUrl}`);
	}
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
		const result = await inspectInventoryArticles({
			repoRoot: DEFAULT_REPO_ROOT,
			slugs: values.slug,
			all: values.all,
		});
		if (values.json) console.log(JSON.stringify(result));
		else printHumanResult(result);
		return 0;
	} catch (error) {
		if (error instanceof ContractError) {
			console.error(`Vocal inventory inspection failed: ${error.message}`);
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
