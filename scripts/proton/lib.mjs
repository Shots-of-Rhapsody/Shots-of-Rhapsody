import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdtemp,
	open,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseFragment } from "parse5";
import sharp from "sharp";
import { decodeUtf8, extractProtonHtml } from "../archive/lib/extract.js";
import { verifyArticles } from "../archive/lib/pipeline.js";
import {
	loadMediumMasterEvidence,
	verifyProtonMasterExport,
} from "../content/proton-master.js";
import {
	assertCanonicalUtc,
	assertNonEmptyString,
	assertOnlyKeys,
	assertPlainObject,
	assertSafeRepositoryPath,
	assertSha256,
	assertSlug,
	DEFAULT_REPO_ROOT,
	MediumContractError,
	serializeJson,
} from "../medium/lib/contract.js";
import { sha256 } from "../medium/lib/integrity.js";
import { verifyMediumArticles } from "../medium/lib/pipeline.js";

export const PROTON_MASTER_SCHEMA_VERSION = 1;
export const PROTON_CAPTURE_SCHEMA_VERSION = 1;
export const EXPECTED_FICTION_COUNT = 11;
export const EXPECTED_NONFICTION_COUNT = 24;
export const EXPECTED_RECORD_COUNT = 35;
export const DEFAULT_LEDGER_PATH = "provenance/proton/master-ledger.v1.json";
// The sealed first capture reuses the existing ignored Medium round-trip root.
// New captures may be supplied explicitly from .proton-import once the local
// protected-folder ACL allows files to be created there.
export const DEFAULT_CAPTURE_PATH = ".medium-import/proton-capture.v1.json";

/**
 * @typedef {object} ProtonMasterRecordV1
 * @property {string} slug
 * @property {"fiction" | "nonfiction"} section
 * @property {string} cloudTitle
 * @property {string} exportedAt
 * @property {`sha256:${string}`} exportSha256
 * @property {`sha256:${string}`} semanticSha256
 * @property {`sha256:${string}`} heroSha256
 * @property {`sha256:${string}`} heroPixelSha256
 * @property {`sha256:${string}`} heroSourceSha256
 * @property {`sha256:${string}`} sourceSnapshotSha256
 * @property {`sha256:${string}`} siteOutputSha256
 * @property {number} bodyBlockCount
 */

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_HTML_BYTES = 128 * 1024 * 1024;
const SECTION_ORDER = ["fiction", "nonfiction"];
const PRIVATE_TEXT_PATTERNS = [
	/https?:\/\//iu,
	/\b(?:docs|drive)\.proton\.(?:me|ch)\b/iu,
	/\bprotonusercontent\.com\b/iu,
	/\bfile:\/\//iu,
	/\blocalhost\b/iu,
	/\b[A-Za-z]:[\\/]/u,
	/(?:^|[\s"'])\/(?:Users|home)\//u,
	/\.proton-import/iu,
];
const LEGACY_MEDIUM_EXPORT_PREFIX = ".medium-import/proton-exports/";
const FALLBACK_PROTON_CAPTURE_PREFIX = ".medium-import/proton-captures/";
const ARCHIVE_CLOUD_TITLE_OVERRIDES = new Map([
	[
		"before-the-sky-went-quiet-part-i-the-girl-who-faded",
		"Before the Sky Went Quiet_Part I - The Girl Who Faded",
	],
	[
		"before-the-sky-went-quiet-part-ii-the-goodbye",
		"Before the Sky Went Quiet_Part II - The Goodbye",
	],
	[
		"before-the-sky-went-quiet-part-iii-the-echo-that-stayed",
		"Before the Sky Went Quiet_Part III - The Echo That Stayed",
	],
	[
		"the-guild-a-chronicle-of-pretty-souls",
		"The Guild_A Chronicle of Pretty Souls",
	],
]);

export class ProtonContractError extends Error {
	constructor(message, options = {}) {
		super(message, options);
		this.name = "ProtonContractError";
	}
}

function asProtonError(error, prefix) {
	if (error instanceof ProtonContractError) return error;
	if (error instanceof MediumContractError) {
		return new ProtonContractError(`${prefix}: ${error.message}`, {
			cause: error,
		});
	}
	return error;
}

function assertInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new ProtonContractError(`${label} must be a non-negative integer`);
	}
	return value;
}

function assertSection(value, label) {
	if (!SECTION_ORDER.includes(value)) {
		throw new ProtonContractError(`${label} must be fiction or nonfiction`);
	}
	return value;
}

function assertSanitizedLedger(value, label = "Proton master ledger") {
	const serialized = serializeJson(value);
	for (const pattern of PRIVATE_TEXT_PATTERNS) {
		if (pattern.test(serialized)) {
			throw new ProtonContractError(
				`${label} contains a URL, account reference, raw-source path, or local path`,
			);
		}
	}
}

function canonicalDigest(value) {
	return sha256(Buffer.from(serializeJson(value), "utf8"));
}

export function semanticSha256(value) {
	return canonicalDigest(value);
}

async function readBoundedFile(filePath, label, maxBytes) {
	let initial;
	try {
		initial = await lstat(filePath, { bigint: true });
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new ProtonContractError(`${label} is missing`);
		}
		throw error;
	}
	if (!initial.isFile() || initial.isSymbolicLink()) {
		throw new ProtonContractError(
			`${label} must be a regular file, not a link`,
		);
	}
	const size = Number(initial.size);
	if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
		throw new ProtonContractError(
			`${label} must be between 1 and ${maxBytes} bytes`,
		);
	}
	let handle;
	try {
		handle = await open(filePath, "r");
		const opened = await handle.stat({ bigint: true });
		if (
			!opened.isFile() ||
			opened.dev !== initial.dev ||
			opened.ino !== initial.ino ||
			Number(opened.size) !== size
		) {
			throw new ProtonContractError(`${label} changed while being opened`);
		}
		const buffer = await handle.readFile();
		const final = await handle.stat({ bigint: true });
		if (
			final.dev !== opened.dev ||
			final.ino !== opened.ino ||
			Number(final.size) !== size ||
			buffer.byteLength !== size
		) {
			throw new ProtonContractError(`${label} changed while being read`);
		}
		return buffer;
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function readJsonFile(filePath, label, { canonical = false } = {}) {
	const buffer = await readBoundedFile(filePath, label, MAX_JSON_BYTES);
	let value;
	try {
		value = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(buffer),
		);
	} catch (error) {
		throw new ProtonContractError(`${label} must be canonical UTF-8 JSON`, {
			cause: error,
		});
	}
	if (canonical && !buffer.equals(Buffer.from(serializeJson(value), "utf8"))) {
		throw new ProtonContractError(
			`${label} must use canonical JSON formatting`,
		);
	}
	return { buffer, value };
}

function relativeInside(root, target, label) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new ProtonContractError(`${label} escapes its ignored root`);
	}
	return relative;
}

function ignoredRootForPath(repoRoot, repositoryPath, label) {
	if (repositoryPath.startsWith(".proton-import/")) {
		return path.join(repoRoot, ".proton-import");
	}
	if (repositoryPath.startsWith(LEGACY_MEDIUM_EXPORT_PREFIX)) {
		return path.join(repoRoot, ".medium-import", "proton-exports");
	}
	if (repositoryPath.startsWith(FALLBACK_PROTON_CAPTURE_PREFIX)) {
		return path.join(repoRoot, ".medium-import", "proton-captures");
	}
	throw new ProtonContractError(
		`${label}.file must be beneath an approved ignored Proton capture root`,
	);
}

async function readRawImportFile(repoRoot, repositoryPath, label) {
	assertSafeRepositoryPath(repositoryPath, `${label}.file`);
	const importRoot = ignoredRootForPath(repoRoot, repositoryPath, label);
	const lexicalTarget = path.resolve(repoRoot, ...repositoryPath.split("/"));
	relativeInside(importRoot, lexicalTarget, label);
	const [rootReal, targetReal] = await Promise.all([
		realpath(importRoot),
		realpath(lexicalTarget).catch((error) => {
			if (error?.code === "ENOENT") {
				throw new ProtonContractError(`${label} is missing`);
			}
			throw error;
		}),
	]);
	relativeInside(rootReal, targetReal, label);
	return {
		absolutePath: lexicalTarget,
		buffer: await readBoundedFile(lexicalTarget, label, MAX_HTML_BYTES),
	};
}

async function readRawExport(repoRoot, repositoryPath, label) {
	const result = await readRawImportFile(repoRoot, repositoryPath, label);
	const extension = path.extname(result.absolutePath).toLowerCase();
	if (extension === ".protondoc") {
		throw new ProtonContractError(
			`${label} cannot use a .protondoc sync placeholder; export HTML instead`,
		);
	}
	if (extension !== ".html" && extension !== ".htm") {
		throw new ProtonContractError(`${label} must be an HTML export`);
	}
	return result;
}

async function readRawFictionHero(repoRoot, repositoryPath, label) {
	const result = await readRawImportFile(repoRoot, repositoryPath, label);
	if (path.extname(result.absolutePath).toLowerCase() !== ".png") {
		throw new ProtonContractError(`${label} must be an original PNG`);
	}
	return result;
}

function validateCaptureEntry(value, section, index) {
	const label = `capture.sections.${section}[${index}]`;
	const entry = assertPlainObject(value, label);
	assertOnlyKeys(
		entry,
		new Set([
			"slug",
			"title",
			"exportedAt",
			"file",
			...(section === "fiction" ? ["heroFile"] : []),
		]),
		label,
	);
	const file = assertSafeRepositoryPath(entry.file, `${label}.file`);
	if (
		!file.startsWith(".proton-import/") &&
		!file.startsWith(LEGACY_MEDIUM_EXPORT_PREFIX) &&
		!file.startsWith(FALLBACK_PROTON_CAPTURE_PREFIX)
	) {
		throw new ProtonContractError(
			`${label}.file must remain under an approved ignored Proton capture root`,
		);
	}
	const normalized = {
		slug: assertSlug(entry.slug, `${label}.slug`),
		title: assertNonEmptyString(entry.title, `${label}.title`),
		exportedAt: assertCanonicalUtc(entry.exportedAt, `${label}.exportedAt`),
		file,
	};
	if (section === "fiction") {
		const heroFile = assertSafeRepositoryPath(
			entry.heroFile,
			`${label}.heroFile`,
		);
		if (
			!heroFile.startsWith(".proton-import/") &&
			!heroFile.startsWith(FALLBACK_PROTON_CAPTURE_PREFIX)
		) {
			throw new ProtonContractError(
				`${label}.heroFile must remain under an approved ignored Proton capture root`,
			);
		}
		normalized.heroFile = heroFile;
	}
	return normalized;
}

export function validateCapture(value) {
	try {
		const capture = assertPlainObject(value, "capture");
		assertOnlyKeys(
			capture,
			new Set(["schemaVersion", "capturedAt", "sections"]),
			"capture",
		);
		if (capture.schemaVersion !== PROTON_CAPTURE_SCHEMA_VERSION) {
			throw new ProtonContractError(
				`capture.schemaVersion must equal ${PROTON_CAPTURE_SCHEMA_VERSION}`,
			);
		}
		const sections = assertPlainObject(capture.sections, "capture.sections");
		assertOnlyKeys(sections, new Set(SECTION_ORDER), "capture.sections");
		const result = {
			schemaVersion: PROTON_CAPTURE_SCHEMA_VERSION,
			capturedAt: assertCanonicalUtc(capture.capturedAt, "capture.capturedAt"),
			sections: {},
		};
		const slugs = new Set();
		const files = new Set();
		for (const section of SECTION_ORDER) {
			if (!Array.isArray(sections[section])) {
				throw new ProtonContractError(
					`capture.sections.${section} must be an array`,
				);
			}
			result.sections[section] = sections[section].map((entry, index) => {
				const normalized = validateCaptureEntry(entry, section, index);
				if (slugs.has(normalized.slug)) {
					throw new ProtonContractError(
						`capture repeats slug ${normalized.slug}`,
					);
				}
				for (const evidenceFile of [
					normalized.file,
					normalized.heroFile,
				].filter(Boolean)) {
					if (files.has(evidenceFile)) {
						throw new ProtonContractError(
							`capture repeats file ${evidenceFile}`,
						);
					}
					files.add(evidenceFile);
				}
				slugs.add(normalized.slug);
				return normalized;
			});
		}
		return result;
	} catch (error) {
		throw asProtonError(error, "Invalid Proton capture");
	}
}

function validateRecord(value, index) {
	const label = `ledger.records[${index}]`;
	const record = assertPlainObject(value, label);
	assertOnlyKeys(
		record,
		new Set([
			"slug",
			"section",
			"cloudTitle",
			"exportedAt",
			"exportSha256",
			"semanticSha256",
			"heroSha256",
			"heroPixelSha256",
			"heroSourceSha256",
			"sourceSnapshotSha256",
			"siteOutputSha256",
			"bodyBlockCount",
		]),
		label,
	);
	return {
		slug: assertSlug(record.slug, `${label}.slug`),
		section: assertSection(record.section, `${label}.section`),
		cloudTitle: assertNonEmptyString(record.cloudTitle, `${label}.cloudTitle`),
		exportedAt: assertCanonicalUtc(record.exportedAt, `${label}.exportedAt`),
		exportSha256: assertSha256(record.exportSha256, `${label}.exportSha256`),
		semanticSha256: assertSha256(
			record.semanticSha256,
			`${label}.semanticSha256`,
		),
		heroSha256: assertSha256(record.heroSha256, `${label}.heroSha256`),
		heroPixelSha256: assertSha256(
			record.heroPixelSha256,
			`${label}.heroPixelSha256`,
		),
		heroSourceSha256: assertSha256(
			record.heroSourceSha256,
			`${label}.heroSourceSha256`,
		),
		sourceSnapshotSha256: assertSha256(
			record.sourceSnapshotSha256,
			`${label}.sourceSnapshotSha256`,
		),
		siteOutputSha256: assertSha256(
			record.siteOutputSha256,
			`${label}.siteOutputSha256`,
		),
		bodyBlockCount: assertInteger(
			record.bodyBlockCount,
			`${label}.bodyBlockCount`,
		),
	};
}

export function validateLedger(value, { requireComplete = false } = {}) {
	try {
		const ledger = assertPlainObject(value, "ledger");
		assertOnlyKeys(
			ledger,
			new Set(["schemaVersion", "expectedCount", "records"]),
			"ledger",
		);
		if (ledger.schemaVersion !== PROTON_MASTER_SCHEMA_VERSION) {
			throw new ProtonContractError(
				`ledger.schemaVersion must equal ${PROTON_MASTER_SCHEMA_VERSION}`,
			);
		}
		if (!Array.isArray(ledger.records)) {
			throw new ProtonContractError("ledger.records must be an array");
		}
		const records = ledger.records.map(validateRecord);
		const expectedCount = assertInteger(
			ledger.expectedCount,
			"ledger.expectedCount",
		);
		if (expectedCount !== EXPECTED_RECORD_COUNT) {
			throw new ProtonContractError(
				`ledger.expectedCount must equal ${EXPECTED_RECORD_COUNT}`,
			);
		}
		const slugs = new Set();
		const exportHashes = new Set();
		for (const record of records) {
			if (slugs.has(record.slug)) {
				throw new ProtonContractError(`ledger repeats slug ${record.slug}`);
			}
			if (exportHashes.has(record.exportSha256)) {
				throw new ProtonContractError(
					`ledger reuses an HTML export for ${record.slug}`,
				);
			}
			slugs.add(record.slug);
			exportHashes.add(record.exportSha256);
		}
		if (requireComplete && records.length !== EXPECTED_RECORD_COUNT) {
			throw new ProtonContractError(
				`Proton master ledger is incomplete: ${records.length}/${EXPECTED_RECORD_COUNT}`,
			);
		}
		const normalized = {
			schemaVersion: PROTON_MASTER_SCHEMA_VERSION,
			expectedCount: EXPECTED_RECORD_COUNT,
			records: [...records].sort((left, right) =>
				left.slug.localeCompare(right.slug, "en"),
			),
		};
		assertSanitizedLedger(normalized);
		return normalized;
	} catch (error) {
		throw asProtonError(error, "Invalid Proton master ledger");
	}
}

async function decodedPixelSha256(buffer, label) {
	try {
		const pixels = await sharp(buffer, {
			animated: true,
			failOn: "warning",
			limitInputPixels: 100_000_000,
			sequentialRead: true,
		})
			.toColourspace("srgb")
			.ensureAlpha()
			.raw({ depth: "uchar" })
			.toBuffer();
		return sha256(pixels);
	} catch (error) {
		throw new ProtonContractError(`${label} could not be decoded`, {
			cause: error,
		});
	}
}

export function heroSourceSha256(buffer, label = "Proton HTML export") {
	const parseErrors = [];
	const fragment = parseFragment(decodeUtf8(buffer, label), {
		onParseError: (error) => parseErrors.push(error),
	});
	if (parseErrors.length > 0) {
		throw new ProtonContractError(
			`${label} contains malformed HTML (${parseErrors[0].code})`,
		);
	}
	const images = [];
	const visit = (node) => {
		if (node.tagName === "img") images.push(node);
		for (const child of node.childNodes ?? []) visit(child);
	};
	visit(fragment);
	if (images.length !== 1) {
		throw new ProtonContractError(
			`${label} must contain exactly one hero image source`,
		);
	}
	const source = images[0].attrs?.find(
		(attribute) => attribute.name === "src",
	)?.value;
	if (typeof source !== "string" || source.length === 0) {
		throw new ProtonContractError(`${label} hero image source is missing`);
	}
	return sha256(Buffer.from(source, "utf8"));
}

function mediumSemanticModel(snapshot, hero) {
	return {
		schemaVersion: PROTON_MASTER_SCHEMA_VERSION,
		cloudTitle: snapshot.exportTitle,
		header: {
			summary: snapshot.summary,
			title: snapshot.title,
			subtitle: snapshot.subtitle,
			seriesLine: snapshot.seriesLine,
		},
		hero: {
			alt: snapshot.imageAlt ?? "",
			caption: snapshot.imageCaption,
			width: hero.width,
			height: hero.height,
			pixelSha256: hero.pixelSha256,
		},
		bodyDocument: snapshot.bodyDocument,
	};
}

function archiveSemanticModel(snapshot) {
	return {
		schemaVersion: PROTON_MASTER_SCHEMA_VERSION,
		cloudTitle: snapshot.title,
		header: {
			subtitle: snapshot.subtitle,
		},
		hero: {
			alt: snapshot.hero.rawAlt,
			caption: snapshot.imageCaption,
			width: snapshot.hero.width,
			height: snapshot.hero.height,
		},
		bodyDocument: snapshot.bodyDocument,
	};
}

async function loadExpectedBindings(repoRoot) {
	try {
		await Promise.all([
			verifyArticles({ repoRoot, requireComplete: true }),
			verifyMediumArticles({ repoRoot, requireComplete: true }),
		]);
	} catch (error) {
		throw asProtonError(error, "Committed writing evidence is invalid");
	}
	const archiveManifestFile = await readJsonFile(
		path.join(repoRoot, "provenance/tai-song/manifest.json"),
		"Archive manifest",
	);
	const archiveInventoryFile = await readJsonFile(
		path.join(repoRoot, "provenance/tai-song/inventory.json"),
		"Archive inventory",
	);
	const mediumManifestFile = await readJsonFile(
		path.join(repoRoot, "provenance/medium/manifest.json"),
		"Medium manifest",
	);
	const archiveManifest = archiveManifestFile.value;
	const archiveInventory = archiveInventoryFile.value;
	const mediumManifest = mediumManifestFile.value;
	if (
		archiveManifest.articles?.length !== EXPECTED_FICTION_COUNT ||
		archiveInventory.articles?.length !== EXPECTED_FICTION_COUNT ||
		mediumManifest.articles?.length !== EXPECTED_NONFICTION_COUNT
	) {
		throw new ProtonContractError(
			`Committed evidence must contain exactly ${EXPECTED_FICTION_COUNT} archive and ${EXPECTED_NONFICTION_COUNT} nonfiction works`,
		);
	}
	const archiveTitles = new Map(
		archiveInventory.articles.map((article) => [article.slug, article.title]),
	);
	const bindings = [];
	for (const entry of archiveManifest.articles) {
		const snapshotFile = await readJsonFile(
			path.join(repoRoot, ...entry.paths.snapshot.split("/")),
			`Archive snapshot ${entry.slug}`,
		);
		const markdown = await readBoundedFile(
			path.join(repoRoot, ...entry.paths.markdown.split("/")),
			`Archive Markdown ${entry.slug}`,
			MAX_HTML_BYTES,
		);
		const hero = await readBoundedFile(
			path.join(repoRoot, ...entry.paths.image.split("/")),
			`Archive hero ${entry.slug}`,
			MAX_HTML_BYTES,
		);
		if (
			sha256(snapshotFile.buffer) !== entry.hashes.snapshot ||
			sha256(markdown) !== entry.hashes.markdown ||
			sha256(hero) !== entry.hashes.image
		) {
			throw new ProtonContractError(
				`Committed archive hashes differ for ${entry.slug}`,
			);
		}
		const snapshot = snapshotFile.value;
		if (snapshot.title !== archiveTitles.get(entry.slug)) {
			throw new ProtonContractError(
				`Archive title binding differs for ${entry.slug}`,
			);
		}
		bindings.push({
			slug: entry.slug,
			section: "fiction",
			cloudTitle:
				ARCHIVE_CLOUD_TITLE_OVERRIDES.get(entry.slug) ?? snapshot.title,
			sourceSnapshotSha256: entry.hashes.snapshot,
			siteOutputSha256: entry.hashes.markdown,
			heroSha256: entry.hashes.image,
			heroPixelSha256: await decodedPixelSha256(
				hero,
				`Archive hero ${entry.slug}`,
			),
			bodyBlockCount: snapshot.bodyDocument.blocks.length,
			semanticSha256: canonicalDigest(archiveSemanticModel(snapshot)),
			snapshot,
		});
	}
	for (const entry of mediumManifest.articles) {
		let evidence;
		try {
			evidence = await loadMediumMasterEvidence({ repoRoot, slug: entry.slug });
		} catch (error) {
			throw asProtonError(error, `Medium evidence ${entry.slug} is invalid`);
		}
		const heroEntry = entry.assets.find((asset) => asset.role === "hero");
		if (!heroEntry || heroEntry.sha256 !== evidence.hero.sha256) {
			throw new ProtonContractError(
				`Medium hero binding differs for ${entry.slug}`,
			);
		}
		bindings.push({
			slug: entry.slug,
			section: "nonfiction",
			cloudTitle: evidence.snapshot.exportTitle,
			sourceSnapshotSha256: entry.hashes.snapshot,
			siteOutputSha256: entry.hashes.markdown,
			heroSha256: heroEntry.sha256,
			heroPixelSha256: evidence.hero.pixelSha256,
			bodyBlockCount: evidence.snapshot.bodyDocument.blocks.length,
			semanticSha256: canonicalDigest(
				mediumSemanticModel(evidence.snapshot, evidence.hero),
			),
			snapshot: evidence.snapshot,
		});
	}
	if (
		bindings.length !== EXPECTED_RECORD_COUNT ||
		new Set(bindings.map((binding) => binding.slug)).size !==
			EXPECTED_RECORD_COUNT
	) {
		throw new ProtonContractError(
			"Committed writing bindings are not exactly 35 unique slugs",
		);
	}
	return bindings.sort((left, right) =>
		left.slug.localeCompare(right.slug, "en"),
	);
}

export async function expectedInventory({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
	const bindings = await loadExpectedBindings(repoRoot);
	return {
		expectedCount: EXPECTED_RECORD_COUNT,
		sections: {
			fiction: bindings
				.filter((binding) => binding.section === "fiction")
				.map(({ slug, cloudTitle }) => ({ slug, title: cloudTitle })),
			nonfiction: bindings
				.filter((binding) => binding.section === "nonfiction")
				.map(({ slug, cloudTitle }) => ({ slug, title: cloudTitle })),
		},
	};
}

export async function loadCapture({
	repoRoot = DEFAULT_REPO_ROOT,
	capturePath = DEFAULT_CAPTURE_PATH,
} = {}) {
	assertSafeRepositoryPath(capturePath, "capture path");
	if (
		!capturePath.startsWith(".proton-import/") &&
		!capturePath.startsWith(".medium-import/")
	) {
		throw new ProtonContractError(
			"Capture evidence must remain under an ignored import directory",
		);
	}
	const captureFile = await readJsonFile(
		path.join(repoRoot, ...capturePath.split("/")),
		"Proton capture",
		{ canonical: true },
	);
	return validateCapture(captureFile.value);
}

export async function verifyCaptureInventory({
	repoRoot = DEFAULT_REPO_ROOT,
	capture,
} = {}) {
	const normalized = validateCapture(capture);
	const expected = await expectedInventory({ repoRoot });
	for (const section of SECTION_ORDER) {
		const captured = normalized.sections[section].map(({ slug, title }) => ({
			slug,
			title,
		}));
		if (
			JSON.stringify(captured) !== JSON.stringify(expected.sections[section])
		) {
			throw new ProtonContractError(
				`Captured ${section} inventory differs from the exact committed slug/title set`,
			);
		}
	}
	return {
		capturedAt: normalized.capturedAt,
		fictionCount: normalized.sections.fiction.length,
		nonfictionCount: normalized.sections.nonfiction.length,
		totalCount:
			normalized.sections.fiction.length +
			normalized.sections.nonfiction.length,
		complete: true,
	};
}

async function verifyMediumRaw(repoRoot, binding, raw) {
	const bridgeRoot = path.join(repoRoot, ".medium-import");
	const bridgeDirectory = await mkdtemp(
		path.join(bridgeRoot, `.proton-verify-${randomUUID()}-`),
	);
	const bridgePath = path.join(bridgeDirectory, "export.html");
	try {
		await writeFile(bridgePath, raw.buffer, { flag: "wx" });
		const result = await verifyProtonMasterExport({
			repoRoot,
			slug: binding.slug,
			exportPath: bridgePath,
		});
		if (
			result.bodyBlockCount !== binding.bodyBlockCount ||
			result.heroPixelSha256 !== binding.heroPixelSha256
		) {
			throw new ProtonContractError(
				`Exported nonfiction semantics differ for ${binding.slug}`,
			);
		}
		return result;
	} catch (error) {
		throw asProtonError(error, `Proton export ${binding.slug} is invalid`);
	} finally {
		await rm(bridgeDirectory, { recursive: true, force: true }).catch(() => {});
	}
}

export async function verifyFictionHeroBuffer(binding, buffer) {
	if (sha256(buffer) !== binding.heroSha256) {
		throw new ProtonContractError(
			`Proton fiction hero bytes differ for ${binding.slug}`,
		);
	}
	let metadata;
	try {
		metadata = await sharp(buffer, {
			animated: false,
			failOn: "warning",
			limitInputPixels: 100_000_000,
			sequentialRead: true,
		}).metadata();
	} catch (error) {
		throw new ProtonContractError(
			`Proton fiction hero could not be decoded for ${binding.slug}`,
			{ cause: error },
		);
	}
	if (
		metadata.format !== "png" ||
		metadata.width !== binding.snapshot.hero.width ||
		metadata.height !== binding.snapshot.hero.height
	) {
		throw new ProtonContractError(
			`Proton fiction hero format or dimensions differ for ${binding.slug}`,
		);
	}
	if (
		(await decodedPixelSha256(
			buffer,
			`Proton fiction hero ${binding.slug}`,
		)) !== binding.heroPixelSha256
	) {
		throw new ProtonContractError(
			`Proton fiction hero pixels differ for ${binding.slug}`,
		);
	}
}

function verifyArchiveRaw(binding, raw) {
	let extracted;
	try {
		extracted = extractProtonHtml(decodeUtf8(raw.buffer, binding.slug));
	} catch (error) {
		throw new ProtonContractError(
			`Proton export ${binding.slug} is invalid: ${error.message}`,
			{ cause: error },
		);
	}
	if (
		(extracted.leadTitle !== undefined &&
			extracted.leadTitle !== binding.snapshot.title) ||
		extracted.subtitle !== binding.snapshot.subtitle ||
		extracted.caption !== binding.snapshot.imageCaption ||
		extracted.hero.alt !== binding.snapshot.hero.rawAlt ||
		JSON.stringify(extracted.document) !==
			JSON.stringify(binding.snapshot.bodyDocument)
	) {
		throw new ProtonContractError(
			`Exported fiction semantics differ for ${binding.slug}`,
		);
	}
	return {
		bodyBlockCount: extracted.document.blocks.length,
	};
}

async function verifyRawBinding(repoRoot, binding, captureEntry) {
	if (
		captureEntry.slug !== binding.slug ||
		captureEntry.title !== binding.cloudTitle
	) {
		throw new ProtonContractError(
			`Capture slug/title binding differs for ${binding.slug}`,
		);
	}
	const raw = await readRawExport(
		repoRoot,
		captureEntry.file,
		`Proton HTML export ${binding.slug}`,
	);
	let verification;
	if (binding.section === "fiction") {
		verification = verifyArchiveRaw(binding, raw);
		const hero = await readRawFictionHero(
			repoRoot,
			captureEntry.heroFile,
			`Proton fiction hero ${binding.slug}`,
		);
		await verifyFictionHeroBuffer(binding, hero.buffer);
	} else {
		verification = await verifyMediumRaw(repoRoot, binding, raw);
	}
	if (verification.bodyBlockCount !== binding.bodyBlockCount) {
		throw new ProtonContractError(
			`Proton body block count differs for ${binding.slug}`,
		);
	}
	return {
		exportedAt: captureEntry.exportedAt,
		exportSha256: sha256(raw.buffer),
		heroSourceSha256: heroSourceSha256(
			raw.buffer,
			`Proton HTML export ${binding.slug}`,
		),
	};
}

function captureEntries(capture) {
	return new Map(
		SECTION_ORDER.flatMap((section) =>
			capture.sections[section].map((entry) => [
				entry.slug,
				{ ...entry, section },
			]),
		),
	);
}

export async function createLedgerFromCapture({
	repoRoot = DEFAULT_REPO_ROOT,
	capture,
} = {}) {
	const normalizedCapture = validateCapture(capture);
	await verifyCaptureInventory({ repoRoot, capture: normalizedCapture });
	const bindings = await loadExpectedBindings(repoRoot);
	const entries = captureEntries(normalizedCapture);
	const records = [];
	for (const binding of bindings) {
		const captureEntry = entries.get(binding.slug);
		if (!captureEntry || captureEntry.section !== binding.section) {
			throw new ProtonContractError(
				`Capture has no matching export for ${binding.slug}`,
			);
		}
		const raw = await verifyRawBinding(repoRoot, binding, captureEntry);
		records.push({
			slug: binding.slug,
			section: binding.section,
			cloudTitle: binding.cloudTitle,
			exportedAt: raw.exportedAt,
			exportSha256: raw.exportSha256,
			semanticSha256: binding.semanticSha256,
			heroSha256: binding.heroSha256,
			heroPixelSha256: binding.heroPixelSha256,
			heroSourceSha256: raw.heroSourceSha256,
			sourceSnapshotSha256: binding.sourceSnapshotSha256,
			siteOutputSha256: binding.siteOutputSha256,
			bodyBlockCount: binding.bodyBlockCount,
		});
	}
	return validateLedger(
		{
			schemaVersion: PROTON_MASTER_SCHEMA_VERSION,
			expectedCount: EXPECTED_RECORD_COUNT,
			records,
		},
		{ requireComplete: true },
	);
}

export async function writeLedgerNoOverwrite({
	repoRoot = DEFAULT_REPO_ROOT,
	ledger,
	outputPath = DEFAULT_LEDGER_PATH,
} = {}) {
	assertSafeRepositoryPath(outputPath, "ledger output path");
	if (!outputPath.startsWith("provenance/proton/")) {
		throw new ProtonContractError(
			"Ledger output must remain under provenance/proton",
		);
	}
	const normalized = validateLedger(ledger, { requireComplete: true });
	const output = path.join(repoRoot, ...outputPath.split("/"));
	try {
		await writeFile(output, serializeJson(normalized), { flag: "wx" });
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new ProtonContractError(
				`Refusing to overwrite existing Proton ledger: ${outputPath}`,
			);
		}
		throw error;
	}
	return outputPath;
}

export async function verifyLedgerEvidence({
	repoRoot = DEFAULT_REPO_ROOT,
	ledger,
	capture,
	withRaw = false,
	requireComplete = false,
} = {}) {
	const normalizedLedger = validateLedger(ledger, { requireComplete });
	const bindings = await loadExpectedBindings(repoRoot);
	const bySlug = new Map(
		normalizedLedger.records.map((record) => [record.slug, record]),
	);
	const normalizedCapture = withRaw ? validateCapture(capture) : undefined;
	if (withRaw) {
		await verifyCaptureInventory({ repoRoot, capture: normalizedCapture });
	}
	const captureBySlug = normalizedCapture
		? captureEntries(normalizedCapture)
		: new Map();
	for (const binding of bindings) {
		const record = bySlug.get(binding.slug);
		if (!record) {
			if (requireComplete) {
				throw new ProtonContractError(
					`Ledger has no record for ${binding.slug}`,
				);
			}
			continue;
		}
		for (const key of [
			"section",
			"cloudTitle",
			"semanticSha256",
			"heroSha256",
			"heroPixelSha256",
			"sourceSnapshotSha256",
			"siteOutputSha256",
			"bodyBlockCount",
		]) {
			if (record[key] !== binding[key]) {
				throw new ProtonContractError(
					`Ledger ${key} binding differs for ${binding.slug}`,
				);
			}
		}
		if (withRaw) {
			const captureEntry = captureBySlug.get(binding.slug);
			if (!captureEntry || captureEntry.exportedAt !== record.exportedAt) {
				throw new ProtonContractError(
					`Raw capture timestamp binding differs for ${binding.slug}`,
				);
			}
			const raw = await verifyRawBinding(repoRoot, binding, captureEntry);
			if (raw.exportSha256 !== record.exportSha256) {
				throw new ProtonContractError(
					`Raw export hash differs for ${binding.slug}`,
				);
			}
			if (raw.heroSourceSha256 !== record.heroSourceSha256) {
				throw new ProtonContractError(
					`Raw hero source differs for ${binding.slug}`,
				);
			}
		}
	}
	if (requireComplete && bySlug.size !== bindings.length) {
		throw new ProtonContractError(
			`Ledger contains ${bySlug.size}/${bindings.length} expected bindings`,
		);
	}
	return {
		verifiedCount: normalizedLedger.records.length,
		expectedCount: EXPECTED_RECORD_COUNT,
		withRaw,
		complete: normalizedLedger.records.length === EXPECTED_RECORD_COUNT,
	};
}

export async function loadLedger({
	repoRoot = DEFAULT_REPO_ROOT,
	ledgerPath = DEFAULT_LEDGER_PATH,
	requireComplete = false,
} = {}) {
	assertSafeRepositoryPath(ledgerPath, "ledger path");
	if (!ledgerPath.startsWith("provenance/proton/")) {
		throw new ProtonContractError("Ledger must be under provenance/proton");
	}
	const file = await readJsonFile(
		path.join(repoRoot, ...ledgerPath.split("/")),
		"Proton master ledger",
		{ canonical: true },
	);
	return validateLedger(file.value, { requireComplete });
}
