import assert from "node:assert/strict";
import test from "node:test";
import {
	captureCloudInventory,
	cloudInventoryDigest,
	PROTON_CLI_VERSION,
	PROTON_CLI_WINDOWS_X64_SHA512,
	PROTON_CLOUD_CAPTURE_SCHEMA_VERSION,
	PROTON_DOC_MEDIA_TYPE,
	PROTON_REMOTE_FOLDERS,
	parseNodeList,
	reconcileCloudInventory,
	validateCloudCapture,
	verifyCloudCaptureAgainstExpected,
} from "./cloud.mjs";
import { assignWindowsSafeCloudNames } from "./names.mjs";

const CAPTURED_AT = "2026-07-28T12:34:56.789Z";

function expectedRecords() {
	return [
		...Array.from({ length: 11 }, (_, index) => ({
			slug: `fiction-${String(index + 1).padStart(2, "0")}`,
			masterFolder: "fiction",
			articleTitle:
				index === 0 ? "Fiction: First?" : `Fiction Work ${index + 1}`,
			legacyCloudNames: index === 0 ? ["Fiction_First"] : [],
		})),
		...Array.from({ length: 24 }, (_, index) => ({
			slug: `nonfiction-${String(index + 1).padStart(2, "0")}`,
			masterFolder: "nonfiction",
			articleTitle: `Non-Fiction Work ${index + 1}`,
			legacyCloudNames: [],
		})),
	];
}

function node(name, index) {
	return {
		uid: `private-node-${index}`,
		parentUid: "private-parent",
		type: "file",
		mediaType: PROTON_DOC_MEDIA_TYPE,
		name: { ok: true, value: name },
		ownedBy: { email: "private@example.invalid" },
		errors: [],
	};
}

function captureFromObserved(observedByFolder) {
	const reconciled = reconcileCloudInventory({
		expectedRecords: expectedRecords(),
		observedByFolder,
	});
	return {
		schemaVersion: PROTON_CLOUD_CAPTURE_SCHEMA_VERSION,
		capturedAt: CAPTURED_AT,
		cliVersion: PROTON_CLI_VERSION,
		phase: reconciled.phase,
		observedInventorySha256: reconciled.observedInventorySha256,
		targetInventorySha256: reconciled.targetInventorySha256,
		records: reconciled.records,
	};
}

function targetNamesByFolder() {
	const records = assignWindowsSafeCloudNames(expectedRecords());
	return {
		fiction: records
			.filter((record) => record.masterFolder === "fiction")
			.map((record) => record.cloudName),
		nonfiction: records
			.filter((record) => record.masterFolder === "nonfiction")
			.map((record) => record.cloudName),
	};
}

test("read-only CLI capture invokes only the two fixed folders and discards private fields", async () => {
	const target = targetNamesByFolder();
	const observed = structuredClone(target);
	observed.fiction[0] = "Fiction_First";
	const calls = [];
	const executable = "C:\\Tools\\proton-drive.exe";
	const result = await captureCloudInventory({
		cliPath: executable,
		expectedRecords: expectedRecords(),
		now: () => new Date(CAPTURED_AT),
		verifyExecutable: async (value) => value,
		runCli: async (value, args) => {
			calls.push({ executable: value, args });
			if (args[0] === "--version") {
				return Buffer.from(
					`Proton Drive CLI cli-drive@${PROTON_CLI_VERSION}+abcdef0\nProton Drive SDK js@0.19.2+abcdef0\n`,
				);
			}
			const folder =
				args.at(-1) === PROTON_REMOTE_FOLDERS.fiction
					? "fiction"
					: "nonfiction";
			return Buffer.from(
				JSON.stringify(
					observed[folder].map((name, index) => node(name, index)),
				),
			);
		},
	});

	assert.deepEqual(calls, [
		{ executable, args: ["--version"] },
		{
			executable,
			args: ["filesystem", "list", "-j", PROTON_REMOTE_FOLDERS.fiction],
		},
		{
			executable,
			args: ["filesystem", "list", "-j", PROTON_REMOTE_FOLDERS.nonfiction],
		},
	]);
	assert.equal(result.cliVersion, PROTON_CLI_VERSION);
	assert.equal(result.capturedAt, CAPTURED_AT);
	assert.equal(
		PROTON_CLI_WINDOWS_X64_SHA512,
		"sha512:a7cefbac439b2f54178fcd3c18fbdfc32e150a2e35bfe8f5d3a714fd157e509c59307db09ae71c164bbc8174439acda2bd5fb3fe84c4f1ad4977d1e7fb9fb904",
	);
	assert.equal(result.phase, "preflight");
	assert.equal(
		result.records.filter((record) => record.status === "rename-required")
			.length,
		1,
	);
	const sanitized = JSON.stringify(result);
	assert.doesNotMatch(
		sanitized,
		/private-node|private-parent|private@example/u,
	);
});

test("cloud capture validation binds counts, digests, phase, and current aliases", () => {
	const target = targetNamesByFolder();
	const preflightObserved = structuredClone(target);
	preflightObserved.fiction[0] = "Fiction_First";
	const preflight = captureFromObserved(preflightObserved);
	assert.equal(
		validateCloudCapture(preflight, { requireComplete: true }).phase,
		"preflight",
	);
	assert.equal(
		verifyCloudCaptureAgainstExpected(preflight, expectedRecords(), {
			requireComplete: true,
		}).records.length,
		35,
	);
	assert.throws(
		() =>
			verifyCloudCaptureAgainstExpected(preflight, expectedRecords(), {
				requireComplete: true,
				requireFinal: true,
			}),
		/requires Windows-safe renames/u,
	);

	const final = captureFromObserved(target);
	assert.equal(
		verifyCloudCaptureAgainstExpected(final, expectedRecords(), {
			requireComplete: true,
			requireFinal: true,
		}).phase,
		"final",
	);

	const wrongDigest = structuredClone(final);
	wrongDigest.observedInventorySha256 = `sha256:${"0".repeat(64)}`;
	assert.throws(() => validateCloudCapture(wrongDigest), /digest/u);

	const wrongPhase = structuredClone(final);
	wrongPhase.phase = "preflight";
	assert.throws(() => validateCloudCapture(wrongPhase), /phase/u);

	const incomplete = structuredClone(final);
	incomplete.records.pop();
	incomplete.observedInventorySha256 = cloudInventoryDigest(incomplete.records);
	incomplete.targetInventorySha256 = cloudInventoryDigest(incomplete.records, {
		observed: false,
	});
	assert.throws(
		() => validateCloudCapture(incomplete, { requireComplete: true }),
		/11 Fiction and 24 Non-Fiction/u,
	);

	const unknown = structuredClone(final);
	unknown.records[0].observedName = "Unknown document";
	unknown.records[0].status = "rename-required";
	unknown.phase = "preflight";
	unknown.observedInventorySha256 = cloudInventoryDigest(unknown.records);
	assert.throws(
		() => verifyCloudCaptureAgainstExpected(unknown, expectedRecords()),
		/unmatched or repeated document/u,
	);
});

test("CLI node parsing fails closed on malformed, degraded, or non-Doc entries", () => {
	assert.deepEqual(
		parseNodeList(
			Buffer.from(JSON.stringify([node("Exact title", 1)])),
			"fiction",
		),
		["Exact title"],
	);
	assert.throws(
		() => parseNodeList(Buffer.from("not-json"), "fiction"),
		/not valid UTF-8 JSON/u,
	);
	for (const changed of [
		{ type: "folder" },
		{ mediaType: "text/html" },
		{ errors: [{ message: "private detail" }] },
		{ errors: "unexpected" },
		{ name: { ok: false, error: "private detail" } },
		{ name: { ok: true, value: "bad\u202ename" } },
	]) {
		const value = { ...node("Exact title", 1), ...changed };
		assert.throws(
			() => parseNodeList(Buffer.from(JSON.stringify([value])), "fiction"),
			/non-Doc or degraded|undecryptable or unsafe/u,
		);
	}
});
