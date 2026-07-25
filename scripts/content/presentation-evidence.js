#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	collectPresentationEvidence,
	verifyPresentationSignoffV2,
} from "./presentation.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function main() {
	const { values } = parseArgs({
		options: {
			release: { type: "string" },
			verify: { type: "boolean", default: false },
		},
		allowPositionals: false,
		strict: true,
	});
	if (!values.release)
		throw new Error("--release is required, for example --release v1.1.0");
	const input = {
		repoRoot: repositoryRoot,
		distRoot: path.join(repositoryRoot, "dist"),
		release: values.release,
	};
	const result = values.verify
		? await verifyPresentationSignoffV2({
				...input,
				ledger: JSON.parse(
					await readFile(
						path.join(
							repositoryRoot,
							"provenance",
							"reviews",
							"presentation-signoffs-v2.json",
						),
						"utf8",
					),
				),
			})
		: await collectPresentationEvidence(input);
	console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
