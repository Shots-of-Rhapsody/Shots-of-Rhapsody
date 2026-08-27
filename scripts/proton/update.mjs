#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	assertSafeRepositoryPath,
	assertSha256,
	assertSlug,
	DEFAULT_REPO_ROOT,
	serializeJson,
} from "../medium/lib/contract.js";
import {
	loadCloudCapture,
	ProtonCloudError,
	verifyCloudCaptureAgainstExpected,
} from "./cloud.mjs";
import { expectedMasterRecordsV2, ProtonContractError } from "./lib.mjs";
import {
	createLedgerV2FromCapture,
	DEFAULT_CAPTURE_PATH_V2,
	DEFAULT_LEDGER_PATH_V2,
	ledgerV2FileSha256,
	loadCaptureV2,
	loadLedgerV2,
	validateLedgerV2,
} from "./v2.mjs";

export const PROTON_UPDATE_PLAN_VERSION = 1;

const MUTABLE_RECORD_FIELDS = new Set([
	"exportedAt",
	"exportSha256",
	"semanticSha256",
	"heroSha256",
	"heroPixelSha256",
	"heroSourceSha256",
	"sourceSnapshotSha256",
	"siteOutputSha256",
	"bodyBlockCount",
]);
const CONTENT_EVIDENCE_FIELDS = new Set([
	"semanticSha256",
	"heroSha256",
	"heroPixelSha256",
	"sourceSnapshotSha256",
	"siteOutputSha256",
	"bodyBlockCount",
]);

const HELP = `Usage:
  node scripts/proton/update.mjs --slug <slug> --previous-ledger-sha <sha256> --cloud <path> [options]

Regenerates the full V2 ledger from ignored evidence, then permits exactly one
named work to differ. Dry-run is the default. --write atomically replaces the
tracked V2 ledger only while its bytes still match --previous-ledger-sha.

Options:
  --slug <slug>                 The only work allowed to change
  --previous-ledger-sha <sha>  Exact current V2 ledger SHA-256
  --capture <path>              Ignored V2 export capture (default: ${DEFAULT_CAPTURE_PATH_V2})
  --cloud <path>                Explicit ignored final cloud capture
  --ledger <path>               Committed V2 ledger (default: ${DEFAULT_LEDGER_PATH_V2})
  --write                       Apply the verified one-work ledger replacement
  --json                        Emit machine-readable output
  --help                        Show this help
`;

function digest(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function ignoredPath(value, label) {
	const safe = assertSafeRepositoryPath(value, label);
	if (!safe.startsWith(".proton-import/")) {
		throw new ProtonContractError(`${label} must stay under .proton-import`);
	}
	return safe;
}

function ledgerRecordMap(ledger) {
	return new Map(ledger.records.map((record) => [record.slug, record]));
}

export function createLedgerUpdatePlan({
	previousLedger,
	nextLedger,
	previousLedgerSha256,
	slug,
}) {
	const previous = validateLedgerV2(previousLedger, { requireComplete: true });
	const next = validateLedgerV2(nextLedger, { requireComplete: true });
	const expectedPreviousSha = assertSha256(
		previousLedgerSha256,
		"previousLedgerSha256",
	);
	const canonicalPreviousSha = digest(
		Buffer.from(serializeJson(previous), "utf8"),
	);
	if (expectedPreviousSha !== canonicalPreviousSha) {
		throw new ProtonContractError(
			"previousLedgerSha256 does not match the canonical previous ledger",
		);
	}
	const targetSlug = assertSlug(slug, "slug");
	if (
		previous.cloudInventory.phase !== "final" ||
		next.cloudInventory.phase !== "final"
	) {
		throw new ProtonContractError(
			"Proton updates require final Windows-safe cloud inventories",
		);
	}
	for (const key of [
		"schemaVersion",
		"semanticModelVersion",
		"expectedCount",
		"previousLedgerSha256",
	]) {
		if (previous[key] !== next[key]) {
			throw new ProtonContractError(
				`Proton update changes unrelated ledger field ${key}`,
			);
		}
	}
	for (const key of ["phase", "observedSha256", "targetSha256"]) {
		if (previous.cloudInventory[key] !== next.cloudInventory[key]) {
			throw new ProtonContractError(
				`Proton update changes unrelated cloud field ${key}`,
			);
		}
	}
	const previousBySlug = ledgerRecordMap(previous);
	const nextBySlug = ledgerRecordMap(next);
	if (!previousBySlug.has(targetSlug) || !nextBySlug.has(targetSlug)) {
		throw new ProtonContractError(
			`Proton update slug ${targetSlug} is unknown`,
		);
	}
	const changedSlugs = [];
	for (const [recordSlug, previousRecord] of previousBySlug) {
		if (
			serializeJson(previousRecord) !==
			serializeJson(nextBySlug.get(recordSlug))
		) {
			changedSlugs.push(recordSlug);
		}
	}
	if (changedSlugs.length !== 1 || changedSlugs[0] !== targetSlug) {
		throw new ProtonContractError(
			`Proton update must change only ${targetSlug}; changed=${changedSlugs.length}`,
		);
	}
	const previousRecord = previousBySlug.get(targetSlug);
	const nextRecord = nextBySlug.get(targetSlug);
	const changedFields = Object.keys(previousRecord)
		.filter((key) => previousRecord[key] !== nextRecord[key])
		.sort((left, right) => left.localeCompare(right, "en"));
	for (const field of changedFields) {
		if (!MUTABLE_RECORD_FIELDS.has(field)) {
			throw new ProtonContractError(
				`Proton update changes immutable record field ${field}`,
			);
		}
	}
	if (!changedFields.some((field) => CONTENT_EVIDENCE_FIELDS.has(field))) {
		throw new ProtonContractError(
			"Proton update changes export bookkeeping but no content evidence",
		);
	}
	if (new Date(nextRecord.exportedAt) <= new Date(previousRecord.exportedAt)) {
		throw new ProtonContractError(
			"Proton update export timestamp must advance for the changed work",
		);
	}
	return {
		schemaVersion: PROTON_UPDATE_PLAN_VERSION,
		slug: targetSlug,
		previousLedgerSha256: expectedPreviousSha,
		nextLedgerSha256: digest(Buffer.from(serializeJson(next), "utf8")),
		changedFields,
		invalidatedContentApprovals: [targetSlug],
		nonTargetChanges: 0,
	};
}

async function currentFileDigest(absolutePath) {
	const status = await lstat(absolutePath, { bigint: true });
	if (!status.isFile() || status.isSymbolicLink()) {
		throw new ProtonContractError("The V2 ledger must be a regular file");
	}
	const handle = await open(absolutePath, "r");
	try {
		const opened = await handle.stat({ bigint: true });
		if (
			opened.dev !== status.dev ||
			opened.ino !== status.ino ||
			opened.size !== status.size
		) {
			throw new ProtonContractError("The V2 ledger changed while opening");
		}
		return digest(await handle.readFile());
	} finally {
		await handle.close().catch(() => {});
	}
}

export async function replaceLedgerIfUnchanged({
	absolutePath,
	expectedSha256,
	nextLedger,
}) {
	const expected = assertSha256(expectedSha256, "expectedSha256");
	if ((await currentFileDigest(absolutePath)) !== expected) {
		throw new ProtonContractError(
			"The V2 ledger bytes changed after the update was prepared",
		);
	}
	const normalized = validateLedgerV2(nextLedger, { requireComplete: true });
	const bytes = Buffer.from(serializeJson(normalized), "utf8");
	const tempPath = `${absolutePath}.${randomUUID()}.tmp`;
	let tempExists = false;
	try {
		const handle = await open(tempPath, "wx", 0o600);
		tempExists = true;
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		if ((await currentFileDigest(absolutePath)) !== expected) {
			throw new ProtonContractError(
				"The V2 ledger bytes changed before the guarded replacement",
			);
		}
		await rename(tempPath, absolutePath);
		tempExists = false;
		if ((await currentFileDigest(absolutePath)) !== digest(bytes)) {
			throw new ProtonContractError(
				"The written V2 ledger does not match the verified candidate",
			);
		}
	} finally {
		if (tempExists) await unlink(tempPath).catch(() => {});
	}
}

export async function main(argv = process.argv.slice(2)) {
	let values;
	try {
		values = parseArgs({
			args: argv,
			options: {
				slug: { type: "string" },
				"previous-ledger-sha": { type: "string" },
				capture: { type: "string", default: DEFAULT_CAPTURE_PATH_V2 },
				cloud: { type: "string" },
				ledger: { type: "string", default: DEFAULT_LEDGER_PATH_V2 },
				write: { type: "boolean", default: false },
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
		if (!values.slug || !values["previous-ledger-sha"] || !values.cloud) {
			throw new ProtonContractError(
				"--slug, --previous-ledger-sha, and --cloud are required",
			);
		}
		const slug = assertSlug(values.slug, "--slug");
		const previousLedgerSha256 = assertSha256(
			values["previous-ledger-sha"],
			"--previous-ledger-sha",
		);
		const capturePath = ignoredPath(values.capture, "--capture");
		const cloudPath = ignoredPath(values.cloud, "--cloud");
		const ledgerPath = assertSafeRepositoryPath(values.ledger, "--ledger");
		if (!ledgerPath.startsWith("provenance/proton/")) {
			throw new ProtonContractError(
				"--ledger must stay under provenance/proton",
			);
		}
		const actualLedgerSha = await ledgerV2FileSha256({
			repoRoot: DEFAULT_REPO_ROOT,
			ledgerPath,
		});
		if (actualLedgerSha !== previousLedgerSha256) {
			throw new ProtonContractError(
				"--previous-ledger-sha does not match the current V2 ledger bytes",
			);
		}
		const previousLedger = await loadLedgerV2({
			repoRoot: DEFAULT_REPO_ROOT,
			ledgerPath,
			requireComplete: true,
		});
		const expected = await expectedMasterRecordsV2({
			repoRoot: DEFAULT_REPO_ROOT,
		});
		const cloudCapture = verifyCloudCaptureAgainstExpected(
			await loadCloudCapture(
				path.join(DEFAULT_REPO_ROOT, ...cloudPath.split("/")),
			),
			expected,
			{ requireComplete: true, requireFinal: true },
		);
		const capture = await loadCaptureV2({
			repoRoot: DEFAULT_REPO_ROOT,
			capturePath,
			requireComplete: true,
		});
		const nextLedger = await createLedgerV2FromCapture({
			repoRoot: DEFAULT_REPO_ROOT,
			capture,
			cloudCapture,
		});
		const plan = createLedgerUpdatePlan({
			previousLedger,
			nextLedger,
			previousLedgerSha256,
			slug,
		});
		if (values.write) {
			await replaceLedgerIfUnchanged({
				absolutePath: path.join(DEFAULT_REPO_ROOT, ...ledgerPath.split("/")),
				expectedSha256: previousLedgerSha256,
				nextLedger,
			});
		}
		const summary = { ...plan, mode: values.write ? "write" : "dry-run" };
		if (values.json) console.log(JSON.stringify(summary));
		else {
			console.log(
				`Proton V2 update ${summary.mode}: ${summary.slug}; changed fields=${summary.changedFields.join(", ")}; invalidated approvals=1`,
			);
		}
		return 0;
	} catch (error) {
		if (
			error instanceof ProtonContractError ||
			error instanceof ProtonCloudError ||
			error?.name === "ProtonNameError" ||
			error?.name === "MediumContractError"
		) {
			console.error(`Proton V2 update failed: ${error.message}`);
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
