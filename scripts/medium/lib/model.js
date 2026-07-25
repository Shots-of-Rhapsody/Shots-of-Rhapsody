import path from "node:path";
import {
	ALL_RIGHTS_RESERVED,
	AUTHOR_NAME,
	AUTHOR_PROFILE_URL,
	AUTHORITY_PLATFORM,
	assertCanonicalUtc,
	assertHttpsUrl,
	assertInteger,
	assertNonEmptyString,
	assertNullableString,
	assertOnlyKeys,
	assertPlainObject,
	assertSafeRepositoryPath,
	assertSha256,
	assertSlug,
	assertString,
	CAPTURE_FORMAT,
	INVENTORY_SCHEMA_VERSION,
	MANIFEST_SCHEMA_VERSION,
	MediumContractError,
	SNAPSHOT_SCHEMA_VERSION,
	serializeJson,
} from "./contract.js";
import { validateMediumDocument } from "./html.js";
import { sha256 } from "./integrity.js";
import { bodyTextSha256, renderMediumBodyHtml } from "./render.js";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function validateAuthority(value, label) {
	const authority = assertPlainObject(value, label);
	assertOnlyKeys(authority, new Set(["platform", "captureFormat"]), label);
	if (
		authority.platform !== AUTHORITY_PLATFORM ||
		authority.captureFormat !== CAPTURE_FORMAT
	) {
		throw new MediumContractError(
			`${label} must identify the official Medium account export`,
		);
	}
	return { platform: AUTHORITY_PLATFORM, captureFormat: CAPTURE_FORMAT };
}

function validateAuthor(value, label) {
	const author = assertPlainObject(value, label);
	assertOnlyKeys(author, new Set(["name", "profileUrl"]), label);
	if (author.name !== AUTHOR_NAME || author.profileUrl !== AUTHOR_PROFILE_URL) {
		throw new MediumContractError(
			`${label} must identify the reviewed Shots of Rhapsody profile and Tai Song`,
		);
	}
	return { name: AUTHOR_NAME, profileUrl: AUTHOR_PROFILE_URL };
}

function validateExport(value, label) {
	const exportRecord = assertPlainObject(value, label);
	assertOnlyKeys(
		exportRecord,
		new Set(["fileName", "sha256", "capturedAt"]),
		label,
	);
	if (exportRecord.fileName !== "medium-export.zip") {
		throw new MediumContractError(
			`${label}.fileName must equal "medium-export.zip"`,
		);
	}
	return {
		fileName: exportRecord.fileName,
		sha256: assertSha256(exportRecord.sha256, `${label}.sha256`),
		capturedAt: assertCanonicalUtc(
			exportRecord.capturedAt,
			`${label}.capturedAt`,
		),
	};
}

function validateClassification(value, label) {
	const classification = assertPlainObject(value, label);
	assertOnlyKeys(
		classification,
		new Set(["visibility", "authorship", "format"]),
		label,
	);
	if (
		classification.visibility !== "public" ||
		classification.authorship !== "original" ||
		classification.format !== "standalone"
	) {
		throw new MediumContractError(
			`${label} must be public, original, and standalone; drafts, unlisted stories, reposts, and responses are excluded`,
		);
	}
	return {
		visibility: "public",
		authorship: "original",
		format: "standalone",
	};
}

const CANDIDATE_VISIBILITY = new Set([
	"public",
	"draft",
	"unlisted",
	"unknown",
]);
const CANDIDATE_AUTHORSHIP = new Set([
	"original",
	"repost",
	"response",
	"unknown",
]);
const CANDIDATE_FORMAT = new Set([
	"standalone",
	"repost",
	"response",
	"unknown",
]);

function validateCandidateClassification(value, label) {
	const classification = assertPlainObject(value, label);
	assertOnlyKeys(
		classification,
		new Set(["visibility", "authorship", "format"]),
		label,
	);
	if (!CANDIDATE_VISIBILITY.has(classification.visibility))
		throw new MediumContractError(`${label}.visibility is unsupported`);
	if (!CANDIDATE_AUTHORSHIP.has(classification.authorship))
		throw new MediumContractError(`${label}.authorship is unsupported`);
	if (!CANDIDATE_FORMAT.has(classification.format))
		throw new MediumContractError(`${label}.format is unsupported`);
	return {
		visibility: classification.visibility,
		authorship: classification.authorship,
		format: classification.format,
	};
}

function validateCandidate(value, label) {
	const candidate = assertPlainObject(value, label);
	assertOnlyKeys(
		candidate,
		new Set([
			"suggestedSlug",
			"title",
			"descriptionCandidate",
			"publishedAtCandidate",
			"canonicalUrlCandidate",
			"sourcePath",
			"sourceSha256",
			"include",
			"exclusionReason",
			"classification",
		]),
		label,
	);
	const sourcePath = assertSafeRepositoryPath(
		candidate.sourcePath,
		`${label}.sourcePath`,
	);
	if (!/(?:^|\/)posts\/[^/]+\.html$/u.test(sourcePath))
		throw new MediumContractError(
			`${label}.sourcePath must identify posts/*.html`,
		);
	if (typeof candidate.include !== "boolean")
		throw new MediumContractError(`${label}.include must be boolean`);
	const exclusionReason = assertString(
		candidate.exclusionReason,
		`${label}.exclusionReason`,
	);
	const classification = validateCandidateClassification(
		candidate.classification,
		`${label}.classification`,
	);
	if (Object.values(classification).includes("unknown"))
		throw new MediumContractError(
			`${label} has an unresolved reviewed classification`,
		);
	const eligible =
		classification.visibility === "public" &&
		classification.authorship === "original" &&
		classification.format === "standalone";
	if (candidate.include !== eligible)
		throw new MediumContractError(
			`${label}.include must exactly match public, original, standalone eligibility`,
		);
	if (candidate.include && exclusionReason !== "")
		throw new MediumContractError(`${label} inclusion cannot have a reason`);
	if (!candidate.include && exclusionReason.trim().length === 0)
		throw new MediumContractError(`${label} exclusion requires a reason`);
	return {
		suggestedSlug: assertSlug(
			candidate.suggestedSlug,
			`${label}.suggestedSlug`,
		),
		title: assertNonEmptyString(candidate.title, `${label}.title`),
		descriptionCandidate: assertNullableString(
			candidate.descriptionCandidate,
			`${label}.descriptionCandidate`,
		),
		publishedAtCandidate:
			candidate.publishedAtCandidate === null
				? null
				: assertCanonicalUtc(
						candidate.publishedAtCandidate,
						`${label}.publishedAtCandidate`,
					),
		canonicalUrlCandidate:
			candidate.canonicalUrlCandidate === null
				? null
				: assertHttpsUrl(
						candidate.canonicalUrlCandidate,
						`${label}.canonicalUrlCandidate`,
						{ hostname: "medium.com" },
					).toString(),
		sourcePath,
		sourceSha256: assertSha256(candidate.sourceSha256, `${label}.sourceSha256`),
		include: candidate.include,
		exclusionReason,
		classification,
	};
}

function candidateEvidence(candidate) {
	return {
		suggestedSlug: candidate.suggestedSlug,
		title: candidate.title,
		descriptionCandidate: candidate.descriptionCandidate,
		publishedAtCandidate: candidate.publishedAtCandidate,
		canonicalUrlCandidate: candidate.canonicalUrlCandidate,
		sourcePath: candidate.sourcePath,
		sourceSha256: candidate.sourceSha256,
	};
}

export function mediumCandidateSetSha256(candidates) {
	return sha256(
		Buffer.from(
			serializeJson(
				candidates.map((candidate) => candidateEvidence(candidate)),
			),
			"utf8",
		),
	);
}

function validateAsset(value, label) {
	const asset = assertPlainObject(value, label);
	assertOnlyKeys(
		asset,
		new Set([
			"id",
			"role",
			"sourceUrl",
			"rawFile",
			"outputFile",
			"sha256",
			"mimeType",
			"width",
			"height",
			"byteSize",
			"alt",
			"caption",
		]),
		label,
	);
	const id = assertSlug(asset.id, `${label}.id`);
	if (asset.role !== "hero" && asset.role !== "body") {
		throw new MediumContractError(`${label}.role must be hero or body`);
	}
	const sourceUrl = assertHttpsUrl(
		asset.sourceUrl,
		`${label}.sourceUrl`,
	).toString();
	for (const field of ["rawFile", "outputFile"]) {
		assertNonEmptyString(asset[field], `${label}.${field}`);
		if (
			path.basename(asset[field]) !== asset[field] ||
			!/^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:png|jpe?g|webp)$/u.test(asset[field]) ||
			!IMAGE_EXTENSIONS.has(path.extname(asset[field]))
		) {
			throw new MediumContractError(
				`${label}.${field} must be an ASCII lowercase image filename`,
			);
		}
	}
	if (!IMAGE_MIME_TYPES.has(asset.mimeType)) {
		throw new MediumContractError(`${label}.mimeType is unsupported`);
	}
	return {
		id,
		role: asset.role,
		sourceUrl,
		rawFile: asset.rawFile,
		outputFile: asset.outputFile,
		sha256: assertSha256(asset.sha256, `${label}.sha256`),
		mimeType: asset.mimeType,
		width: assertInteger(asset.width, `${label}.width`, { positive: true }),
		height: assertInteger(asset.height, `${label}.height`, { positive: true }),
		byteSize: assertInteger(asset.byteSize, `${label}.byteSize`, {
			positive: true,
		}),
		alt: assertNullableString(asset.alt, `${label}.alt`),
		caption: assertString(asset.caption, `${label}.caption`),
	};
}

function validateArticle(value, label) {
	const article = assertPlainObject(value, label);
	assertOnlyKeys(
		article,
		new Set([
			"slug",
			"title",
			"subtitle",
			"summary",
			"description",
			"publishedAt",
			"canonicalUrl",
			"sourcePath",
			"sourceSha256",
			"category",
			"tags",
			"classification",
			"assets",
		]),
		label,
	);
	const slug = assertSlug(article.slug, `${label}.slug`);
	const title = assertNonEmptyString(article.title, `${label}.title`);
	const subtitle = assertString(article.subtitle, `${label}.subtitle`);
	const summary = assertNonEmptyString(article.summary, `${label}.summary`);
	const description = assertNonEmptyString(
		article.description,
		`${label}.description`,
	);
	const publishedAt = assertCanonicalUtc(
		article.publishedAt,
		`${label}.publishedAt`,
	);
	const canonicalUrl = assertHttpsUrl(
		article.canonicalUrl,
		`${label}.canonicalUrl`,
		{ hostname: "medium.com" },
	).toString();
	const sourcePath = assertSafeRepositoryPath(
		article.sourcePath,
		`${label}.sourcePath`,
	);
	if (!/(?:^|\/)posts\/[^/]+\.html$/u.test(sourcePath)) {
		throw new MediumContractError(
			`${label}.sourcePath must identify one exported posts/*.html file`,
		);
	}
	if (!Array.isArray(article.tags)) {
		throw new MediumContractError(`${label}.tags must be an array`);
	}
	const tags = article.tags.map((tag, index) =>
		assertNonEmptyString(tag, `${label}.tags[${index}]`),
	);
	if (new Set(tags).size !== tags.length) {
		throw new MediumContractError(
			`${label}.tags must be unique in source order`,
		);
	}
	if (!Array.isArray(article.assets) || article.assets.length === 0) {
		throw new MediumContractError(`${label}.assets must contain a hero image`);
	}
	const assets = article.assets.map((asset, index) =>
		validateAsset(asset, `${label}.assets[${index}]`),
	);
	if (assets.filter((asset) => asset.role === "hero").length !== 1) {
		throw new MediumContractError(
			`${label}.assets must contain exactly one hero image`,
		);
	}
	for (const field of ["id", "sourceUrl", "rawFile", "outputFile"]) {
		const values = assets.map((asset) => asset[field]);
		if (new Set(values).size !== values.length) {
			throw new MediumContractError(`${label}.assets repeats ${field}`);
		}
	}
	return {
		slug,
		title,
		subtitle,
		summary,
		description,
		publishedAt,
		canonicalUrl,
		sourcePath,
		sourceSha256: assertSha256(article.sourceSha256, `${label}.sourceSha256`),
		category: assertNonEmptyString(article.category, `${label}.category`),
		tags,
		classification: validateClassification(
			article.classification,
			`${label}.classification`,
		),
		assets,
	};
}

export function validateMediumInventory(value) {
	const inventory = assertPlainObject(value, "inventory");
	assertOnlyKeys(
		inventory,
		new Set([
			"schemaVersion",
			"state",
			"authority",
			"author",
			"export",
			"candidateCount",
			"candidateSetSha256",
			"candidates",
			"expectedCount",
			"articles",
		]),
		"inventory",
	);
	if (inventory.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
		throw new MediumContractError(
			`inventory.schemaVersion must equal ${INVENTORY_SCHEMA_VERSION}`,
		);
	}
	const authority = validateAuthority(
		inventory.authority,
		"inventory.authority",
	);
	const author = validateAuthor(inventory.author, "inventory.author");
	if (inventory.state !== "awaiting-export" && inventory.state !== "reviewed") {
		throw new MediumContractError(
			"inventory.state must be awaiting-export or reviewed",
		);
	}
	if (!Array.isArray(inventory.articles)) {
		throw new MediumContractError("inventory.articles must be an array");
	}
	if (!Array.isArray(inventory.candidates)) {
		throw new MediumContractError("inventory.candidates must be an array");
	}
	const candidateCount = assertInteger(
		inventory.candidateCount,
		"inventory.candidateCount",
	);
	const expectedCount = assertInteger(
		inventory.expectedCount,
		"inventory.expectedCount",
	);
	if (inventory.state === "awaiting-export") {
		if (
			inventory.export !== null ||
			candidateCount !== 0 ||
			inventory.candidateSetSha256 !== null ||
			inventory.candidates.length !== 0 ||
			expectedCount !== 0 ||
			inventory.articles.length !== 0
		) {
			throw new MediumContractError(
				"An awaiting-export inventory must have null export data and no articles",
			);
		}
		return {
			schemaVersion: INVENTORY_SCHEMA_VERSION,
			state: "awaiting-export",
			authority,
			author,
			export: null,
			candidateCount: 0,
			candidateSetSha256: null,
			candidates: [],
			expectedCount: 0,
			articles: [],
			bySlug: new Map(),
		};
	}
	const exportRecord = validateExport(inventory.export, "inventory.export");
	const candidates = inventory.candidates.map((candidate, index) =>
		validateCandidate(candidate, `inventory.candidates[${index}]`),
	);
	if (candidates.length === 0 || candidates.length !== candidateCount)
		throw new MediumContractError(
			"A reviewed inventory must retain every exported story candidate",
		);
	const candidateSetSha256 = assertSha256(
		inventory.candidateSetSha256,
		"inventory.candidateSetSha256",
	);
	if (candidateSetSha256 !== mediumCandidateSetSha256(candidates))
		throw new MediumContractError(
			"inventory.candidateSetSha256 does not match the complete candidate ledger",
		);
	const articles = inventory.articles.map((article, index) =>
		validateArticle(article, `inventory.articles[${index}]`),
	);
	if (articles.length === 0 || articles.length !== expectedCount) {
		throw new MediumContractError(
			"A reviewed inventory must contain its positive expected article count",
		);
	}
	const includedCandidates = candidates.filter(
		(candidate) => candidate.include,
	);
	if (
		includedCandidates.length !== expectedCount ||
		includedCandidates.some(
			(candidate) =>
				!articles.some(
					(article) =>
						article.sourcePath === candidate.sourcePath &&
						article.sourceSha256 === candidate.sourceSha256,
				),
		) ||
		articles.some(
			(article) =>
				!includedCandidates.some(
					(candidate) =>
						candidate.sourcePath === article.sourcePath &&
						candidate.sourceSha256 === article.sourceSha256,
				),
		)
	) {
		throw new MediumContractError(
			"Reviewed articles must exactly match the included candidate dispositions",
		);
	}
	for (const field of ["sourcePath", "sourceSha256"]) {
		const values = candidates.map((candidate) => candidate[field]);
		if (new Set(values).size !== values.length)
			throw new MediumContractError(`inventory candidates repeat ${field}`);
	}
	const uniqueFields = [
		"slug",
		"title",
		"canonicalUrl",
		"sourcePath",
		"sourceSha256",
	];
	for (const field of uniqueFields) {
		const values = articles.map((article) => article[field]);
		if (new Set(values).size !== values.length) {
			throw new MediumContractError(`inventory repeats article ${field}`);
		}
	}
	return {
		schemaVersion: INVENTORY_SCHEMA_VERSION,
		state: "reviewed",
		authority,
		author,
		export: exportRecord,
		candidateCount,
		candidateSetSha256,
		candidates,
		expectedCount,
		articles,
		bySlug: new Map(articles.map((article) => [article.slug, article])),
	};
}

function validateManifestAsset(value, label) {
	const asset = assertPlainObject(value, label);
	assertOnlyKeys(
		asset,
		new Set([
			"id",
			"role",
			"path",
			"sha256",
			"mimeType",
			"width",
			"height",
			"byteSize",
		]),
		label,
	);
	if (asset.role !== "hero" && asset.role !== "body")
		throw new MediumContractError(`${label}.role must be hero or body`);
	if (!IMAGE_MIME_TYPES.has(asset.mimeType))
		throw new MediumContractError(`${label}.mimeType is unsupported`);
	const repositoryPath = assertSafeRepositoryPath(asset.path, `${label}.path`);
	const extension = path.extname(repositoryPath);
	if (
		!IMAGE_EXTENSIONS.has(extension) ||
		(asset.mimeType === "image/png" && extension !== ".png") ||
		(asset.mimeType === "image/webp" && extension !== ".webp") ||
		(asset.mimeType === "image/jpeg" &&
			extension !== ".jpg" &&
			extension !== ".jpeg")
	) {
		throw new MediumContractError(
			`${label}.path does not match its image MIME type`,
		);
	}
	return {
		id: assertSlug(asset.id, `${label}.id`),
		role: asset.role,
		path: repositoryPath,
		sha256: assertSha256(asset.sha256, `${label}.sha256`),
		mimeType: asset.mimeType,
		width: assertInteger(asset.width, `${label}.width`, { positive: true }),
		height: assertInteger(asset.height, `${label}.height`, { positive: true }),
		byteSize: assertInteger(asset.byteSize, `${label}.byteSize`, {
			positive: true,
		}),
	};
}

function validateManifestArticle(value, label) {
	const article = assertPlainObject(value, label);
	assertOnlyKeys(
		article,
		new Set([
			"slug",
			"capturedAt",
			"canonicalUrl",
			"paths",
			"hashes",
			"content",
			"assets",
		]),
		label,
	);
	const slug = assertSlug(article.slug, `${label}.slug`);
	const paths = assertPlainObject(article.paths, `${label}.paths`);
	assertOnlyKeys(paths, new Set(["snapshot", "markdown"]), `${label}.paths`);
	const hashes = assertPlainObject(article.hashes, `${label}.hashes`);
	assertOnlyKeys(
		hashes,
		new Set(["rawExport", "rawSource", "snapshot", "markdown", "bodyText"]),
		`${label}.hashes`,
	);
	const content = assertPlainObject(article.content, `${label}.content`);
	assertOnlyKeys(
		content,
		new Set(["title", "subtitle", "bodyBlockCount"]),
		`${label}.content`,
	);
	if (!Array.isArray(article.assets) || article.assets.length === 0) {
		throw new MediumContractError(`${label}.assets must not be empty`);
	}
	const assets = article.assets.map((asset, index) =>
		validateManifestAsset(asset, `${label}.assets[${index}]`),
	);
	if (assets.filter((asset) => asset.role === "hero").length !== 1)
		throw new MediumContractError(
			`${label}.assets must contain exactly one hero`,
		);
	for (const field of ["id", "path"]) {
		const values = assets.map((asset) => asset[field]);
		if (new Set(values).size !== values.length)
			throw new MediumContractError(`${label}.assets repeats ${field}`);
	}
	if (
		assets.some((asset) => !asset.path.startsWith(`src/content/posts/${slug}/`))
	) {
		throw new MediumContractError(
			`${label}.assets escape their article directory`,
		);
	}
	return {
		slug,
		capturedAt: assertCanonicalUtc(article.capturedAt, `${label}.capturedAt`),
		canonicalUrl: assertHttpsUrl(
			article.canonicalUrl,
			`${label}.canonicalUrl`,
			{ hostname: "medium.com" },
		).toString(),
		paths: {
			snapshot: assertSafeRepositoryPath(
				paths.snapshot,
				`${label}.paths.snapshot`,
			),
			markdown: assertSafeRepositoryPath(
				paths.markdown,
				`${label}.paths.markdown`,
			),
		},
		hashes: {
			rawExport: assertSha256(hashes.rawExport, `${label}.hashes.rawExport`),
			rawSource: assertSha256(hashes.rawSource, `${label}.hashes.rawSource`),
			snapshot: assertSha256(hashes.snapshot, `${label}.hashes.snapshot`),
			markdown: assertSha256(hashes.markdown, `${label}.hashes.markdown`),
			bodyText: assertSha256(hashes.bodyText, `${label}.hashes.bodyText`),
		},
		content: {
			title: assertNonEmptyString(content.title, `${label}.content.title`),
			subtitle: assertString(content.subtitle, `${label}.content.subtitle`),
			bodyBlockCount: assertInteger(
				content.bodyBlockCount,
				`${label}.content.bodyBlockCount`,
				{ positive: true },
			),
		},
		assets,
	};
}

export function validateMediumManifest(value) {
	const manifest = assertPlainObject(value, "manifest");
	assertOnlyKeys(
		manifest,
		new Set([
			"schemaVersion",
			"state",
			"authority",
			"author",
			"inventoryPath",
			"inventorySha256",
			"articles",
		]),
		"manifest",
	);
	if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
		throw new MediumContractError(
			`manifest.schemaVersion must equal ${MANIFEST_SCHEMA_VERSION}`,
		);
	}
	const authority = validateAuthority(manifest.authority, "manifest.authority");
	const author = validateAuthor(manifest.author, "manifest.author");
	if (manifest.inventoryPath !== "provenance/medium/inventory.json") {
		throw new MediumContractError(
			"manifest.inventoryPath must identify the Medium inventory",
		);
	}
	if (!Array.isArray(manifest.articles)) {
		throw new MediumContractError("manifest.articles must be an array");
	}
	if (manifest.state === "awaiting-export") {
		if (manifest.inventorySha256 !== null || manifest.articles.length !== 0) {
			throw new MediumContractError(
				"An awaiting-export manifest must have null inventory hash and no articles",
			);
		}
		return {
			schemaVersion: MANIFEST_SCHEMA_VERSION,
			state: "awaiting-export",
			authority,
			author,
			inventoryPath: manifest.inventoryPath,
			inventorySha256: null,
			articles: [],
			bySlug: new Map(),
		};
	}
	if (manifest.state !== "active") {
		throw new MediumContractError(
			"manifest.state must be awaiting-export or active",
		);
	}
	const articles = manifest.articles.map((article, index) =>
		validateManifestArticle(article, `manifest.articles[${index}]`),
	);
	const bySlug = new Map();
	for (const article of articles) {
		if (bySlug.has(article.slug)) {
			throw new MediumContractError(`manifest repeats slug ${article.slug}`);
		}
		bySlug.set(article.slug, article);
	}
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		state: "active",
		authority,
		author,
		inventoryPath: manifest.inventoryPath,
		inventorySha256: assertSha256(
			manifest.inventorySha256,
			"manifest.inventorySha256",
		),
		articles,
		bySlug,
	};
}

export function validateMediumSnapshot(value, inventoryArticle) {
	const snapshot = assertPlainObject(value, "snapshot");
	assertOnlyKeys(
		snapshot,
		new Set([
			"schemaVersion",
			"slug",
			"title",
			"subtitle",
			"summary",
			"description",
			"author",
			"published",
			"category",
			"tags",
			"imageAlt",
			"imageCaption",
			"provenance",
			"hero",
			"assets",
			"bodyDocument",
			"bodyHtml",
			"bodyTextSha256",
			"bodyBlockCount",
			"license",
		]),
		"snapshot",
	);
	if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
		throw new MediumContractError(
			`snapshot.schemaVersion must equal ${SNAPSHOT_SCHEMA_VERSION}`,
		);
	}
	for (const field of [
		"slug",
		"title",
		"subtitle",
		"summary",
		"description",
		"published",
		"category",
	]) {
		const inventoryField = field === "published" ? "publishedAt" : field;
		if (snapshot[field] !== inventoryArticle[inventoryField]) {
			throw new MediumContractError(`snapshot.${field} differs from inventory`);
		}
	}
	if (snapshot.author !== AUTHOR_NAME) {
		throw new MediumContractError(`snapshot.author must equal ${AUTHOR_NAME}`);
	}
	if (
		!Array.isArray(snapshot.tags) ||
		snapshot.tags.length !== inventoryArticle.tags.length ||
		snapshot.tags.some((tag, index) => tag !== inventoryArticle.tags[index])
	) {
		throw new MediumContractError("snapshot.tags differ from inventory");
	}
	const provenance = assertPlainObject(
		snapshot.provenance,
		"snapshot.provenance",
	);
	assertOnlyKeys(
		provenance,
		new Set([
			"authority",
			"captureFormat",
			"capturedAt",
			"sourcePath",
			"sourceSha256",
			"canonicalUrl",
		]),
		"snapshot.provenance",
	);
	if (
		provenance.authority !== "Medium account export" ||
		provenance.captureFormat !== "account-export-html" ||
		provenance.sourcePath !== inventoryArticle.sourcePath ||
		provenance.sourceSha256 !== inventoryArticle.sourceSha256 ||
		provenance.canonicalUrl !== inventoryArticle.canonicalUrl
	) {
		throw new MediumContractError("snapshot.provenance differs from inventory");
	}
	assertCanonicalUtc(provenance.capturedAt, "snapshot.provenance.capturedAt");
	const bodyDocument = validateMediumDocument(snapshot.bodyDocument);
	const nonHeroAssets = inventoryArticle.assets.filter(
		(asset) => asset.role !== "hero",
	);
	const expectedBodyHtml = renderMediumBodyHtml(
		bodyDocument,
		nonHeroAssets,
		inventoryArticle.slug,
	);
	const expectedBodySha = bodyTextSha256(bodyDocument);
	if (
		snapshot.bodyHtml !== expectedBodyHtml ||
		snapshot.bodyTextSha256 !== expectedBodySha ||
		snapshot.bodyBlockCount !== bodyDocument.blocks.length
	) {
		throw new MediumContractError(
			"snapshot body metadata is not deterministic",
		);
	}
	const hero = inventoryArticle.assets.find((asset) => asset.role === "hero");
	const snapshotHero = assertPlainObject(snapshot.hero, "snapshot.hero");
	const expectedHero = {
		id: hero.id,
		outputFile: hero.outputFile,
		sha256: hero.sha256,
		mimeType: hero.mimeType,
		width: hero.width,
		height: hero.height,
		byteSize: hero.byteSize,
	};
	if (
		JSON.stringify(snapshotHero) !== JSON.stringify(expectedHero) ||
		snapshot.imageAlt !== hero.alt ||
		snapshot.imageCaption !== hero.caption
	) {
		throw new MediumContractError("snapshot hero differs from inventory");
	}
	if (
		!Array.isArray(snapshot.assets) ||
		JSON.stringify(snapshot.assets) !== JSON.stringify(inventoryArticle.assets)
	) {
		throw new MediumContractError("snapshot assets differ from inventory");
	}
	const license = assertPlainObject(snapshot.license, "snapshot.license");
	if (license.name !== ALL_RIGHTS_RESERVED) {
		throw new MediumContractError(
			"snapshot license must be All Rights Reserved",
		);
	}
	return {
		...snapshot,
		bodyDocument,
	};
}
