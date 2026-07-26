#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	DEFAULT_REPO_ROOT,
	MediumContractError,
} from "../medium/lib/contract.js";
import { verifyProtonMasterExport } from "./proton-master.js";

const HELP = `Usage:
  node scripts/content/master-verify.js --slug <slug> <ignored-export.html> [options]

Compares a Proton Docs HTML export with the reviewed Medium snapshot and
approved local images. The export must be saved under .medium-import/.

Options:
  --slug <slug>  Reviewed Medium article slug
  --json         Emit machine-readable output
  --help         Show this help
`;

export async function main(argv = process.argv.slice(2)) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				slug: { type: "string" },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: true,
			strict: true,
		});
		if (
			!parsed.values.help &&
			(!parsed.values.slug || parsed.positionals.length !== 1)
		) {
			throw new MediumContractError(
				"Provide one --slug and one ignored Proton HTML export path",
			);
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
		const result = await verifyProtonMasterExport({
			repoRoot: DEFAULT_REPO_ROOT,
			slug: parsed.values.slug,
			exportPath: parsed.positionals[0],
		});
		if (parsed.values.json) {
			console.log(JSON.stringify(result));
		} else {
			console.log(
				`Verified Proton Non-Fiction master ${result.slug}: ${result.bodyBlockCount} exact body blocks`,
			);
			console.log(`Export SHA-256: ${result.exportSha256}`);
			console.log(`Hero pixels: ${result.heroPixelSha256}`);
		}
		return 0;
	} catch (error) {
		if (error instanceof MediumContractError) {
			console.error(`Proton master verification failed: ${error.message}`);
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
