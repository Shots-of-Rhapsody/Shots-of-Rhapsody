#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseApprovedMediumTitleFile } from "./lib/assets.js";
import {
	DEFAULT_REPO_ROOT,
	MediumContractError,
	serializeJson,
} from "./lib/contract.js";
import { serializeReviewedMediumInventory } from "./lib/finalize.js";
import { decodeUtf8 } from "./lib/html.js";
import { createReviewedMediumInventory } from "./lib/pipeline.js";

const HELP = `Usage:
  node scripts/medium/finalize-inventory.js <.medium-import/raw/medium-export.zip> [options]

Rebuilds the reviewed 33-candidate proposal from local evidence, verifies all
24 sanitized heroes, and emits a non-publishing inventory scaffold. Supplying
an explicitly authored summary-fallback file can finalize a reviewed inventory;
the command never creates content, rights, or presentation signoff.

Options:
  --fallbacks <JSON>  Exact source-missing public-summary fallback record
  --write-scaffold    Create ignored reviewed-inventory-scaffold.json
  --write-inventory   Replace only the validated awaiting-export placeholder
  --json              Emit the scaffold or finalized inventory
  --help              Show this help
`;

async function readSmallJson(filePath, label) {
	let buffer;
	try {
		buffer = await readFile(path.resolve(filePath));
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new MediumContractError(`${label} is missing: ${filePath}`);
		}
		throw error;
	}
	if (buffer.byteLength > 1024 * 1024) {
		throw new MediumContractError(`${label} exceeds the 1 MiB safety limit`);
	}
	try {
		return JSON.parse(decodeUtf8(buffer, label));
	} catch (error) {
		if (error instanceof MediumContractError) throw error;
		throw new MediumContractError(`${label} is not valid JSON`, {
			cause: error,
		});
	}
}

export async function main(argv = process.argv.slice(2)) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				fallbacks: { type: "string" },
				"write-scaffold": { type: "boolean", default: false },
				"write-inventory": { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: true,
			strict: true,
		});
		if (!parsed.values.help && parsed.positionals.length !== 1) {
			throw new MediumContractError("Provide exactly one official export ZIP");
		}
		if (
			parsed.values["write-inventory"] &&
			(parsed.values.fallbacks === undefined ||
				parsed.values.json ||
				parsed.values["write-scaffold"])
		) {
			throw new MediumContractError(
				"--write-inventory requires --fallbacks and cannot be combined with --json or --write-scaffold",
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
		const approvedAllowlist = parseApprovedMediumTitleFile(
			await readFile(
				path.join(
					DEFAULT_REPO_ROOT,
					"provenance",
					"medium",
					"approved-titles.v1.json",
				),
				"utf8",
			),
		);
		const summaryFallbacks = parsed.values.fallbacks
			? await readSmallJson(parsed.values.fallbacks, "Medium summary fallbacks")
			: undefined;
		const result = await createReviewedMediumInventory({
			repoRoot: DEFAULT_REPO_ROOT,
			exportPath: parsed.positionals[0],
			approvedAllowlist,
			summaryFallbacks,
			writeScaffold: parsed.values["write-scaffold"],
			writeInventory: parsed.values["write-inventory"],
		});
		if (parsed.values.json) {
			process.stdout.write(
				result.inventory
					? serializeReviewedMediumInventory(result.inventory)
					: serializeJson(result.scaffold),
			);
		} else {
			if (result.mode === "write-inventory") {
				console.log(
					"Replaced the awaiting-export Medium inventory with the validated reviewed inventory.",
				);
				return 0;
			}
			console.log(
				`Medium inventory scaffold verified: ${result.scaffold.articles.length} included essays, ${result.scaffold.pendingSummarySlugs.length} source-missing summaries`,
			);
			if (result.inventory) {
				console.log(
					"A reviewed inventory was generated in memory; no file was published or approved.",
				);
			} else {
				console.log(
					"Provide an explicit --fallbacks record before final inventory generation.",
				);
			}
		}
		return 0;
	} catch (error) {
		if (error instanceof MediumContractError) {
			console.error(`Medium inventory finalization failed: ${error.message}`);
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
