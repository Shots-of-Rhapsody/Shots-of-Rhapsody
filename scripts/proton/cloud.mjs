import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { serializeJson } from "../medium/lib/contract.js";
import {
	assignWindowsSafeCloudNames,
	hasControlOrBidi,
	windowsNameKey,
} from "./names.mjs";

export const PROTON_CLOUD_CAPTURE_SCHEMA_VERSION = 1;
export const PROTON_CLI_VERSION = "0.6.0";
export const PROTON_CLI_WINDOWS_X64_SHA512 =
	"sha512:a7cefbac439b2f54178fcd3c18fbdfc32e150a2e35bfe8f5d3a714fd157e509c59307db09ae71c164bbc8174439acda2bd5fb3fe84c4f1ad4977d1e7fb9fb904";
export const PROTON_DOC_MEDIA_TYPE = "application/vnd.proton.doc";
export const PROTON_REMOTE_FOLDERS = Object.freeze({
	fiction: "/my-files/Blogging/Fiction",
	nonfiction: "/my-files/Blogging/Non-Fiction",
});

const MAX_CLI_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const CLI_TIMEOUT_MS = 60_000;

export class ProtonCloudError extends Error {
	constructor(message, options = {}) {
		super(message, options);
		this.name = "ProtonCloudError";
	}
}

function assertCanonicalUtc(value, label) {
	if (
		typeof value !== "string" ||
		!/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u.test(
			value,
		) ||
		new Date(value).toISOString() !== value
	) {
		throw new ProtonCloudError(`${label} must be a canonical UTC timestamp`);
	}
	return value;
}

function assertSha256(value, label) {
	if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
		throw new ProtonCloudError(`${label} must be a lowercase SHA-256 digest`);
	}
	return value;
}

function assertOnlyKeys(value, keys, label) {
	for (const key of Object.keys(value)) {
		if (!keys.has(key)) {
			throw new ProtonCloudError(`${label} contains unsupported key ${key}`);
		}
	}
}

function sha256(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function cloudInventoryDigest(records, { observed = true } = {}) {
	const projection = {
		schemaVersion: PROTON_CLOUD_CAPTURE_SCHEMA_VERSION,
		records: [...records]
			.map((record) => ({
				slug: record.slug,
				masterFolder: record.masterFolder,
				cloudName: observed ? record.observedName : record.targetCloudName,
				type: "document",
			}))
			.sort((left, right) => left.slug.localeCompare(right.slug, "en")),
	};
	return sha256(Buffer.from(serializeJson(projection), "utf8"));
}

export function validateCloudCapture(value, { requireComplete = false } = {}) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ProtonCloudError("Cloud inventory capture must be an object");
	}
	assertOnlyKeys(
		value,
		new Set([
			"schemaVersion",
			"capturedAt",
			"cliVersion",
			"phase",
			"observedInventorySha256",
			"targetInventorySha256",
			"records",
		]),
		"Cloud inventory capture",
	);
	if (value.schemaVersion !== PROTON_CLOUD_CAPTURE_SCHEMA_VERSION) {
		throw new ProtonCloudError(
			`Cloud inventory schemaVersion must equal ${PROTON_CLOUD_CAPTURE_SCHEMA_VERSION}`,
		);
	}
	if (value.cliVersion !== PROTON_CLI_VERSION) {
		throw new ProtonCloudError(
			`Cloud inventory cliVersion must equal ${PROTON_CLI_VERSION}`,
		);
	}
	if (value.phase !== "preflight" && value.phase !== "final") {
		throw new ProtonCloudError(
			"Cloud inventory phase must be preflight or final",
		);
	}
	if (!Array.isArray(value.records)) {
		throw new ProtonCloudError("Cloud inventory records must be an array");
	}
	const slugs = new Set();
	const namesByFolder = new Map([
		["fiction", new Set()],
		["nonfiction", new Set()],
	]);
	const records = value.records.map((raw, index) => {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			throw new ProtonCloudError(
				`Cloud inventory record ${index + 1} is malformed`,
			);
		}
		assertOnlyKeys(
			raw,
			new Set([
				"slug",
				"masterFolder",
				"observedName",
				"targetCloudName",
				"type",
				"status",
			]),
			`Cloud inventory record ${index + 1}`,
		);
		if (
			typeof raw.slug !== "string" ||
			!/^[a-z0-9][a-z0-9-]*$/u.test(raw.slug)
		) {
			throw new ProtonCloudError(
				`Cloud inventory record ${index + 1} has an invalid slug`,
			);
		}
		if (raw.masterFolder !== "fiction" && raw.masterFolder !== "nonfiction") {
			throw new ProtonCloudError(
				`Cloud inventory record ${index + 1} has an invalid masterFolder`,
			);
		}
		for (const key of ["observedName", "targetCloudName"]) {
			if (
				typeof raw[key] !== "string" ||
				raw[key].length === 0 ||
				raw[key] !== raw[key].normalize("NFC") ||
				hasControlOrBidi(raw[key])
			) {
				throw new ProtonCloudError(
					`Cloud inventory record ${index + 1} has an unsafe ${key}`,
				);
			}
		}
		if (raw.type !== "document") {
			throw new ProtonCloudError(
				`Cloud inventory record ${index + 1} must be a document`,
			);
		}
		const expectedStatus =
			raw.observedName === raw.targetCloudName ? "exact" : "rename-required";
		if (raw.status !== expectedStatus) {
			throw new ProtonCloudError(
				`Cloud inventory record ${index + 1} has an inconsistent status`,
			);
		}
		if (slugs.has(raw.slug)) {
			throw new ProtonCloudError("Cloud inventory repeats a slug");
		}
		const nameKey = windowsNameKey(raw.observedName);
		if (namesByFolder.get(raw.masterFolder).has(nameKey)) {
			throw new ProtonCloudError(
				"Cloud inventory repeats a Windows-equivalent name",
			);
		}
		slugs.add(raw.slug);
		namesByFolder.get(raw.masterFolder).add(nameKey);
		return {
			slug: raw.slug,
			masterFolder: raw.masterFolder,
			observedName: raw.observedName,
			targetCloudName: raw.targetCloudName,
			type: "document",
			status: expectedStatus,
		};
	});
	const normalized = {
		schemaVersion: PROTON_CLOUD_CAPTURE_SCHEMA_VERSION,
		capturedAt: assertCanonicalUtc(value.capturedAt, "capturedAt"),
		cliVersion: PROTON_CLI_VERSION,
		phase: value.phase,
		observedInventorySha256: assertSha256(
			value.observedInventorySha256,
			"observedInventorySha256",
		),
		targetInventorySha256: assertSha256(
			value.targetInventorySha256,
			"targetInventorySha256",
		),
		records: records.sort((left, right) =>
			left.slug.localeCompare(right.slug, "en"),
		),
	};
	if (
		normalized.observedInventorySha256 !==
			cloudInventoryDigest(normalized.records) ||
		normalized.targetInventorySha256 !==
			cloudInventoryDigest(normalized.records, { observed: false })
	) {
		throw new ProtonCloudError(
			"Cloud inventory digest does not match its records",
		);
	}
	const final = normalized.records.every((record) => record.status === "exact");
	if (normalized.phase !== (final ? "final" : "preflight")) {
		throw new ProtonCloudError(
			"Cloud inventory phase does not match its records",
		);
	}
	if (requireComplete) {
		const fiction = normalized.records.filter(
			(record) => record.masterFolder === "fiction",
		).length;
		const nonfiction = normalized.records.length - fiction;
		if (fiction !== 11 || nonfiction !== 24) {
			throw new ProtonCloudError(
				`Cloud inventory must contain 11 Fiction and 24 Non-Fiction documents, not ${fiction} and ${nonfiction}`,
			);
		}
	}
	return normalized;
}

export async function loadCloudCapture(capturePath) {
	let initial;
	try {
		initial = await lstat(capturePath, { bigint: true });
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new ProtonCloudError(
				"The ignored cloud inventory capture is missing",
			);
		}
		throw error;
	}
	if (!initial.isFile() || initial.isSymbolicLink()) {
		throw new ProtonCloudError(
			"The ignored cloud inventory capture must be a regular file",
		);
	}
	const size = Number(initial.size);
	if (!Number.isSafeInteger(size) || size < 1 || size > MAX_CAPTURE_BYTES) {
		throw new ProtonCloudError(
			"The ignored cloud inventory capture has an invalid size",
		);
	}
	const handle = await open(capturePath, "r");
	try {
		const opened = await handle.stat({ bigint: true });
		if (
			opened.dev !== initial.dev ||
			opened.ino !== initial.ino ||
			Number(opened.size) !== size
		) {
			throw new ProtonCloudError(
				"The ignored cloud inventory capture changed while opening",
			);
		}
		const bytes = await handle.readFile();
		let value;
		try {
			value = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
		} catch (error) {
			throw new ProtonCloudError(
				"The ignored cloud inventory capture is not canonical UTF-8 JSON",
				{ cause: error },
			);
		}
		if (!bytes.equals(Buffer.from(serializeJson(value), "utf8"))) {
			throw new ProtonCloudError(
				"The ignored cloud inventory capture must use canonical JSON formatting",
			);
		}
		return validateCloudCapture(value);
	} finally {
		await handle.close().catch(() => {});
	}
}

export async function writeCloudCaptureNoOverwrite(capturePath, capture) {
	const normalized = validateCloudCapture(capture, { requireComplete: true });
	try {
		await writeFile(capturePath, serializeJson(normalized), { flag: "wx" });
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new ProtonCloudError(
				"Refusing to overwrite the existing ignored cloud inventory capture",
			);
		}
		throw error;
	}
	return normalized;
}

async function assertCliExecutable(cliPath) {
	if (typeof cliPath !== "string" || !path.isAbsolute(cliPath)) {
		throw new ProtonCloudError("--cli must be an absolute executable path");
	}
	let status;
	try {
		status = await lstat(cliPath, { bigint: true });
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new ProtonCloudError("The Proton Drive CLI executable is missing");
		}
		throw error;
	}
	if (!status.isFile() || status.isSymbolicLink()) {
		throw new ProtonCloudError(
			"The Proton Drive CLI must be a regular file, not a link",
		);
	}
	const resolved = await realpath(cliPath);
	if (path.resolve(resolved) !== path.resolve(cliPath)) {
		throw new ProtonCloudError("The Proton Drive CLI path must be canonical");
	}
	const handle = await open(resolved, "r");
	try {
		const opened = await handle.stat({ bigint: true });
		if (
			opened.dev !== status.dev ||
			opened.ino !== status.ino ||
			opened.size !== status.size
		) {
			throw new ProtonCloudError("The Proton Drive CLI changed while opening");
		}
		const digest = createHash("sha512");
		for await (const chunk of handle.createReadStream({ autoClose: false })) {
			digest.update(chunk);
		}
		const closedOver = await handle.stat({ bigint: true });
		if (
			closedOver.size !== opened.size ||
			closedOver.mtimeNs !== opened.mtimeNs
		) {
			throw new ProtonCloudError("The Proton Drive CLI changed while hashing");
		}
		if (`sha512:${digest.digest("hex")}` !== PROTON_CLI_WINDOWS_X64_SHA512) {
			throw new ProtonCloudError(
				"The Proton Drive CLI does not match Proton's published Windows x64 checksum",
			);
		}
	} finally {
		await handle.close().catch(() => {});
	}
	return resolved;
}

function cliEnvironment() {
	const allowed = new Set([
		"APPDATA",
		"COMSPEC",
		"LANG",
		"LC_ALL",
		"LOCALAPPDATA",
		"PATH",
		"PATHEXT",
		"PROGRAMDATA",
		"SYSTEMDRIVE",
		"SYSTEMROOT",
		"TEMP",
		"TMP",
		"USERPROFILE",
		"WINDIR",
	]);
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && allowed.has(key.toUpperCase())) {
			env[key] = value;
		}
	}
	return {
		...env,
		PROTON_DRIVE_CREDENTIALS_STORE: "keychain",
		PROTON_DRIVE_LOG_LEVEL: "ERROR",
	};
}

function runCliProcess(executable, args) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const stdout = [];
		const child = spawn(executable, args, {
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: cliEnvironment(),
		});
		const finish = (callback) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback();
		};
		const rejectGeneric = (message, options) => {
			child.kill();
			finish(() => reject(new ProtonCloudError(message, options)));
		};
		const timer = setTimeout(() => {
			rejectGeneric("The Proton Drive CLI timed out");
		}, CLI_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			stdoutBytes += chunk.byteLength;
			if (stdoutBytes > MAX_CLI_OUTPUT_BYTES) {
				rejectGeneric("The Proton Drive CLI returned oversized output");
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderrBytes += chunk.byteLength;
			if (stderrBytes > MAX_CLI_OUTPUT_BYTES) {
				rejectGeneric("The Proton Drive CLI returned oversized error output");
			}
		});
		child.on("error", (error) => {
			finish(() =>
				reject(
					new ProtonCloudError("The Proton Drive CLI could not be started", {
						cause: error,
					}),
				),
			);
		});
		child.on("close", (code, signal) => {
			finish(() => {
				if (code !== 0 || signal) {
					reject(
						new ProtonCloudError(
							"The Proton Drive CLI command failed; authenticate in the browser and retry",
						),
					);
					return;
				}
				resolve(Buffer.concat(stdout));
			});
		});
	});
}

function parseCliVersion(buffer) {
	let output;
	try {
		output = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch (error) {
		throw new ProtonCloudError("The Proton Drive CLI version is not UTF-8", {
			cause: error,
		});
	}
	const match =
		/^Proton Drive CLI cli-drive@(\d+\.\d+\.\d+)\+[a-f0-9]+\r?\nProton Drive SDK js@\d+\.\d+\.\d+\+[a-f0-9]+\r?\n?$/u.exec(
			output,
		);
	if (!match || match[1] !== PROTON_CLI_VERSION) {
		throw new ProtonCloudError(
			`The Proton Drive CLI must be version ${PROTON_CLI_VERSION}`,
		);
	}
	return match[1];
}

export function parseNodeList(buffer, masterFolder) {
	let nodes;
	try {
		nodes = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(buffer),
		);
	} catch (error) {
		throw new ProtonCloudError(
			`The ${masterFolder} cloud inventory is not valid UTF-8 JSON`,
			{ cause: error },
		);
	}
	if (!Array.isArray(nodes) || nodes.length > 1000) {
		throw new ProtonCloudError(
			`The ${masterFolder} cloud inventory must be a bounded array`,
		);
	}
	return nodes.map((node, index) => {
		if (node === null || typeof node !== "object" || Array.isArray(node)) {
			throw new ProtonCloudError(
				`The ${masterFolder} cloud inventory item ${index + 1} is malformed`,
			);
		}
		if (
			node.type !== "file" ||
			node.mediaType !== PROTON_DOC_MEDIA_TYPE ||
			(node.errors !== undefined &&
				(!Array.isArray(node.errors) || node.errors.length > 0))
		) {
			throw new ProtonCloudError(
				`The ${masterFolder} cloud inventory contains a non-Doc or degraded item`,
			);
		}
		const name = node.name;
		if (
			name === null ||
			typeof name !== "object" ||
			name.ok !== true ||
			typeof name.value !== "string" ||
			name.value.length === 0 ||
			hasControlOrBidi(name.value)
		) {
			throw new ProtonCloudError(
				`The ${masterFolder} cloud inventory contains an undecryptable or unsafe name`,
			);
		}
		return name.value.normalize("NFC");
	});
}

function addAlias(aliasMap, masterFolder, name, slug) {
	if (typeof name !== "string" || name.length === 0) return;
	const key = `${masterFolder}\u0000${name.normalize("NFC")}`;
	const existing = aliasMap.get(key);
	if (existing && existing !== slug) {
		throw new ProtonCloudError(
			"The committed Proton name aliases are ambiguous",
		);
	}
	aliasMap.set(key, slug);
}

export function reconcileCloudInventory({ expectedRecords, observedByFolder }) {
	const expected = assignWindowsSafeCloudNames(expectedRecords);
	const bySlug = new Map(expected.map((record) => [record.slug, record]));
	const aliases = new Map();
	for (const record of expected) {
		addAlias(aliases, record.masterFolder, record.cloudName, record.slug);
		addAlias(aliases, record.masterFolder, record.articleTitle, record.slug);
		for (const alias of record.legacyCloudNames ?? []) {
			addAlias(aliases, record.masterFolder, alias, record.slug);
		}
	}
	const reconciled = [];
	const seenSlugs = new Set();
	for (const masterFolder of ["fiction", "nonfiction"]) {
		const observed = observedByFolder[masterFolder];
		if (!Array.isArray(observed)) {
			throw new ProtonCloudError(
				`The ${masterFolder} observed inventory must be an array`,
			);
		}
		const observedKeys = new Set();
		for (const observedName of observed) {
			const nameKey = windowsNameKey(observedName);
			if (observedKeys.has(nameKey)) {
				throw new ProtonCloudError(
					`The ${masterFolder} cloud inventory repeats a Windows-equivalent name`,
				);
			}
			observedKeys.add(nameKey);
			const slug = aliases.get(
				`${masterFolder}\u0000${observedName.normalize("NFC")}`,
			);
			if (!slug || seenSlugs.has(slug)) {
				throw new ProtonCloudError(
					`The ${masterFolder} cloud inventory contains an unmatched or repeated document`,
				);
			}
			const record = bySlug.get(slug);
			seenSlugs.add(slug);
			reconciled.push({
				slug,
				masterFolder,
				observedName,
				targetCloudName: record.cloudName,
				type: "document",
				status: observedName === record.cloudName ? "exact" : "rename-required",
			});
		}
	}
	if (
		reconciled.length !== expected.length ||
		seenSlugs.size !== expected.length
	) {
		throw new ProtonCloudError(
			`The cloud inventory reconciles ${seenSlugs.size}/${expected.length} expected documents`,
		);
	}
	const records = reconciled.sort((left, right) =>
		left.slug.localeCompare(right.slug, "en"),
	);
	return {
		records,
		phase: records.every((record) => record.status === "exact")
			? "final"
			: "preflight",
		observedInventorySha256: cloudInventoryDigest(records),
		targetInventorySha256: cloudInventoryDigest(records, { observed: false }),
	};
}

export function verifyCloudCaptureAgainstExpected(
	capture,
	expectedRecords,
	{ requireComplete = false, requireFinal = false } = {},
) {
	const normalized = validateCloudCapture(capture, { requireComplete });
	const observedByFolder = {
		fiction: normalized.records
			.filter((record) => record.masterFolder === "fiction")
			.map((record) => record.observedName),
		nonfiction: normalized.records
			.filter((record) => record.masterFolder === "nonfiction")
			.map((record) => record.observedName),
	};
	const reconciled = reconcileCloudInventory({
		expectedRecords,
		observedByFolder,
	});
	if (
		normalized.phase !== reconciled.phase ||
		normalized.observedInventorySha256 !== reconciled.observedInventorySha256 ||
		normalized.targetInventorySha256 !== reconciled.targetInventorySha256 ||
		serializeJson(normalized.records) !== serializeJson(reconciled.records)
	) {
		throw new ProtonCloudError(
			"The sanitized cloud capture differs from the current writing inventory",
		);
	}
	if (requireFinal && normalized.phase !== "final") {
		throw new ProtonCloudError(
			"The Proton cloud inventory still requires Windows-safe renames",
		);
	}
	return normalized;
}

export async function captureCloudInventory({
	cliPath,
	expectedRecords,
	runCli = runCliProcess,
	verifyExecutable = assertCliExecutable,
	now = () => new Date(),
}) {
	const executable = await verifyExecutable(cliPath);
	const cliVersion = parseCliVersion(await runCli(executable, ["--version"]));
	const observedByFolder = {};
	for (const masterFolder of ["fiction", "nonfiction"]) {
		observedByFolder[masterFolder] = parseNodeList(
			await runCli(executable, [
				"filesystem",
				"list",
				"-j",
				PROTON_REMOTE_FOLDERS[masterFolder],
			]),
			masterFolder,
		);
	}
	const capturedAt = now().toISOString();
	assertCanonicalUtc(capturedAt, "capturedAt");
	return {
		capturedAt,
		cliVersion,
		...reconcileCloudInventory({ expectedRecords, observedByFolder }),
	};
}
