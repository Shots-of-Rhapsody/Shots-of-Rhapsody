#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT, MediumContractError } from "./lib/contract.js";
import { importMediumArticles } from "./lib/pipeline.js";

const HELP = `Usage:
  node scripts/medium/import.js --slug <slug> [--slug <slug> ...] [options]
  node scripts/medium/import.js --all [options]

Requires a reviewed committed inventory, the exact ignored official export ZIP,
and reviewed original images. The default is a read-only dry run.

Options:
  --slug <slug>  Import one reviewed article; may be repeated
  --all          Import every reviewed article
  --write        Apply the reviewed plan
  --update       Replace only outputs matching their current manifest hashes
  --json         Emit machine-readable output
  --help         Show this help
`;

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				slug: { type: "string", multiple: true },
				all: { type: "boolean", default: false },
				write: { type: "boolean", default: false },
				update: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: false,
			strict: true,
		}).values;
		if (!values.help) {
			const hasSlugs = Array.isArray(values.slug) && values.slug.length > 0;
			if (hasSlugs === values.all) {
				throw new MediumContractError(
					"Select either --slug or --all, but not both",
				);
			}
			if (values.update && !values.write) {
				throw new MediumContractError("--update requires --write");
			}
		}
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
		const result = await importMediumArticles({
			repoRoot: DEFAULT_REPO_ROOT,
			slugs: values.slug,
			all: values.all,
			write: values.write,
			update: values.update,
		});
		if (values.json) console.log(JSON.stringify(result));
		else {
			console.log(`Medium import ${result.mode}:`);
			for (const article of result.articles) {
				console.log(`- ${article.slug}: ${JSON.stringify(article.actions)}`);
			}
			console.log(`- manifest=${result.manifestAction}`);
		}
		return 0;
	} catch (error) {
		if (error instanceof MediumContractError) {
			console.error(`Medium import failed: ${error.message}`);
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
