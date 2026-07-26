import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { validateClaimReviews } from "../../content/claims.js";
import {
	validateContentSignoffsV2,
	validatePresentationSignoffsV2,
} from "../../content/signoffs.js";
import { buildMediumHeroChecklist } from "./assets.js";
import {
	ALL_RIGHTS_RESERVED,
	AUTHOR_NAME,
	AUTHOR_PROFILE_URL,
	AUTHORITY_PLATFORM,
	assertCanonicalUtc,
	assertOnlyKeys,
	assertPlainObject,
	assertSafeRepositoryPath,
	assertSha256,
	assertSlug,
	CAPTURE_FORMAT,
	getMediumArticlePaths,
	getMediumPaths,
	INVENTORY_SCHEMA_VERSION,
	MANIFEST_SCHEMA_VERSION,
	MediumContractError,
	SNAPSHOT_SCHEMA_VERSION,
	serializeJson,
	toRepositoryPath,
} from "./contract.js";
import {
	decodeUtf8,
	extractCandidateMetadata,
	extractMediumAuthorEvidence,
	extractMediumStoryHtml,
	validateMediumDocument,
} from "./html.js";
import { inspectImage, sha256 } from "./integrity.js";
import {
	mediumCandidateSetSha256,
	validateMediumInventory,
	validateMediumManifest,
	validateMediumSnapshot,
} from "./model.js";
import {
	bodyTextSha256,
	renderMediumBodyHtml,
	renderMediumIndexMarkdown,
} from "./render.js";
import {
	buildMediumInventoryReviewProposal,
	validateUnresolvedMediumCandidate,
} from "./review.js";
import { readZipEntries } from "./zip.js";

function parseJson(buffer, label) {
	let value;
	try {
		value = JSON.parse(decodeUtf8(buffer, label));
	} catch (error) {
		if (error instanceof MediumContractError) throw error;
		throw new MediumContractError(`${label} is not valid JSON`, {
			cause: error,
		});
	}
	if (!buffer.equals(Buffer.from(serializeJson(value), "utf8"))) {
		throw new MediumContractError(
			`${label} must use canonical JSON formatting`,
		);
	}
	return value;
}

async function readRequired(filePath, label) {
	try {
		return await readFile(filePath);
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new MediumContractError(`${label} is missing: ${filePath}`);
		}
		throw error;
	}
}

async function writeAtomic(filePath, contents) {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.medium-import-${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, contents, { flag: "wx" });
		await rename(temporaryPath, filePath);
	} catch (error) {
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

async function writeNewFile(filePath, contents, label) {
	await mkdir(path.dirname(filePath), { recursive: true });
	try {
		await writeFile(filePath, contents, { flag: "wx" });
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new MediumContractError(
				`${label} already exists; remove it explicitly before generating a replacement`,
			);
		}
		throw error;
	}
}

async function writeTransaction(operations) {
	const targets = operations.map((operation) => path.resolve(operation.path));
	if (new Set(targets).size !== targets.length)
		throw new MediumContractError("Import transaction repeats an output path");
	const prepared = [];
	try {
		for (const operation of operations) {
			await mkdir(path.dirname(operation.path), { recursive: true });
			const nonce = randomUUID();
			const temporaryPath = `${operation.path}.medium-import-${nonce}.tmp`;
			const backupPath = `${operation.path}.medium-import-${nonce}.bak`;
			await writeFile(temporaryPath, operation.contents, { flag: "wx" });
			prepared.push({
				...operation,
				temporaryPath,
				backupPath,
				hadOriginal: false,
				installed: false,
			});
		}
		for (const operation of prepared) {
			try {
				await rename(operation.path, operation.backupPath);
				operation.hadOriginal = true;
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
			await rename(operation.temporaryPath, operation.path);
			operation.installed = true;
		}
	} catch (error) {
		for (const operation of [...prepared].reverse()) {
			if (operation.installed) await unlink(operation.path).catch(() => {});
			if (operation.hadOriginal)
				await rename(operation.backupPath, operation.path).catch(() => {});
			await unlink(operation.temporaryPath).catch(() => {});
		}
		throw error;
	}
	const cleanupFailures = [];
	for (const operation of prepared) {
		if (!operation.hadOriginal) continue;
		try {
			await unlink(operation.backupPath);
		} catch {
			cleanupFailures.push(operation.backupPath);
		}
	}
	if (cleanupFailures.length > 0)
		throw new MediumContractError(
			"Import committed successfully, but one or more private backup files require manual cleanup",
		);
}

function assertRawEvidenceUntracked(repoRoot) {
	const gitMarker = path.join(repoRoot, ".git");
	if (!existsSync(gitMarker)) return;
	const result = spawnSync(
		"git",
		["-C", repoRoot, "ls-files", "--", ".medium-import"],
		{ encoding: "utf8", windowsHide: true },
	);
	if (result.status !== 0) {
		throw new MediumContractError(
			`Unable to prove Medium raw evidence is untracked: ${(result.stderr || result.stdout).trim()}`,
		);
	}
	if (result.stdout.trim().length > 0) {
		throw new MediumContractError(
			"Refusing to continue because .medium-import contains Git-tracked files",
		);
	}
}

function assertInsideRawRoot(repoRoot, exportPath) {
	const rawRoot = path.resolve(getMediumPaths(repoRoot).rawRoot);
	const absoluteExport = path.resolve(exportPath);
	const relative = path.relative(rawRoot, absoluteExport);
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new MediumContractError(
			"Raw Medium evidence must remain under .medium-import/raw/",
		);
	}
	return absoluteExport;
}

async function readRawFileInside(repoRoot, filePath, label) {
	const rawRoot = path.resolve(getMediumPaths(repoRoot).rawRoot);
	const lexicalPath = assertInsideRawRoot(repoRoot, filePath);
	let rawRootReal;
	let fileReal;
	let fileStats;
	try {
		[rawRootReal, fileReal, fileStats] = await Promise.all([
			realpath(rawRoot),
			realpath(lexicalPath),
			lstat(lexicalPath),
		]);
	} catch (error) {
		if (error?.code === "ENOENT")
			throw new MediumContractError(`${label} is missing: ${lexicalPath}`);
		throw error;
	}
	const relative = path.relative(rawRootReal, fileReal);
	if (
		!fileStats.isFile() ||
		fileStats.isSymbolicLink() ||
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new MediumContractError(
			`${label} must be a regular file physically contained by .medium-import/raw`,
		);
	}
	return readFile(fileReal);
}

function exportedCandidates(entries) {
	return [...entries.entries()]
		.filter(([entryPath]) => /(?:^|\/)posts\/[^/]+\.html$/iu.test(entryPath))
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([sourcePath, buffer]) => ({
			...extractCandidateMetadata(decodeUtf8(buffer, sourcePath), sourcePath),
			sourcePath,
			sourceSha256: sha256(buffer),
		}));
}

export function createUnreviewedInventoryCandidates(entries) {
	return exportedCandidates(entries).map((candidate) => ({
		...candidate,
		include: null,
		exclusionReason: "",
		classification: {
			visibility: null,
			authorship: null,
			format: null,
		},
	}));
}

async function loadOfficialExport(repoRoot, exportPath) {
	assertRawEvidenceUntracked(repoRoot);
	const absoluteExport = assertInsideRawRoot(repoRoot, exportPath);
	const exportBuffer = await readRawFileInside(
		repoRoot,
		absoluteExport,
		"Official Medium export ZIP",
	);
	return {
		absoluteExport,
		exportBuffer,
		entries: readZipEntries(exportBuffer),
	};
}

async function loadAssetCandidateLedger(
	repoRoot,
	{ absoluteExport, exportBuffer, entries },
) {
	const ledger = assertPlainObject(
		parseJson(
			await readRequired(
				getMediumPaths(repoRoot).candidatePath,
				"Medium inventory candidate ledger",
			),
			"Medium inventory candidate ledger",
		),
		"Medium inventory candidate ledger",
	);
	assertOnlyKeys(
		ledger,
		new Set([
			"schemaVersion",
			"state",
			"authority",
			"author",
			"export",
			"candidateCount",
			"candidateSetSha256",
			"candidates",
		]),
		"Medium inventory candidate ledger",
	);
	if (
		ledger.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
		ledger.state !== "needs-review"
	) {
		throw new MediumContractError(
			"Medium inventory candidate ledger must be the version 1 unresolved review candidate",
		);
	}
	if (
		ledger.authority?.platform !== AUTHORITY_PLATFORM ||
		ledger.authority?.captureFormat !== CAPTURE_FORMAT ||
		ledger.author?.name !== AUTHOR_NAME ||
		ledger.author?.profileUrl !== AUTHOR_PROFILE_URL
	) {
		throw new MediumContractError(
			"Medium inventory candidate ledger authority or author is invalid",
		);
	}
	const exportRecord = assertPlainObject(
		ledger.export,
		"Medium inventory candidate ledger export",
	);
	if (
		exportRecord.fileName !== path.basename(absoluteExport) ||
		exportRecord.sha256 !== sha256(exportBuffer)
	) {
		throw new MediumContractError(
			"Medium inventory candidate ledger does not bind the supplied official export",
		);
	}
	const capturedAt = assertCanonicalUtc(
		exportRecord.capturedAt,
		"Medium inventory candidate ledger export.capturedAt",
	);
	if (
		!Array.isArray(ledger.candidates) ||
		!Number.isSafeInteger(ledger.candidateCount) ||
		ledger.candidateCount !== ledger.candidates.length
	) {
		throw new MediumContractError(
			"Medium inventory candidate ledger has an inconsistent candidate count",
		);
	}
	const candidateSetSha256 = assertSha256(
		ledger.candidateSetSha256,
		"Medium inventory candidate ledger candidateSetSha256",
	);
	if (candidateSetSha256 !== mediumCandidateSetSha256(ledger.candidates)) {
		throw new MediumContractError(
			"Medium inventory candidate ledger candidate-set SHA-256 is invalid",
		);
	}
	const sourcePaths = new Set();
	for (const [index, candidateValue] of ledger.candidates.entries()) {
		const candidate = validateUnresolvedMediumCandidate(
			candidateValue,
			`Medium inventory candidate ledger candidates[${index}]`,
		);
		const sourcePath = candidate.sourcePath;
		if (
			sourcePaths.has(sourcePath) ||
			!entries.has(sourcePath) ||
			candidate.sourceSha256 !== sha256(entries.get(sourcePath))
		) {
			throw new MediumContractError(
				"Medium inventory candidate ledger source evidence differs from the official export",
			);
		}
		sourcePaths.add(sourcePath);
	}
	return {
		candidates: ledger.candidates,
		candidateSetSha256,
		exportRecord: {
			fileName: exportRecord.fileName,
			sha256: exportRecord.sha256,
			capturedAt,
		},
	};
}

export async function createInventoryCandidate({
	repoRoot,
	exportPath,
	capturedAt,
	write = false,
} = {}) {
	const { absoluteExport, exportBuffer, entries } = await loadOfficialExport(
		repoRoot,
		exportPath,
	);
	const candidates = createUnreviewedInventoryCandidates(entries);
	if (candidates.length === 0) {
		throw new MediumContractError(
			"The export contains no posts/*.html candidates; verify this is the official account export",
		);
	}
	const duplicateSlugs = candidates
		.map((candidate) => candidate.suggestedSlug)
		.filter((slug, index, values) => values.indexOf(slug) !== index);
	if (duplicateSlugs.length > 0) {
		throw new MediumContractError(
			`Candidate slug collision requires author review: ${[...new Set(duplicateSlugs)].join(", ")}`,
		);
	}
	const effectiveCapturedAt = capturedAt
		? assertCanonicalUtc(capturedAt, "capturedAt")
		: null;
	if (write && effectiveCapturedAt === null) {
		throw new MediumContractError(
			"Writing an inventory candidate requires --captured-at <canonical UTC timestamp>",
		);
	}
	const candidate = {
		schemaVersion: INVENTORY_SCHEMA_VERSION,
		state: "needs-review",
		authority: {
			platform: AUTHORITY_PLATFORM,
			captureFormat: CAPTURE_FORMAT,
		},
		author: { name: AUTHOR_NAME, profileUrl: AUTHOR_PROFILE_URL },
		export: {
			fileName: path.basename(absoluteExport),
			sha256: sha256(exportBuffer),
			capturedAt: effectiveCapturedAt,
		},
		candidateCount: candidates.length,
		candidateSetSha256: mediumCandidateSetSha256(candidates),
		candidates,
	};
	if (write) {
		await writeAtomic(
			getMediumPaths(repoRoot).candidatePath,
			Buffer.from(serializeJson(candidate), "utf8"),
		);
	}
	return {
		mode: write ? "write" : "dry-run",
		candidatePath: toRepositoryPath(
			repoRoot,
			getMediumPaths(repoRoot).candidatePath,
		),
		candidate,
	};
}

export async function createMediumHeroChecklist({
	repoRoot,
	exportPath,
	approvedAllowlist,
	expectedCount,
	expectedCandidateCount,
	write = false,
} = {}) {
	const { absoluteExport, exportBuffer, entries } = await loadOfficialExport(
		repoRoot,
		exportPath,
	);
	const { candidates, candidateSetSha256 } = await loadAssetCandidateLedger(
		repoRoot,
		{ absoluteExport, exportBuffer, entries },
	);
	if (candidates.length === 0) {
		throw new MediumContractError(
			"The export contains no posts/*.html candidates; verify this is the official account export",
		);
	}
	const checklist = buildMediumHeroChecklist({
		entries,
		candidates,
		approvedAllowlist,
		exportFileName: path.basename(absoluteExport),
		exportSha256: sha256(exportBuffer),
		candidateSetSha256,
		...(expectedCount === undefined ? {} : { expectedCount }),
		...(expectedCandidateCount === undefined ? {} : { expectedCandidateCount }),
	});
	const checklistPath = getMediumPaths(repoRoot).assetChecklistPath;
	if (write) {
		await writeNewFile(
			checklistPath,
			Buffer.from(serializeJson(checklist), "utf8"),
			"Medium hero acquisition checklist",
		);
	}
	return {
		mode: write ? "write" : "dry-run",
		checklistPath: toRepositoryPath(repoRoot, checklistPath),
		checklist,
	};
}

export async function createMediumInventoryReviewProposal({
	repoRoot,
	exportPath,
	approvedAllowlist,
	write = false,
} = {}) {
	const { absoluteExport, exportBuffer, entries } = await loadOfficialExport(
		repoRoot,
		exportPath,
	);
	const { candidates, exportRecord } = await loadAssetCandidateLedger(
		repoRoot,
		{
			absoluteExport,
			exportBuffer,
			entries,
		},
	);
	let authorEvidenceCount = 0;
	for (const candidate of candidates) {
		const source = entries.get(candidate.sourcePath);
		if (!Buffer.isBuffer(source)) {
			throw new MediumContractError(
				`Medium candidate author evidence is missing: ${candidate.sourcePath}`,
			);
		}
		extractMediumAuthorEvidence(
			decodeUtf8(source, candidate.sourcePath),
			candidate.sourcePath,
		);
		authorEvidenceCount += 1;
	}
	const proposal = buildMediumInventoryReviewProposal({
		candidates,
		approvedAllowlist,
		exportRecord,
		authorEvidenceCount,
	});
	const reviewProposalPath = getMediumPaths(repoRoot).reviewProposalPath;
	if (write) {
		await writeNewFile(
			reviewProposalPath,
			Buffer.from(serializeJson(proposal), "utf8"),
			"Medium inventory review proposal",
		);
	}
	return {
		mode: write ? "write" : "dry-run",
		reviewProposalPath: toRepositoryPath(repoRoot, reviewProposalPath),
		proposal,
	};
}

async function loadInventory(repoRoot) {
	const inventoryPath = getMediumPaths(repoRoot).inventoryPath;
	const buffer = await readRequired(inventoryPath, "Medium inventory");
	const value = parseJson(buffer, "Medium inventory");
	return { value, buffer, ...validateMediumInventory(value) };
}

async function loadManifest(repoRoot) {
	const manifestPath = getMediumPaths(repoRoot).manifestPath;
	const buffer = await readRequired(manifestPath, "Medium manifest");
	const value = parseJson(buffer, "Medium manifest");
	return { value, buffer, ...validateMediumManifest(value) };
}

async function loadRawExport(repoRoot, inventory) {
	assertRawEvidenceUntracked(repoRoot);
	if (inventory.state !== "reviewed") {
		throw new MediumContractError(
			"The Medium inventory is awaiting an official export and author review",
		);
	}
	const exportPath = path.join(
		getMediumPaths(repoRoot).rawRoot,
		inventory.export.fileName,
	);
	const buffer = await readRawFileInside(
		repoRoot,
		exportPath,
		"Official Medium export ZIP",
	);
	if (sha256(buffer) !== inventory.export.sha256) {
		throw new MediumContractError(
			"Official Medium export hash differs from the reviewed inventory",
		);
	}
	const entries = readZipEntries(buffer);
	const candidates = exportedCandidates(entries);
	if (
		candidates.length !== inventory.candidateCount ||
		mediumCandidateSetSha256(candidates) !== inventory.candidateSetSha256
	) {
		throw new MediumContractError(
			"Official Medium export candidate set differs from the reviewed disposition ledger",
		);
	}
	return { buffer, entries };
}

function captionText(tokens, label) {
	let value = "";
	for (const [index, token] of tokens.entries()) {
		if (
			token.type !== "text" ||
			token.marks.length !== 0 ||
			token.href !== undefined
		) {
			throw new MediumContractError(
				`${label}[${index}] must be unmarked caption text`,
			);
		}
		value += token.text;
	}
	return value;
}

function removeAndValidateHero(documentValue, article) {
	const document = validateMediumDocument(documentValue);
	const hero = article.assets.find((asset) => asset.role === "hero");
	const matchingIndexes = document.blocks
		.map((block, index) => ({ block, index }))
		.filter(
			({ block }) =>
				block.type === "figure" && block.sourceUrl === hero.sourceUrl,
		);
	if (matchingIndexes.length !== 1) {
		throw new MediumContractError(
			`Story ${article.slug} must contain its reviewed hero exactly once as a top-level figure`,
		);
	}
	const heroBlock = matchingIndexes[0].block;
	if (
		heroBlock.alt !== (hero.alt ?? "") ||
		captionText(heroBlock.caption, "hero.caption") !== hero.caption
	) {
		throw new MediumContractError(
			`Story ${article.slug} hero alt text or caption differs from its reviewed inventory`,
		);
	}
	const blocks = document.blocks.filter(
		(_block, index) => index !== matchingIndexes[0].index,
	);
	if (blocks.length === 0) {
		throw new MediumContractError(
			`Story ${article.slug} has no body after its hero`,
		);
	}
	const bodyFigures = [];
	const collectFigures = (block) => {
		if (block.type === "figure") bodyFigures.push(block);
		if (block.type === "blockquote") block.blocks.forEach(collectFigures);
		if (block.type === "list") {
			for (const item of block.items) item.forEach(collectFigures);
		}
	};
	blocks.forEach(collectFigures);
	const expectedBodyAssets = article.assets.filter(
		(asset) => asset.role === "body",
	);
	if (bodyFigures.length !== expectedBodyAssets.length) {
		throw new MediumContractError(
			`Story ${article.slug} body image count differs from its reviewed inventory`,
		);
	}
	for (const asset of expectedBodyAssets) {
		const matches = bodyFigures.filter(
			(figure) => figure.sourceUrl === asset.sourceUrl,
		);
		if (
			matches.length !== 1 ||
			matches[0].alt !== (asset.alt ?? "") ||
			captionText(matches[0].caption, `${asset.id}.caption`) !== asset.caption
		) {
			throw new MediumContractError(
				`Story ${article.slug} image ${asset.id} differs from its reviewed inventory`,
			);
		}
	}
	return { blocks };
}

async function loadAssets(repoRoot, article) {
	const paths = getMediumArticlePaths(repoRoot, article);
	const assets = [];
	for (const asset of article.assets) {
		const rawPath = path.join(paths.rawAssetRoot, asset.rawFile);
		const buffer = await readRawFileInside(
			repoRoot,
			rawPath,
			`Original image ${asset.id} for ${article.slug}`,
		);
		const inspection = inspectImage(buffer, rawPath);
		if (
			sha256(buffer) !== asset.sha256 ||
			buffer.byteLength !== asset.byteSize ||
			inspection.mimeType !== asset.mimeType ||
			inspection.width !== asset.width ||
			inspection.height !== asset.height
		) {
			throw new MediumContractError(
				`Original image ${asset.id} for ${article.slug} differs from its reviewed metadata`,
			);
		}
		assets.push({
			...asset,
			buffer,
			outputPath: path.join(paths.postDirectory, asset.outputFile),
		});
	}
	return assets;
}

async function buildArticle(repoRoot, article, rawExport, capturedAt) {
	const sourceBuffer = rawExport.entries.get(article.sourcePath);
	if (!sourceBuffer) {
		throw new MediumContractError(
			`Reviewed export source is missing for ${article.slug}: ${article.sourcePath}`,
		);
	}
	if (sha256(sourceBuffer) !== article.sourceSha256) {
		throw new MediumContractError(
			`Exported HTML hash differs for ${article.slug}`,
		);
	}
	const html = decodeUtf8(sourceBuffer, article.sourcePath);
	const candidate = extractCandidateMetadata(html, article.sourcePath);
	if (candidate.title !== article.title) {
		throw new MediumContractError(
			`Exported candidate title differs for ${article.slug}`,
		);
	}
	if (
		candidate.descriptionCandidate !== null &&
		candidate.descriptionCandidate !== article.description
	) {
		throw new MediumContractError(
			`Exported description differs for ${article.slug}`,
		);
	}
	if (
		candidate.canonicalUrlCandidate !== null &&
		new URL(candidate.canonicalUrlCandidate).toString() !== article.canonicalUrl
	) {
		throw new MediumContractError(
			`Exported canonical URL differs for ${article.slug}`,
		);
	}
	if (
		candidate.publishedAtCandidate !== null &&
		new Date(candidate.publishedAtCandidate).valueOf() !==
			new Date(article.publishedAt).valueOf()
	) {
		throw new MediumContractError(
			`Exported publication date differs for ${article.slug}`,
		);
	}
	const extracted = extractMediumStoryHtml(html, article);
	const bodyDocument = removeAndValidateHero(extracted, article);
	const assets = await loadAssets(repoRoot, article);
	const hero = article.assets.find((asset) => asset.role === "hero");
	const bodyAssets = article.assets.filter((asset) => asset.role === "body");
	const bodyHtml = renderMediumBodyHtml(bodyDocument, bodyAssets, article.slug);
	const snapshot = {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		slug: article.slug,
		title: article.title,
		subtitle: article.subtitle,
		summary: article.summary,
		description: article.description,
		author: AUTHOR_NAME,
		published: article.publishedAt,
		category: article.category,
		tags: article.tags,
		imageAlt: hero.alt,
		imageCaption: hero.caption,
		provenance: {
			authority: "Medium account export",
			captureFormat: "account-export-html",
			capturedAt,
			sourcePath: article.sourcePath,
			sourceSha256: article.sourceSha256,
			canonicalUrl: article.canonicalUrl,
		},
		hero: {
			id: hero.id,
			outputFile: hero.outputFile,
			sha256: hero.sha256,
			mimeType: hero.mimeType,
			width: hero.width,
			height: hero.height,
			byteSize: hero.byteSize,
		},
		assets: article.assets.map((asset) => ({ ...asset })),
		bodyDocument,
		bodyHtml,
		bodyTextSha256: bodyTextSha256(bodyDocument),
		bodyBlockCount: bodyDocument.blocks.length,
		license: { name: ALL_RIGHTS_RESERVED },
	};
	validateMediumSnapshot(snapshot, article);
	const snapshotBuffer = Buffer.from(serializeJson(snapshot), "utf8");
	const markdownBuffer = Buffer.from(
		renderMediumIndexMarkdown(snapshot),
		"utf8",
	);
	return {
		article,
		paths: getMediumArticlePaths(repoRoot, article),
		sourceBuffer,
		assets,
		snapshot,
		snapshotBuffer,
		markdownBuffer,
	};
}

function activeManifestBase(inventoryBuffer) {
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		state: "active",
		authority: {
			platform: AUTHORITY_PLATFORM,
			captureFormat: CAPTURE_FORMAT,
		},
		author: { name: AUTHOR_NAME, profileUrl: AUTHOR_PROFILE_URL },
		inventoryPath: "provenance/medium/inventory.json",
		inventorySha256: sha256(inventoryBuffer),
	};
}

function makeManifestEntry(repoRoot, built, rawExport, capturedAt) {
	return {
		slug: built.article.slug,
		capturedAt,
		canonicalUrl: built.article.canonicalUrl,
		paths: {
			snapshot: toRepositoryPath(repoRoot, built.paths.snapshotPath),
			markdown: toRepositoryPath(repoRoot, built.paths.markdownPath),
		},
		hashes: {
			rawExport: sha256(rawExport.buffer),
			rawSource: sha256(built.sourceBuffer),
			snapshot: sha256(built.snapshotBuffer),
			markdown: sha256(built.markdownBuffer),
			bodyText: built.snapshot.bodyTextSha256,
		},
		content: {
			title: built.article.title,
			subtitle: built.article.subtitle,
			bodyBlockCount: built.snapshot.bodyBlockCount,
		},
		assets: built.assets.map((asset) => ({
			id: asset.id,
			role: asset.role,
			path: toRepositoryPath(repoRoot, asset.outputPath),
			sha256: asset.sha256,
			mimeType: asset.mimeType,
			width: asset.width,
			height: asset.height,
			byteSize: asset.byteSize,
		})),
	};
}

async function classifyTarget(filePath, desired) {
	try {
		const current = await readFile(filePath);
		return current.equals(desired) ? "unchanged" : "replace";
	} catch (error) {
		if (error?.code === "ENOENT") return "create";
		throw error;
	}
}

async function assertCurrentMatchesEntry(repoRoot, entry) {
	const expected = [
		[entry.paths.snapshot, entry.hashes.snapshot, "snapshot"],
		[entry.paths.markdown, entry.hashes.markdown, "markdown"],
		...entry.assets.map((asset) => [
			asset.path,
			asset.sha256,
			`asset ${asset.id}`,
		]),
	];
	for (const [repositoryPath, digest, label] of expected) {
		const buffer = await readRequired(
			path.join(repoRoot, ...repositoryPath.split("/")),
			`Existing ${label}`,
		);
		if (sha256(buffer) !== digest) {
			throw new MediumContractError(
				`Refusing to update ${entry.slug}: existing ${label} differs from its manifest hash`,
			);
		}
	}
}

export async function importMediumArticles({
	repoRoot,
	slugs,
	all = false,
	write = false,
	update = false,
} = {}) {
	if (update && !write) {
		throw new MediumContractError("--update requires --write");
	}
	const inventory = await loadInventory(repoRoot);
	if (inventory.state !== "reviewed") {
		throw new MediumContractError(
			"No reviewed Medium inventory exists; create and review one from the official export first",
		);
	}
	const selected = all
		? inventory.articles.map((article) => article.slug)
		: slugs;
	if (!Array.isArray(selected) || selected.length === 0) {
		throw new MediumContractError("Select at least one --slug or use --all");
	}
	const uniqueSlugs = [...new Set(selected.map((slug) => assertSlug(slug)))];
	if (uniqueSlugs.length !== selected.length) {
		throw new MediumContractError("A slug was selected more than once");
	}
	const rawExport = await loadRawExport(repoRoot, inventory);
	const manifest = await loadManifest(repoRoot);
	const inventoryChanged =
		manifest.state === "active" &&
		manifest.inventorySha256 !== sha256(inventory.buffer);
	if (inventoryChanged && (!write || !update || !all)) {
		throw new MediumContractError(
			"The reviewed inventory changed; rebuild every article with --all --write --update after reviewing the differences",
		);
	}
	const existingEntries = new Map(
		manifest.articles.map((entry) => [entry.slug, entry]),
	);
	if (
		inventoryChanged &&
		manifest.articles.some((entry) => !inventory.bySlug.has(entry.slug))
	) {
		throw new MediumContractError(
			"The reviewed inventory removes an imported article; retire it through a separate reviewed change",
		);
	}
	const plans = [];
	for (const slug of uniqueSlugs) {
		const article = inventory.bySlug.get(slug);
		if (!article) {
			throw new MediumContractError(
				`Slug ${slug} is not in the reviewed Medium inventory`,
			);
		}
		const built = await buildArticle(
			repoRoot,
			article,
			rawExport,
			inventory.export.capturedAt,
		);
		const entry = makeManifestEntry(
			repoRoot,
			built,
			rawExport,
			inventory.export.capturedAt,
		);
		const actions = {
			snapshot: await classifyTarget(
				built.paths.snapshotPath,
				built.snapshotBuffer,
			),
			markdown: await classifyTarget(
				built.paths.markdownPath,
				built.markdownBuffer,
			),
			assets: {},
		};
		for (const asset of built.assets) {
			actions.assets[asset.id] = await classifyTarget(
				asset.outputPath,
				asset.buffer,
			);
		}
		const oldEntry = existingEntries.get(slug);
		if (
			!oldEntry &&
			[
				actions.snapshot,
				actions.markdown,
				...Object.values(actions.assets),
			].some((action) => action !== "create")
		) {
			throw new MediumContractError(
				`Refusing to adopt unmanaged existing output for ${slug}`,
			);
		}
		const entryChanged =
			oldEntry !== undefined &&
			serializeJson(oldEntry) !== serializeJson(entry);
		if (
			oldEntry &&
			(entryChanged ||
				[
					actions.snapshot,
					actions.markdown,
					...Object.values(actions.assets),
				].some((action) => action !== "unchanged"))
		) {
			if (write && !update) {
				throw new MediumContractError(
					`Recorded source or output differs for ${slug}; review it before --write --update`,
				);
			}
			if (update) await assertCurrentMatchesEntry(repoRoot, oldEntry);
		}
		plans.push({ slug, built, entry, actions });
	}
	const nextEntries = inventoryChanged ? new Map() : new Map(existingEntries);
	for (const plan of plans) nextEntries.set(plan.slug, plan.entry);
	const nextManifest = {
		...activeManifestBase(inventory.buffer),
		articles: [...nextEntries.values()].sort((left, right) =>
			left.slug.localeCompare(right.slug),
		),
	};
	validateMediumManifest(nextManifest);
	const manifestBuffer = Buffer.from(serializeJson(nextManifest), "utf8");
	const manifestAction = await classifyTarget(
		getMediumPaths(repoRoot).manifestPath,
		manifestBuffer,
	);
	if (write) {
		const operations = [];
		for (const plan of plans) {
			if (plan.actions.snapshot !== "unchanged") {
				operations.push({
					path: plan.built.paths.snapshotPath,
					contents: plan.built.snapshotBuffer,
				});
			}
			if (plan.actions.markdown !== "unchanged") {
				operations.push({
					path: plan.built.paths.markdownPath,
					contents: plan.built.markdownBuffer,
				});
			}
			for (const asset of plan.built.assets) {
				if (plan.actions.assets[asset.id] !== "unchanged") {
					operations.push({ path: asset.outputPath, contents: asset.buffer });
				}
			}
		}
		if (manifestAction !== "unchanged") {
			operations.push({
				path: getMediumPaths(repoRoot).manifestPath,
				contents: manifestBuffer,
			});
		}
		await writeTransaction(operations);
	}
	return {
		mode: write ? "write" : "dry-run",
		articles: plans.map(({ slug, actions }) => ({ slug, actions })),
		manifestAction,
	};
}

function expectedPaths(repoRoot, article) {
	const paths = getMediumArticlePaths(repoRoot, article);
	return {
		snapshot: toRepositoryPath(repoRoot, paths.snapshotPath),
		markdown: toRepositoryPath(repoRoot, paths.markdownPath),
		assets: new Map(
			article.assets.map((asset) => [
				asset.id,
				toRepositoryPath(
					repoRoot,
					path.join(paths.postDirectory, asset.outputFile),
				),
			]),
		),
	};
}

export async function verifyMediumArticles({
	repoRoot,
	slugs,
	withRaw = false,
	requireComplete = false,
} = {}) {
	assertRawEvidenceUntracked(repoRoot);
	const inventory = await loadInventory(repoRoot);
	const manifest = await loadManifest(repoRoot);
	if (inventory.state === "awaiting-export") {
		if (manifest.state !== "awaiting-export") {
			throw new MediumContractError(
				"Awaiting-export inventory and manifest states disagree",
			);
		}
		if (requireComplete) {
			throw new MediumContractError(
				"Medium import is incomplete: no reviewed official export inventory exists",
			);
		}
		return {
			articles: [],
			complete: false,
			importedCount: 0,
			expectedCount: 0,
		};
	}
	if (manifest.state !== "active") {
		throw new MediumContractError(
			"Reviewed Medium inventory requires an active manifest",
		);
	}
	if (manifest.inventorySha256 !== sha256(inventory.buffer)) {
		throw new MediumContractError(
			"Medium manifest inventory hash does not match the reviewed inventory",
		);
	}
	const selected =
		Array.isArray(slugs) && slugs.length > 0
			? [...new Set(slugs.map((slug) => assertSlug(slug)))]
			: manifest.articles.map((entry) => entry.slug).sort();
	if (selected.length === 0) {
		throw new MediumContractError(
			"Active Medium manifest contains no articles",
		);
	}
	const rawExport = withRaw ? await loadRawExport(repoRoot, inventory) : null;
	const results = [];
	for (const slug of selected) {
		const article = inventory.bySlug.get(slug);
		const entry = manifest.bySlug.get(slug);
		if (!article || !entry) {
			throw new MediumContractError(
				`Medium manifest has no imported article ${slug}`,
			);
		}
		const paths = expectedPaths(repoRoot, article);
		if (
			entry.paths.snapshot !== paths.snapshot ||
			entry.paths.markdown !== paths.markdown ||
			entry.assets.length !== article.assets.length ||
			entry.assets.some(
				(asset) =>
					!article.assets.some((candidate) => candidate.id === asset.id),
			)
		) {
			throw new MediumContractError(`Medium manifest paths differ for ${slug}`);
		}
		for (const asset of entry.assets) {
			const inventoryAsset = article.assets.find(
				(candidate) => candidate.id === asset.id,
			);
			if (
				!inventoryAsset ||
				asset.path !== paths.assets.get(asset.id) ||
				asset.role !== inventoryAsset.role ||
				asset.sha256 !== inventoryAsset.sha256 ||
				asset.mimeType !== inventoryAsset.mimeType ||
				asset.width !== inventoryAsset.width ||
				asset.height !== inventoryAsset.height ||
				asset.byteSize !== inventoryAsset.byteSize
			) {
				throw new MediumContractError(
					`Medium manifest asset path differs for ${slug}`,
				);
			}
		}
		const snapshotBuffer = await readRequired(
			path.join(repoRoot, ...entry.paths.snapshot.split("/")),
			`Snapshot for ${slug}`,
		);
		const markdownBuffer = await readRequired(
			path.join(repoRoot, ...entry.paths.markdown.split("/")),
			`Markdown for ${slug}`,
		);
		const snapshotValue = parseJson(snapshotBuffer, `Snapshot for ${slug}`);
		const snapshot = validateMediumSnapshot(snapshotValue, article);
		if (
			sha256(snapshotBuffer) !== entry.hashes.snapshot ||
			sha256(markdownBuffer) !== entry.hashes.markdown ||
			entry.hashes.rawSource !== article.sourceSha256 ||
			entry.hashes.rawExport !== inventory.export.sha256 ||
			entry.hashes.bodyText !== snapshot.bodyTextSha256 ||
			!markdownBuffer.equals(
				Buffer.from(renderMediumIndexMarkdown(snapshot), "utf8"),
			)
		) {
			throw new MediumContractError(
				`Medium generated output differs for ${slug}`,
			);
		}
		for (const manifestAsset of entry.assets) {
			const inventoryAsset = article.assets.find(
				(asset) => asset.id === manifestAsset.id,
			);
			const buffer = await readRequired(
				path.join(repoRoot, ...manifestAsset.path.split("/")),
				`Asset ${manifestAsset.id} for ${slug}`,
			);
			const inspection = inspectImage(buffer, manifestAsset.path);
			if (
				sha256(buffer) !== manifestAsset.sha256 ||
				manifestAsset.sha256 !== inventoryAsset.sha256 ||
				buffer.byteLength !== manifestAsset.byteSize ||
				inspection.mimeType !== manifestAsset.mimeType ||
				inspection.width !== manifestAsset.width ||
				inspection.height !== manifestAsset.height
			) {
				throw new MediumContractError(
					`Asset ${manifestAsset.id} differs for ${slug}`,
				);
			}
		}
		if (rawExport) {
			const rebuilt = await buildArticle(
				repoRoot,
				article,
				rawExport,
				entry.capturedAt,
			);
			if (
				!rebuilt.snapshotBuffer.equals(snapshotBuffer) ||
				!rebuilt.markdownBuffer.equals(markdownBuffer)
			) {
				throw new MediumContractError(`Raw extraction differs for ${slug}`);
			}
		}
		results.push({ slug, status: "verified" });
	}
	const complete =
		manifest.articles.length === inventory.expectedCount &&
		inventory.articles.every((article) => manifest.bySlug.has(article.slug));
	if (requireComplete && !complete) {
		throw new MediumContractError(
			`Medium import is incomplete: ${manifest.articles.length}/${inventory.expectedCount} articles`,
		);
	}
	return {
		articles: results,
		complete,
		importedCount: manifest.articles.length,
		expectedCount: inventory.expectedCount,
	};
}

function validatePublicationCatalog(value) {
	const catalog = assertPlainObject(value, "publication catalog");
	assertOnlyKeys(
		catalog,
		new Set(["schemaVersion", "entries"]),
		"publication catalog",
	);
	if (catalog.schemaVersion !== 1)
		throw new MediumContractError(
			"publication catalog schemaVersion must equal 1",
		);
	if (!Array.isArray(catalog.entries))
		throw new MediumContractError(
			"publication catalog entries must be an array",
		);
	const entries = catalog.entries.map((value, index) => {
		const label = `publication catalog entries[${index}]`;
		const entry = assertPlainObject(value, label);
		assertOnlyKeys(
			entry,
			new Set(["slug", "source", "markdown", "section"]),
			label,
		);
		const slug = assertSlug(entry.slug, `${label}.slug`);
		if (
			entry.source !== "tai-song" &&
			entry.source !== "medium" &&
			entry.source !== "first-party"
		)
			throw new MediumContractError(`${label}.source is unsupported`);
		if (
			entry.section !== "fiction" &&
			entry.section !== "poetry-reflection" &&
			entry.section !== "nonfiction"
		) {
			throw new MediumContractError(`${label}.section is unsupported`);
		}
		if (entry.source === "medium" && entry.section !== "nonfiction")
			throw new MediumContractError(
				`${label} must classify Medium writing as nonfiction`,
			);
		const markdown = assertSafeRepositoryPath(
			entry.markdown,
			`${label}.markdown`,
		);
		if (markdown !== `src/content/posts/${slug}/index.md`)
			throw new MediumContractError(
				`${label}.markdown does not match its slug`,
			);
		return { slug, source: entry.source, markdown, section: entry.section };
	});
	for (const field of ["slug", "markdown"]) {
		const values = entries.map((entry) => entry[field]);
		if (new Set(values).size !== values.length)
			throw new MediumContractError(`publication catalog repeats ${field}`);
	}
	return entries;
}

function validateFirstPartyManifest(value) {
	const manifest = assertPlainObject(value, "first-party manifest");
	assertOnlyKeys(
		manifest,
		new Set(["schemaVersion", "state", "articles"]),
		"first-party manifest",
	);
	if (manifest.schemaVersion !== 1 || manifest.state !== "active")
		throw new MediumContractError(
			"first-party manifest must be active schema 1",
		);
	if (!Array.isArray(manifest.articles))
		throw new MediumContractError(
			"first-party manifest articles must be an array",
		);
	const articles = manifest.articles.map((value, index) => {
		const label = `first-party manifest articles[${index}]`;
		const article = assertPlainObject(value, label);
		assertOnlyKeys(
			article,
			new Set(["slug", "markdown", "hashes", "assets"]),
			label,
		);
		const slug = assertSlug(article.slug, `${label}.slug`);
		const markdown = assertSafeRepositoryPath(
			article.markdown,
			`${label}.markdown`,
		);
		if (markdown !== `src/content/posts/${slug}/index.md`)
			throw new MediumContractError(
				`${label}.markdown does not match its slug`,
			);
		const hashes = assertPlainObject(article.hashes, `${label}.hashes`);
		assertOnlyKeys(hashes, new Set(["source", "output"]), `${label}.hashes`);
		if (!Array.isArray(article.assets) || article.assets.length === 0)
			throw new MediumContractError(`${label}.assets must not be empty`);
		const assets = article.assets.map((value, assetIndex) => {
			const assetLabel = `${label}.assets[${assetIndex}]`;
			const asset = assertPlainObject(value, assetLabel);
			assertOnlyKeys(
				asset,
				new Set([
					"role",
					"path",
					"sha256",
					"mimeType",
					"width",
					"height",
					"byteSize",
				]),
				assetLabel,
			);
			if (asset.role !== "hero" && asset.role !== "body")
				throw new MediumContractError(
					`${assetLabel}.role must be hero or body`,
				);
			if (
				asset.mimeType !== "image/png" &&
				asset.mimeType !== "image/jpeg" &&
				asset.mimeType !== "image/webp"
			)
				throw new MediumContractError(`${assetLabel}.mimeType is unsupported`);
			return {
				role: asset.role,
				path: assertSafeRepositoryPath(asset.path, `${assetLabel}.path`),
				sha256: assertSha256(asset.sha256, `${assetLabel}.sha256`),
				mimeType: assertNonEmptyString(
					asset.mimeType,
					`${assetLabel}.mimeType`,
				),
				width: assertInteger(asset.width, `${assetLabel}.width`, {
					positive: true,
				}),
				height: assertInteger(asset.height, `${assetLabel}.height`, {
					positive: true,
				}),
				byteSize: assertInteger(asset.byteSize, `${assetLabel}.byteSize`, {
					positive: true,
				}),
			};
		});
		if (assets.filter((asset) => asset.role === "hero").length !== 1)
			throw new MediumContractError(
				`${label}.assets must contain exactly one hero`,
			);
		const assetPaths = assets.map((asset) => asset.path);
		if (new Set(assetPaths).size !== assetPaths.length)
			throw new MediumContractError(`${label}.assets repeat a path`);
		return {
			slug,
			markdown,
			hashes: {
				source: assertSha256(hashes.source, `${label}.hashes.source`),
				output: assertSha256(hashes.output, `${label}.hashes.output`),
			},
			assets,
		};
	});
	for (const field of ["slug", "markdown"]) {
		const values = articles.map((article) => article[field]);
		if (new Set(values).size !== values.length)
			throw new MediumContractError(`first-party manifest repeats ${field}`);
	}
	return articles;
}

export function verifyFirstPartyMarkdown(article, markdown) {
	const digest = sha256(markdown);
	if (digest !== article.hashes.output)
		throw new MediumContractError(
			`First-party Markdown hash differs for ${article.slug}`,
		);
	if (digest !== article.hashes.source)
		throw new MediumContractError(
			`First-party source hash differs for ${article.slug}`,
		);
	const source = markdown.toString("utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
	if (!frontmatter)
		throw new MediumContractError(
			`Catalog-ready first-party writing lacks frontmatter for ${article.slug}`,
		);
	const draftValues = frontmatter
		? [...frontmatter[1].matchAll(/^draft:\s*(true|false)\s*$/gmu)]
		: [];
	if (draftValues.length !== 1 || draftValues[0][1] !== "false")
		throw new MediumContractError(
			`Catalog-ready first-party writing must declare draft: false for ${article.slug}`,
		);
	const hero = article.assets?.filter((asset) => asset.role === "hero") ?? [];
	if (hero.length !== 1)
		throw new MediumContractError(
			`Catalog-ready first-party writing must have one manifest hero for ${article.slug}`,
		);
	const imageValues = [
		...frontmatter[1].matchAll(/^image:\s*(.+?)\s*$/gmu),
	].map((match) => {
		try {
			return JSON.parse(match[1]);
		} catch {
			throw new MediumContractError(
				`Catalog-ready first-party writing image must be a JSON string for ${article.slug}`,
			);
		}
	});
	const expectedImage = `./${path.basename(hero[0].path)}`;
	if (
		imageValues.length !== 1 ||
		typeof imageValues[0] !== "string" ||
		imageValues[0] !== expectedImage
	) {
		throw new MediumContractError(
			`Catalog-ready first-party writing must display its approved hero ${expectedImage} for ${article.slug}`,
		);
	}
	return digest;
}

export async function verifyAggregateContent({
	repoRoot,
	requireComplete = false,
} = {}) {
	const { verifyArticles } = await import("../../archive/lib/pipeline.js");
	const archive = await verifyArticles({ repoRoot, requireComplete: true });
	const medium = await verifyMediumArticles({
		repoRoot,
		requireComplete: false,
	});
	const archiveManifest = JSON.parse(
		await readFile(
			path.join(repoRoot, "provenance", "tai-song", "manifest.json"),
			"utf8",
		),
	);
	const mediumManifest = await loadManifest(repoRoot);
	const firstPartyManifest = validateFirstPartyManifest(
		parseJson(
			await readRequired(
				path.join(repoRoot, "provenance", "first-party", "manifest.json"),
				"First-party manifest",
			),
			"First-party manifest",
		),
	);
	for (const article of firstPartyManifest) {
		const markdown = await readRequired(
			path.join(repoRoot, ...article.markdown.split("/")),
			`First-party Markdown for ${article.slug}`,
		);
		verifyFirstPartyMarkdown(article, markdown);
		for (const asset of article.assets) {
			const bytes = await readRequired(
				path.join(repoRoot, ...asset.path.split("/")),
				`First-party asset for ${article.slug}`,
			);
			if (sha256(bytes) !== asset.sha256)
				throw new MediumContractError(
					`First-party asset hash differs for ${article.slug}`,
				);
			const inspection = inspectImage(bytes, asset.path);
			if (
				bytes.byteLength !== asset.byteSize ||
				inspection.mimeType !== asset.mimeType ||
				inspection.width !== asset.width ||
				inspection.height !== asset.height
			) {
				throw new MediumContractError(
					`First-party asset metadata differs for ${article.slug}`,
				);
			}
		}
	}
	const catalogBuffer = await readRequired(
		path.join(repoRoot, "provenance", "publication-catalog.json"),
		"Publication catalog",
	);
	const catalog = validatePublicationCatalog(
		parseJson(catalogBuffer, "Publication catalog"),
	);
	const contentSignoffs = validateContentSignoffsV2(
		parseJson(
			await readRequired(
				path.join(
					repoRoot,
					"provenance",
					"reviews",
					"content-signoffs-v2.json",
				),
				"Content signoffs v2",
			),
			"Content signoffs v2",
		),
	);
	validatePresentationSignoffsV2(
		parseJson(
			await readRequired(
				path.join(
					repoRoot,
					"provenance",
					"reviews",
					"presentation-signoffs-v2.json",
				),
				"Presentation signoffs v2",
			),
			"Presentation signoffs v2",
		),
	);
	const writingSignoffs = new Map(
		contentSignoffs
			.filter((entry) => entry.kind === "writing")
			.map((entry) => [entry.slug, entry]),
	);
	const claimReviews = new Map(
		validateClaimReviews(
			parseJson(
				await readRequired(
					path.join(repoRoot, "provenance", "medium", "claim-reviews.json"),
					"Medium claim reviews",
				),
				"Medium claim reviews",
			),
		).map((review) => [review.slug, review]),
	);
	const archiveBySlug = new Map(
		archiveManifest.articles.map((article) => [article.slug, article]),
	);
	const mediumBySlug = new Map(
		mediumManifest.articles.map((article) => [article.slug, article]),
	);
	const firstPartyBySlug = new Map(
		firstPartyManifest.map((article) => [article.slug, article]),
	);
	for (const [label, values] of [
		[
			"snapshot path",
			[
				...archiveManifest.articles.map((article) => article.paths.snapshot),
				...mediumManifest.articles.map((article) => article.paths.snapshot),
			],
		],
		[
			"source URL",
			[
				...archiveManifest.articles.map((article) => article.publication.url),
				...mediumManifest.articles.map((article) => article.canonicalUrl),
			],
		],
		[
			"asset path",
			[
				...archiveManifest.articles.map((article) => article.paths.image),
				...mediumManifest.articles.flatMap((article) =>
					article.assets.map((asset) => asset.path),
				),
				...firstPartyManifest.flatMap((article) =>
					article.assets.map((asset) => asset.path),
				),
			],
		],
	]) {
		if (new Set(values).size !== values.length)
			throw new MediumContractError(`Aggregate manifests repeat a ${label}`);
	}
	for (const entry of catalog) {
		const sourceEntry =
			entry.source === "tai-song"
				? archiveBySlug.get(entry.slug)
				: entry.source === "medium"
					? mediumBySlug.get(entry.slug)
					: firstPartyBySlug.get(entry.slug);
		if (!sourceEntry)
			throw new MediumContractError(
				`Publication catalog has no verified ${entry.source} manifest entry for ${entry.slug}`,
			);
		const sourceMarkdown =
			entry.source === "first-party"
				? sourceEntry.markdown
				: sourceEntry.paths.markdown;
		if (sourceMarkdown !== entry.markdown)
			throw new MediumContractError(
				`Publication catalog Markdown path differs for ${entry.slug}`,
			);
		if (entry.source === "medium") {
			const signoff = writingSignoffs.get(entry.slug);
			const approvedAssets = [...sourceEntry.assets]
				.map((asset) => asset.sha256)
				.sort();
			const signedAssets = [...(signoff?.assetSha256 ?? [])].sort();
			if (
				!signoff ||
				claimReviews.get(entry.slug)?.sourceSha256 !==
					sourceEntry.hashes.rawSource ||
				claimReviews.get(entry.slug)?.outputSha256 !==
					sourceEntry.hashes.markdown ||
				signoff.sourceSha256 !== sourceEntry.hashes.rawSource ||
				signoff.outputSha256 !== sourceEntry.hashes.markdown ||
				approvedAssets.length !== signedAssets.length ||
				approvedAssets.some((digest, index) => digest !== signedAssets[index])
			) {
				throw new MediumContractError(
					`Publication catalog lacks current content and rights approval for ${entry.slug}`,
				);
			}
		}
		if (entry.source === "first-party") {
			const signoff = writingSignoffs.get(entry.slug);
			const approvedAssets = sourceEntry.assets
				.map((asset) => asset.sha256)
				.sort();
			const signedAssets = [...(signoff?.assetSha256 ?? [])].sort();
			if (
				!signoff ||
				signoff.sourceSha256 !== sourceEntry.hashes.source ||
				signoff.outputSha256 !== sourceEntry.hashes.output ||
				approvedAssets.length !== signedAssets.length ||
				approvedAssets.some((digest, index) => digest !== signedAssets[index])
			) {
				throw new MediumContractError(
					`Publication catalog lacks current content and rights approval for ${entry.slug}`,
				);
			}
		}
	}
	const catalogArchiveSlugs = new Set(
		catalog
			.filter((entry) => entry.source === "tai-song")
			.map((entry) => entry.slug),
	);
	if (
		catalogArchiveSlugs.size !== archiveManifest.articles.length ||
		archiveManifest.articles.some(
			(article) => !catalogArchiveSlugs.has(article.slug),
		)
	) {
		throw new MediumContractError(
			"Publication catalog must retain the complete sealed eleven-work archive",
		);
	}
	const catalogMediumSlugs = new Set(
		catalog
			.filter((entry) => entry.source === "medium")
			.map((entry) => entry.slug),
	);
	const catalogFirstPartySlugs = new Set(
		catalog
			.filter((entry) => entry.source === "first-party")
			.map((entry) => entry.slug),
	);
	if (
		requireComplete &&
		medium.expectedCount > 0 &&
		(!medium.complete ||
			mediumManifest.articles.some(
				(article) => !catalogMediumSlugs.has(article.slug),
			))
	) {
		throw new MediumContractError(
			"Aggregate catalog contains incomplete or unapproved Medium writing",
		);
	}
	if (
		requireComplete &&
		firstPartyManifest.some(
			(article) => !catalogFirstPartySlugs.has(article.slug),
		)
	) {
		throw new MediumContractError(
			"Aggregate catalog contains unsigned first-party writing",
		);
	}
	return {
		complete:
			archive.complete &&
			(medium.expectedCount === 0 ||
				(medium.complete &&
					catalogMediumSlugs.size === medium.expectedCount)) &&
			catalogFirstPartySlugs.size === firstPartyManifest.length,
		publishedCount: catalog.length,
		sources: {
			archive: {
				importedCount: archive.importedCount,
				complete: archive.complete,
			},
			medium: {
				importedCount: medium.importedCount,
				complete: medium.complete,
			},
			firstParty: {
				importedCount: firstPartyManifest.length,
				complete: catalogFirstPartySlugs.size === firstPartyManifest.length,
			},
		},
	};
}
