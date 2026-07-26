#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseApprovedMediumTitleFile } from "./lib/assets.js";
import { DEFAULT_REPO_ROOT, MediumContractError } from "./lib/contract.js";
import { decodeUtf8 } from "./lib/html.js";
import { createMediumInventoryReviewProposal } from "./lib/pipeline.js";

const APPROVED_TITLES_PATH = path.join(
	DEFAULT_REPO_ROOT,
	"provenance",
	"medium",
	"approved-titles.v1.json",
);

const HELP = `Usage:
  node scripts/medium/review-inventory.js <.medium-import/raw/export.zip> [options]

Builds a non-publishing disposition proposal from the exact ignored candidate
ledger and the committed, hash-bound 24-title allowlist. All 33 official export
candidates remain in the proposal. It does not create the reviewed inventory,
import an article or asset, or create human approval.

Options:
  --write  Create ignored .medium-import/inventory-review-proposal.json
  --json   Emit the complete proposal during a dry run
  --help   Show this help
`;

async function readApprovedAllowlist() {
	let buffer;
	try {
		buffer = await readFile(APPROVED_TITLES_PATH);
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new MediumContractError(
				"The committed Medium approved-title allowlist is missing",
			);
		}
		throw error;
	}
	if (buffer.byteLength > 64 * 1024) {
		throw new MediumContractError(
			"The committed Medium approved-title allowlist exceeds 65536 bytes",
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
				write: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: true,
			strict: true,
		});
		if (!parsed.values.help && parsed.positionals.length !== 1) {
			throw new MediumContractError("Provide exactly one official export ZIP");
		}
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
		const result = await createMediumInventoryReviewProposal({
			repoRoot: DEFAULT_REPO_ROOT,
			exportPath: parsed.positionals[0],
			approvedAllowlist: await readApprovedAllowlist(),
			write: parsed.values.write,
		});
		if (parsed.values.json) {
			console.log(JSON.stringify(result.proposal, null, 2));
		} else if (parsed.values.write) {
			console.log(`Wrote ignored proposal: ${result.reviewProposalPath}`);
		} else {
			console.log(
				`Medium disposition proposal dry-run: ${result.proposal.includedCount} included standalone essays, ${result.proposal.excludedResponseCount} excluded responses`,
			);
			console.log(
				"The committed reviewed inventory remains inactive until article records, original assets, and human approvals are complete.",
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof MediumContractError) {
			console.error(`Medium inventory proposal failed: ${error.message}`);
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
