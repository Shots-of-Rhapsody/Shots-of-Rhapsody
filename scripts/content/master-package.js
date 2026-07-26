#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	DEFAULT_REPO_ROOT,
	MediumContractError,
} from "../medium/lib/contract.js";
import { createProtonMasterPackage } from "./proton-master.js";

const HELP = `Usage:
  node scripts/content/master-package.js --slug <slug> [options]

Builds one ignored, self-contained HTML package from reviewed and imported
Medium evidence. The default is a non-writing dry run.

Options:
  --slug <slug>  Reviewed Medium article slug
  --write        Create .medium-import/proton-masters/<slug>/master.html
  --json         Emit machine-readable output
  --help         Show this help
`;

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				slug: { type: "string" },
				write: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: false,
			strict: true,
		}).values;
		if (!values.help && !values.slug) {
			throw new MediumContractError("Provide exactly one --slug");
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
		const result = await createProtonMasterPackage({
			repoRoot: DEFAULT_REPO_ROOT,
			slug: values.slug,
			write: values.write,
		});
		if (values.json) {
			console.log(JSON.stringify(result));
		} else {
			console.log(
				`${values.write ? "Created" : "Validated"} Proton master package for ${result.slug}: ${result.outputPath}`,
			);
			console.log(`Document title: ${result.documentTitle}`);
			console.log(
				`Destination: ${result.destination} (flat; Fiction unchanged)`,
			);
			console.log(`SHA-256: ${result.sha256}`);
		}
		return 0;
	} catch (error) {
		if (error instanceof MediumContractError) {
			console.error(`Proton master package failed: ${error.message}`);
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
