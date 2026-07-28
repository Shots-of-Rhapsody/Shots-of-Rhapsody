#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	assertSafeRepositoryPath,
	DEFAULT_REPO_ROOT,
} from "../medium/lib/contract.js";
import {
	DEFAULT_CLOUD_CAPTURE_PATH,
	loadCloudCapture,
	ProtonCloudError,
	verifyCloudCaptureAgainstExpected,
} from "./cloud.mjs";
import { expectedMasterRecordsV2 } from "./lib.mjs";

const HELP = `Usage:
  node scripts/proton/cloud-verify.mjs [options]

Verifies the ignored, sanitized CLI capture against the current committed
writing inventory. Final mode fails until every observed cloud name equals its
deterministic Windows-safe target.

Options:
  --preflight         Permit exact, uniquely mapped legacy names
  --require-complete  Require exactly 11 Fiction and 24 Non-Fiction Docs
  --capture <path>    Ignored capture (default: ${DEFAULT_CLOUD_CAPTURE_PATH})
  --json              Emit machine-readable output
  --help              Show this help
`;

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				preflight: { type: "boolean", default: false },
				"require-complete": { type: "boolean", default: false },
				capture: { type: "string", default: DEFAULT_CLOUD_CAPTURE_PATH },
				json: { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			allowPositionals: false,
			strict: true,
		}).values;
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
		const requireComplete = values["require-complete"];
		const capturePath = assertSafeRepositoryPath(values.capture, "--capture");
		if (!capturePath.startsWith(".proton-import/")) {
			throw new ProtonCloudError(
				"Cloud capture input must stay under .proton-import",
			);
		}
		const expected = await expectedMasterRecordsV2({
			repoRoot: DEFAULT_REPO_ROOT,
		});
		const capture = await loadCloudCapture(
			path.join(DEFAULT_REPO_ROOT, ...capturePath.split("/")),
		);
		const verified = verifyCloudCaptureAgainstExpected(capture, expected, {
			requireComplete,
			requireFinal: !values.preflight,
		});
		const summary = {
			verifiedCount: verified.records.length,
			expectedCount: expected.length,
			fictionCount: verified.records.filter(
				(record) => record.masterFolder === "fiction",
			).length,
			nonfictionCount: verified.records.filter(
				(record) => record.masterFolder === "nonfiction",
			).length,
			cloudPhase: verified.phase,
			complete: verified.records.length === expected.length,
		};
		if (values.json) console.log(JSON.stringify(summary));
		else {
			console.log(
				`Verified Proton cloud inventory ${summary.verifiedCount}/${summary.expectedCount}; Fiction=${summary.fictionCount}; Non-Fiction=${summary.nonfictionCount}; phase=${summary.cloudPhase}`,
			);
		}
		return 0;
	} catch (error) {
		if (
			error instanceof ProtonCloudError ||
			error?.name === "ProtonContractError" ||
			error?.name === "ProtonNameError" ||
			error?.name === "MediumContractError"
		) {
			console.error(`Proton cloud verification failed: ${error.message}`);
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
