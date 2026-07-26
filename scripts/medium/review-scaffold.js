#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	DEFAULT_REPO_ROOT,
	MediumContractError,
	serializeJson,
} from "./lib/contract.js";
import { createPendingMediumReviewScaffold } from "./lib/pipeline.js";

const HELP = `Usage:
  node scripts/medium/review-scaffold.js [--write] [--json]

Creates pending claim-review and content-signoff worksheets from the active
Medium manifest. A reviewer must either add reviewed claims or provide the
explicit no-material-claims rationale; these alternatives cannot be combined.
Hashes are current, but all human statuses remain explicitly pending/null. The
output can never validate as passed human evidence.

Options:
  --write  Create ignored .medium-import/pending-review-scaffolds.json
  --json   Emit the scaffold during a dry run
  --help   Show this help
`;

export async function main(argv = process.argv.slice(2)) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				write: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: false,
			strict: true,
		});
		if (parsed.values.write && parsed.values.json) {
			throw new MediumContractError("Use either --write or --json, not both");
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
		const result = await createPendingMediumReviewScaffold({
			repoRoot: DEFAULT_REPO_ROOT,
			write: parsed.values.write,
		});
		if (parsed.values.json)
			process.stdout.write(serializeJson(result.scaffold));
		else if (parsed.values.write) {
			console.log(`Wrote ignored pending scaffold: ${result.scaffoldPath}`);
		} else {
			console.log(
				`Pending Medium review scaffold dry-run: ${result.scaffold.articleCount} articles`,
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof MediumContractError) {
			console.error(`Medium review scaffold failed: ${error.message}`);
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
