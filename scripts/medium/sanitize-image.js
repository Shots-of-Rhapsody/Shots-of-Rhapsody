#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadMediumHeroAcquisition } from "./lib/acquisition.js";
import { DEFAULT_REPO_ROOT, MediumContractError } from "./lib/contract.js";
import {
	sanitizeMediumHero,
	sanitizeMediumHeroes,
} from "./lib/image-sanitizer.js";

const HELP = `Usage:
  node scripts/medium/sanitize-image.js (--slug <slug> | --all) [options]

Reads only .medium-import/raw/assets/<slug>/hero-medium.webp, which is the
highest responsive Medium derivative captured through the author's browser.
It is not represented as the original upload. The command re-encodes decoded
pixels as metadata-free lossless WebP, verifies dimensions and decoded pixels,
and targets .medium-import/site-ready/assets/<slug>/hero-sanitized.webp.

Options:
  --slug <slug>  Sanitize exactly one approved article slug
  --all          Sanitize the exact 24 slugs bound by the committed asset
                 anchor and exact ignored acquisition ledger
  --write        Create the ignored site-ready image and verification record
  --json         Emit the complete verification record during a dry run
  --help         Show this help
`;

async function approvedHeroSlugs(repoRoot) {
	const loadedAcquisition = await loadMediumHeroAcquisition(repoRoot);
	const slugs = loadedAcquisition.assetLedger.items.map((item) => item.slug);
	if (
		slugs.length !== loadedAcquisition.assetLedger.itemCount ||
		new Set(slugs).size !== slugs.length
	) {
		throw new MediumContractError(
			"Medium hero asset anchor did not resolve exactly one unique slug per approved title",
		);
	}
	return { slugs, loadedAcquisition };
}

export async function main(argv = process.argv.slice(2)) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				slug: { type: "string" },
				all: { type: "boolean", default: false },
				write: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: false,
			strict: true,
		});
		if (
			!parsed.values.help &&
			(parsed.values.slug === undefined) === !parsed.values.all
		) {
			throw new MediumContractError("Provide exactly one of --slug or --all");
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
		if (parsed.values.all) {
			const { slugs, loadedAcquisition } =
				await approvedHeroSlugs(DEFAULT_REPO_ROOT);
			const batch = await sanitizeMediumHeroes({
				repoRoot: DEFAULT_REPO_ROOT,
				slugs,
				write: parsed.values.write,
				loadedAcquisition,
			});
			if (parsed.values.json) {
				console.log(
					JSON.stringify(
						{
							mode: batch.mode,
							selection: "durable-medium-hero-asset-ledger",
							count: batch.results.length,
							records: batch.results.map((result) => result.record),
						},
						null,
						2,
					),
				);
			} else if (parsed.values.write) {
				for (const result of batch.results) {
					console.log(`Wrote ignored site-ready image: ${result.outputPath}`);
					console.log(
						`Wrote ignored verification record: ${result.recordPath}`,
					);
				}
				console.log(
					`Sanitized all ${batch.results.length} approved Medium hero captures.`,
				);
			} else {
				console.log(
					`Medium hero sanitization dry-run passed for all ${batch.results.length} durably bound slugs.`,
				);
				console.log(
					"No article, public asset, inventory, or approval was created.",
				);
			}
			return 0;
		}
		const result = await sanitizeMediumHero({
			repoRoot: DEFAULT_REPO_ROOT,
			slug: parsed.values.slug,
			write: parsed.values.write,
		});
		if (parsed.values.json) {
			console.log(JSON.stringify(result.record, null, 2));
		} else if (parsed.values.write) {
			console.log(`Wrote ignored site-ready image: ${result.outputPath}`);
			console.log(`Wrote ignored verification record: ${result.recordPath}`);
		} else {
			console.log(
				`Medium hero sanitization dry-run passed: ${result.record.output.width}x${result.record.output.height}, ${result.record.output.byteSize} bytes`,
			);
			console.log(
				"No article, public asset, inventory, or approval was created.",
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof MediumContractError) {
			console.error(`Medium image sanitization failed: ${error.message}`);
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
