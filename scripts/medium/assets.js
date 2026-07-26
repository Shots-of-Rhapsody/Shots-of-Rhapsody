#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseApprovedMediumTitleFile } from "./lib/assets.js";
import { DEFAULT_REPO_ROOT, MediumContractError } from "./lib/contract.js";
import { decodeUtf8 } from "./lib/html.js";
import { createMediumHeroChecklist } from "./lib/pipeline.js";

const HELP = `Usage:
  node scripts/medium/assets.js <.medium-import/raw/export.zip> [options]

Builds a local acquisition checklist for the explicitly approved Medium essay
titles. It reads only the official export and never makes a network request,
downloads an image, infers image metadata, or classifies another candidate.

Options:
  --titles-file <JSON>  Required hash-bound approved-title allowlist
  --write               Create ignored hero-acquisition-checklist.json
  --help                Show this help
`;

async function readApprovedAllowlist(filePath) {
	let buffer;
	try {
		buffer = await readFile(path.resolve(filePath));
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new MediumContractError(
				`Approved Medium title allowlist is missing: ${filePath}`,
			);
		}
		throw error;
	}
	if (buffer.byteLength > 64 * 1024) {
		throw new MediumContractError(
			"Approved Medium title allowlist exceeds the 65536-byte safety limit",
		);
	}
	return parseApprovedMediumTitleFile(
		decodeUtf8(buffer, "Approved Medium title allowlist"),
	);
}

export async function main(argv = process.argv.slice(2)) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				"titles-file": { type: "string" },
				write: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: true,
			strict: true,
		});
		if (!parsed.values.help && parsed.positionals.length !== 1) {
			throw new MediumContractError("Provide exactly one official export ZIP");
		}
		if (!parsed.values.help && parsed.values["titles-file"] === undefined) {
			throw new MediumContractError(
				"Provide the required --titles-file hash-bound allowlist",
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
		const approvedAllowlist = await readApprovedAllowlist(
			parsed.values["titles-file"],
		);
		const result = await createMediumHeroChecklist({
			repoRoot: DEFAULT_REPO_ROOT,
			exportPath: parsed.positionals[0],
			approvedAllowlist,
			write: parsed.values.write,
		});
		if (parsed.values.write) {
			console.log(`Wrote ignored checklist: ${result.checklistPath}`);
		} else {
			console.log(JSON.stringify(result.checklist, null, 2));
		}
		return 0;
	} catch (error) {
		if (error instanceof MediumContractError) {
			console.error(`Medium hero checklist failed: ${error.message}`);
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
