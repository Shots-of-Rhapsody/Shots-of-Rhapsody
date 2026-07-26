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
	MEDIUM_HERO_CAPTURE_FILE,
	MEDIUM_HERO_SITE_READY_FILE,
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
			"exportSummaryCandidate",
			"displayTitleCandidate",
			"displaySubtitleCandidate",
			"seriesLineCandidate",
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
	const displayTitleCandidate = assertNullableString(
		candidate.displayTitleCandidate,
		`${label}.displayTitleCandidate`,
	);
	const displaySubtitleCandidate = assertNullableString(
		candidate.displaySubtitleCandidate,
		`${label}.displaySubtitleCandidate`,
	);
	const seriesLineCandidate = assertNullableString(
		candidate.seriesLineCandidate,
		`${label}.seriesLineCandidate`,
	);
	if (
		candidate.include &&
		(typeof displayTitleCandidate !== "string" ||
			displayTitleCandidate.length === 0 ||
			typeof displaySubtitleCandidate !== "string" ||
			displaySubtitleCandidate.length === 0 ||
			typeof seriesLineCandidate !== "string" ||
			!seriesLineCandidate.startsWith("A Ledger Series article "))
	) {
		throw new MediumContractError(
			`${label} inclusion requires the exact Medium title, subtitle, and Ledger Series presentation fields`,
		);
	}
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
		exportSummaryCandidate: assertNullableString(
			candidate.exportSummaryCandidate,
			`${label}.exportSummaryCandidate`,
		),
		displayTitleCandidate,
		displaySubtitleCandidate,
		seriesLineCandidate,
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
	// This legacy digest is an immutable acquisition identity bound into the
	// approved hero ledger. The sourceSha256 already commits every source-derived
	// presentation field; the reviewed inventory and raw-backed import re-extract
	// and compare those fields rather than rewriting the acquisition identity.
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

export const MEDIUM_PRESENTATION_SET_VERSION = 1;

function presentationEvidence(candidate) {
	return {
		sourcePath: candidate.sourcePath,
		exportSummaryCandidate: candidate.exportSummaryCandidate,
		displayTitleCandidate: candidate.displayTitleCandidate,
		displaySubtitleCandidate: candidate.displaySubtitleCandidate,
		seriesLineCandidate: candidate.seriesLineCandidate,
	};
}

export function mediumPresentationSetSha256(candidates) {
	if (!Array.isArray(candidates)) {
		throw new MediumContractError(
			"Medium presentation digest candidates must be an array",
		);
	}
	return sha256(
		Buffer.from(
			serializeJson({
				schemaVersion: MEDIUM_PRESENTATION_SET_VERSION,
				fields: [
					"exportSummaryCandidate",
					"displayTitleCandidate",
					"displaySubtitleCandidate",
					"seriesLineCandidate",
				],
				candidates: candidates.map((candidate) =>
					presentationEvidence(candidate),
				),
			}),
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
			"siteReadyFile",
			"outputFile",
			"sha256",
			"acquisitionManifestSha256",
			"captureSha256",
			"pixelSha256",
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
	const siteReadyFile =
		asset.siteReadyFile === undefined
			? undefined
			: assertNonEmptyString(asset.siteReadyFile, `${label}.siteReadyFile`);
	for (const field of ["rawFile", "outputFile", "siteReadyFile"]) {
		if (field === "siteReadyFile" && siteReadyFile === undefined) continue;
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
	const provenanceHashes = {
		acquisitionManifestSha256:
			asset.acquisitionManifestSha256 === undefined
				? undefined
				: assertSha256(
						asset.acquisitionManifestSha256,
						`${label}.acquisitionManifestSha256`,
					),
		captureSha256:
			asset.captureSha256 === undefined
				? undefined
				: assertSha256(asset.captureSha256, `${label}.captureSha256`),
		pixelSha256:
			asset.pixelSha256 === undefined
				? undefined
				: assertSha256(asset.pixelSha256, `${label}.pixelSha256`),
	};
	if (asset.role === "hero") {
		if (
			asset.rawFile !== MEDIUM_HERO_CAPTURE_FILE ||
			siteReadyFile !== MEDIUM_HERO_SITE_READY_FILE ||
			asset.mimeType !== "image/webp"
		) {
			throw new MediumContractError(
				`${label} hero must bind ${MEDIUM_HERO_CAPTURE_FILE} to the separately sanitized ${MEDIUM_HERO_SITE_READY_FILE}`,
			);
		}
		if (asset.rawFile === siteReadyFile) {
			throw new MediumContractError(
				`${label} hero raw capture and site-ready image must be separate files`,
			);
		}
		if (Object.values(provenanceHashes).some((value) => value === undefined)) {
			throw new MediumContractError(
				`${label} hero must bind acquisition, capture, sanitized, and pixel hashes`,
			);
		}
	} else if (siteReadyFile !== undefined) {
		throw new MediumContractError(
			`${label}.siteReadyFile is reserved for sanitized hero images`,
		);
	} else if (
		Object.values(provenanceHashes).some((value) => value !== undefined)
	) {
		throw new MediumContractError(
			`${label} Medium hero provenance hashes are reserved for hero images`,
		);
	}
	return {
		id,
		role: asset.role,
		sourceUrl,
		rawFile: asset.rawFile,
		...(siteReadyFile === undefined ? {} : { siteReadyFile }),
		outputFile: asset.outputFile,
		sha256: assertSha256(asset.sha256, `${label}.sha256`),
		...(asset.role === "hero" ? provenanceHashes : {}),
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
			"exportTitle",
			"exportSummary",
			"title",
			"subtitle",
			"seriesLine",
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
	const exportTitle = assertNonEmptyString(
		article.exportTitle,
		`${label}.exportTitle`,
	);
	const exportSummary = assertNullableString(
		article.exportSummary,
		`${label}.exportSummary`,
	);
	const title = assertNonEmptyString(article.title, `${label}.title`);
	const subtitle = assertNonEmptyString(article.subtitle, `${label}.subtitle`);
	const seriesLine = assertNonEmptyString(
		article.seriesLine,
		`${label}.seriesLine`,
	);
	if (!seriesLine.startsWith("A Ledger Series article ")) {
		throw new MediumContractError(
			`${label}.seriesLine must preserve the reviewed Ledger Series sentence`,
		);
	}
	const summary = assertNonEmptyString(article.summary, `${label}.summary`);
	const description = assertNonEmptyString(
		article.description,
		`${label}.description`,
	);
	if (summary !== description) {
		throw new MediumContractError(
			`${label} summary and description must use one reviewed card and metadata summary`,
		);
	}
	if (exportSummary !== null && summary !== exportSummary) {
		throw new MediumContractError(
			`${label} summary and description must preserve the exported summary when present`,
		);
	}
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
	for (const field of [
		"id",
		"sourceUrl",
		"rawFile",
		"siteReadyFile",
		"outputFile",
	]) {
		const values = assets
			.map((asset) => asset[field])
			.filter((value) => value !== undefined);
		if (new Set(values).size !== values.length) {
			throw new MediumContractError(`${label}.assets repeats ${field}`);
		}
	}
	return {
		slug,
		exportTitle,
		exportSummary,
		title,
		subtitle,
		seriesLine,
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
			"presentationSetVersion",
			"presentationSetSha256",
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
			(inventory.presentationSetVersion ?? null) !== null ||
			(inventory.presentationSetSha256 ?? null) !== null ||
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
			presentationSetVersion: null,
			presentationSetSha256: null,
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
	if (inventory.presentationSetVersion !== MEDIUM_PRESENTATION_SET_VERSION) {
		throw new MediumContractError(
			`inventory.presentationSetVersion must equal ${MEDIUM_PRESENTATION_SET_VERSION}`,
		);
	}
	const presentationSetSha256 = assertSha256(
		inventory.presentationSetSha256,
		"inventory.presentationSetSha256",
	);
	if (presentationSetSha256 !== mediumPresentationSetSha256(candidates)) {
		throw new MediumContractError(
			"inventory.presentationSetSha256 does not match all source-derived presentation fields",
		);
	}
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
	for (const article of articles) {
		const candidate = includedCandidates.find(
			(item) =>
				item.sourcePath === article.sourcePath &&
				item.sourceSha256 === article.sourceSha256,
		);
		if (
			!candidate ||
			candidate.title !== article.exportTitle ||
			candidate.exportSummaryCandidate !== article.exportSummary ||
			candidate.displayTitleCandidate !== article.title ||
			candidate.displaySubtitleCandidate !== article.subtitle ||
			candidate.seriesLineCandidate !== article.seriesLine
		) {
			throw new MediumContractError(
				`Reviewed article ${article.slug} differs from its extracted export and presentation fields`,
			);
		}
	}
	for (const field of ["sourcePath", "sourceSha256"]) {
		const values = candidates.map((candidate) => candidate[field]);
		if (new Set(values).size !== values.length)
			throw new MediumContractError(`inventory candidates repeat ${field}`);
	}
	const uniqueFields = [
		"slug",
		"exportTitle",
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
		presentationSetVersion: MEDIUM_PRESENTATION_SET_VERSION,
		presentationSetSha256,
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
			"acquisitionManifestSha256",
			"captureSha256",
			"pixelSha256",
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
	const provenanceHashes = {
		acquisitionManifestSha256:
			asset.acquisitionManifestSha256 === undefined
				? undefined
				: assertSha256(
						asset.acquisitionManifestSha256,
						`${label}.acquisitionManifestSha256`,
					),
		captureSha256:
			asset.captureSha256 === undefined
				? undefined
				: assertSha256(asset.captureSha256, `${label}.captureSha256`),
		pixelSha256:
			asset.pixelSha256 === undefined
				? undefined
				: assertSha256(asset.pixelSha256, `${label}.pixelSha256`),
	};
	if (
		asset.role === "hero" &&
		Object.values(provenanceHashes).some((value) => value === undefined)
	) {
		throw new MediumContractError(
			`${label} hero must carry acquisition, capture, and pixel hashes`,
		);
	}
	if (
		asset.role === "body" &&
		Object.values(provenanceHashes).some((value) => value !== undefined)
	) {
		throw new MediumContractError(
			`${label} body image must not carry Medium hero provenance hashes`,
		);
	}
	return {
		id: assertSlug(asset.id, `${label}.id`),
		role: asset.role,
		path: repositoryPath,
		sha256: assertSha256(asset.sha256, `${label}.sha256`),
		...(asset.role === "hero" ? provenanceHashes : {}),
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
		new Set(["title", "subtitle", "seriesLine", "bodyBlockCount"]),
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
			subtitle: assertNonEmptyString(
				content.subtitle,
				`${label}.content.subtitle`,
			),
			seriesLine: assertNonEmptyString(
				content.seriesLine,
				`${label}.content.seriesLine`,
			),
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
			"presentationSetVersion",
			"presentationSetSha256",
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
		if (
			manifest.inventorySha256 !== null ||
			(manifest.presentationSetVersion ?? null) !== null ||
			(manifest.presentationSetSha256 ?? null) !== null ||
			manifest.articles.length !== 0
		) {
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
			presentationSetVersion: null,
			presentationSetSha256: null,
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
	if (manifest.presentationSetVersion !== MEDIUM_PRESENTATION_SET_VERSION) {
		throw new MediumContractError(
			`manifest.presentationSetVersion must equal ${MEDIUM_PRESENTATION_SET_VERSION}`,
		);
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
		presentationSetVersion: MEDIUM_PRESENTATION_SET_VERSION,
		presentationSetSha256: assertSha256(
			manifest.presentationSetSha256,
			"manifest.presentationSetSha256",
		),
		articles,
		bySlug,
	};
}

export function validateMediumSnapshot(
	value,
	inventoryArticle,
	presentationBinding,
) {
	const snapshot = assertPlainObject(value, "snapshot");
	assertOnlyKeys(
		snapshot,
		new Set([
			"schemaVersion",
			"slug",
			"exportTitle",
			"exportSummary",
			"title",
			"subtitle",
			"seriesLine",
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
		"exportTitle",
		"exportSummary",
		"title",
		"subtitle",
		"seriesLine",
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
			"presentationSetVersion",
			"presentationSetSha256",
		]),
		"snapshot.provenance",
	);
	if (
		provenance.authority !== "Medium account export" ||
		provenance.captureFormat !== "account-export-html" ||
		provenance.sourcePath !== inventoryArticle.sourcePath ||
		provenance.sourceSha256 !== inventoryArticle.sourceSha256 ||
		provenance.canonicalUrl !== inventoryArticle.canonicalUrl ||
		provenance.presentationSetVersion !==
			presentationBinding?.presentationSetVersion ||
		provenance.presentationSetSha256 !==
			presentationBinding?.presentationSetSha256
	) {
		throw new MediumContractError("snapshot.provenance differs from inventory");
	}
	if (
		presentationBinding?.presentationSetVersion !==
		MEDIUM_PRESENTATION_SET_VERSION
	) {
		throw new MediumContractError(
			"snapshot presentation binding must use the supported version",
		);
	}
	assertSha256(
		presentationBinding.presentationSetSha256,
		"snapshot presentation binding SHA-256",
	);
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
		acquisitionManifestSha256: hero.acquisitionManifestSha256,
		captureSha256: hero.captureSha256,
		pixelSha256: hero.pixelSha256,
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
