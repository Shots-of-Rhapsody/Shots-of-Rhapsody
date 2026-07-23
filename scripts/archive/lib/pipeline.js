import { randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
	ALL_RIGHTS_RESERVED,
	AUTHOR_NAME,
	AUTHORITY_PLATFORM,
	assertCanonicalUtc,
	assertDateString,
	assertInteger,
	assertNonEmptyString,
	assertNoPrivateProtonReferences,
	assertOnlyKeys,
	assertPlainObject,
	assertSha256,
	assertSlug,
	assertString,
	assertVocalPublication,
	CAPTURE_FORMAT,
	ContractError,
	getArticlePaths,
	getRepositoryPaths,
	INVENTORY_SCHEMA_VERSION,
	MANIFEST_SCHEMA_VERSION,
	SNAPSHOT_SCHEMA_VERSION,
	serializeJson,
	toRepositoryPath,
} from "./contract.js";
import { decodeUtf8, extractProtonHtml, validateDocument } from "./extract.js";
import { inspectPng, sha256 } from "./integrity.js";
import {
	bodyTextSha256,
	renderBodyHtml,
	renderIndexMarkdown,
} from "./render.js";

const PENDING_CAPTURED_AT = "PENDING_CAPTURED_AT";

async function readOptionalFile(filePath) {
	try {
		return await readFile(filePath);
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function readRequiredFile(filePath, label) {
	const value = await readOptionalFile(filePath);
	if (value === undefined) {
		throw new ContractError(`${label} is missing: ${filePath}`);
	}
	return value;
}

function parseJsonBuffer(buffer, label) {
	let value;
	try {
		value = JSON.parse(decodeUtf8(buffer, label));
	} catch (error) {
		if (error instanceof ContractError) throw error;
		throw new ContractError(`${label} contains invalid JSON`, { cause: error });
	}
	return value;
}

function validateLegacyPaths(value, label) {
	const legacyPaths = value ?? [];
	if (!Array.isArray(legacyPaths)) {
		throw new ContractError(`${label} must be an array when present`);
	}
	const paths = legacyPaths.map((legacyPath, index) => {
		const pathLabel = `${label}[${index}]`;
		assertNonEmptyString(legacyPath, pathLabel);
		if (
			legacyPath.includes("\\") ||
			!legacyPath.startsWith("src/content/posts/") ||
			legacyPath
				.split("/")
				.some(
					(segment) => segment === "" || segment === "." || segment === "..",
				)
		) {
			throw new ContractError(
				`${pathLabel} must be a safe repository-relative path below src/content/posts`,
			);
		}
		return legacyPath;
	});
	if (new Set(paths).size !== paths.length) {
		throw new ContractError(`${label} contains a duplicate path`);
	}
	return paths;
}

function validateExpectedImage(value, label) {
	if (value === undefined) return undefined;
	const image = assertPlainObject(value, label);
	assertOnlyKeys(image, new Set(["width", "height"]), label);
	return {
		width: assertInteger(image.width, `${label}.width`, { positive: true }),
		height: assertInteger(image.height, `${label}.height`, { positive: true }),
	};
}

function validateInventoryArticle(value, index) {
	const label = `inventory.articles[${index}]`;
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
			"communityName",
			"communitySlug",
			"tags",
			"publication",
			"expectedImage",
			"legacyPaths",
		]),
		label,
	);
	if (
		article.tags !== undefined &&
		(!Array.isArray(article.tags) ||
			article.tags.some(
				(tag) =>
					typeof tag !== "string" || tag.length === 0 || tag.includes("\0"),
			))
	) {
		throw new ContractError(
			`${label}.tags must be an array of non-empty strings without NUL characters`,
		);
	}
	const tags = article.tags === undefined ? [] : [...article.tags];
	if (new Set(tags).size !== tags.length) {
		throw new ContractError(`${label}.tags contains a duplicate`);
	}
	const slug = assertSlug(article.slug);
	const communitySlug = assertSlug(article.communitySlug);
	const publication = assertVocalPublication(
		article.publication,
		`${label}.publication`,
	);
	const publicationUrl = new URL(publication.url);
	const publicationParts = publicationUrl.pathname.split("/").filter(Boolean);
	if (
		publicationParts.length !== 2 ||
		publicationParts[0] !== communitySlug ||
		publicationParts[1] !== slug
	) {
		throw new ContractError(
			`${label}.publication.url path must match communitySlug and slug`,
		);
	}
	const subtitle = assertNonEmptyString(article.subtitle, `${label}.subtitle`);
	const description = assertNonEmptyString(
		article.description,
		`${label}.description`,
	);
	if (description !== subtitle) {
		throw new ContractError(
			`${label}.description must exactly match its subtitle`,
		);
	}
	return {
		slug,
		title: assertNonEmptyString(article.title, `${label}.title`),
		subtitle,
		summary: assertNonEmptyString(article.summary, `${label}.summary`),
		description,
		publishedAt: assertDateString(article.publishedAt, `${label}.publishedAt`),
		communityName: assertNonEmptyString(
			article.communityName,
			`${label}.communityName`,
		),
		communitySlug,
		tags,
		publication,
		expectedImage: validateExpectedImage(
			article.expectedImage,
			`${label}.expectedImage`,
		),
		legacyPaths: validateLegacyPaths(
			article.legacyPaths,
			`${label}.legacyPaths`,
		),
	};
}

export function validateInventory(value) {
	const inventory = assertPlainObject(value, "inventory");
	assertOnlyKeys(
		inventory,
		new Set(["schemaVersion", "expectedCount", "articles"]),
		"inventory",
	);
	if (inventory.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
		throw new ContractError(
			`inventory.schemaVersion must equal ${INVENTORY_SCHEMA_VERSION}`,
		);
	}
	const expectedCount = assertInteger(
		inventory.expectedCount,
		"inventory.expectedCount",
	);
	if (!Array.isArray(inventory.articles)) {
		throw new ContractError("inventory.articles must be an array");
	}
	const articles = inventory.articles.map(validateInventoryArticle);
	if (articles.length !== expectedCount) {
		throw new ContractError(
			`inventory.expectedCount is ${expectedCount}, but inventory contains ${articles.length} articles`,
		);
	}
	const bySlug = new Map();
	const titles = new Set();
	const publicationUrls = new Set();
	const legacyPaths = new Set();
	for (const article of articles) {
		if (bySlug.has(article.slug)) {
			throw new ContractError(`inventory repeats slug ${article.slug}`);
		}
		if (titles.has(article.title)) {
			throw new ContractError(`inventory repeats title ${article.title}`);
		}
		if (article.publication && publicationUrls.has(article.publication.url)) {
			throw new ContractError(
				`inventory repeats publication URL ${article.publication.url}`,
			);
		}
		bySlug.set(article.slug, article);
		titles.add(article.title);
		if (article.publication) publicationUrls.add(article.publication.url);
		for (const legacyPath of article.legacyPaths) {
			if (legacyPaths.has(legacyPath)) {
				throw new ContractError(`inventory repeats legacy path ${legacyPath}`);
			}
			legacyPaths.add(legacyPath);
		}
	}
	return { expectedCount, articles, bySlug };
}

async function loadInventory(repoRoot) {
	const paths = getRepositoryPaths(repoRoot);
	const buffer = await readRequiredFile(
		paths.inventoryPath,
		"Archive inventory",
	);
	return {
		path: paths.inventoryPath,
		buffer,
		...validateInventory(parseJsonBuffer(buffer, "Archive inventory")),
	};
}

function makeSnapshot(article, extracted, capturedAt, imageBuffer, image) {
	if (
		extracted.leadTitle !== undefined &&
		extracted.leadTitle !== article.title
	) {
		throw new ContractError(
			`Optional Proton lead title does not exactly match inventory title for ${article.slug}`,
		);
	}
	if (extracted.subtitle !== article.subtitle) {
		throw new ContractError(
			`Proton subtitle does not exactly match inventory subtitle for ${article.slug}`,
		);
	}
	const bodyDocument = validateDocument(extracted.document);
	const bodyHtml = renderBodyHtml(bodyDocument);
	const textSha256 = bodyTextSha256(bodyDocument);
	const imageSha256 = sha256(imageBuffer);
	const snapshot = {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		slug: article.slug,
		title: article.title,
		subtitle: article.subtitle,
		summary: article.summary,
		description: article.description,
		author: AUTHOR_NAME,
		published: article.publishedAt,
		category: article.communityName,
		tags: article.tags,
		imageAlt: extracted.hero.alt === "" ? null : extracted.hero.alt,
		imageCaption: extracted.caption,
		provenance: {
			authority: AUTHORITY_PLATFORM,
			captureFormat: CAPTURE_FORMAT,
			capturedAt,
		},
		...(article.publication ? { publication: article.publication } : {}),
		hero: {
			sha256: imageSha256,
			mimeType: image.mimeType,
			width: image.width,
			height: image.height,
			byteSize: imageBuffer.byteLength,
			rawAlt: extracted.hero.alt,
		},
		bodyDocument,
		bodyHtml,
		bodyTextSha256: textSha256,
		bodyBlockCount: bodyDocument.blocks.length,
		license: { name: ALL_RIGHTS_RESERVED },
	};
	validateSnapshot(snapshot, article, {
		allowPendingCapturedAt: capturedAt === PENDING_CAPTURED_AT,
	});
	return snapshot;
}

function sameOptionalPublication(left, right) {
	if (left === undefined || right === undefined) return left === right;
	return left.platform === right.platform && left.url === right.url;
}

export function validateSnapshot(
	value,
	inventoryArticle,
	{ allowPendingCapturedAt = false } = {},
) {
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
			"publication",
			"hero",
			"bodyDocument",
			"bodyHtml",
			"bodyTextSha256",
			"bodyBlockCount",
			"license",
		]),
		"snapshot",
	);
	if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
		throw new ContractError(
			`snapshot.schemaVersion must equal ${SNAPSHOT_SCHEMA_VERSION}`,
		);
	}
	const slug = assertSlug(snapshot.slug);
	if (slug !== inventoryArticle.slug) {
		throw new ContractError(
			`Snapshot slug mismatch for ${inventoryArticle.slug}`,
		);
	}
	if (snapshot.title !== inventoryArticle.title) {
		throw new ContractError(`Snapshot title mismatch for ${slug}`);
	}
	for (const key of ["subtitle", "description", "author", "imageCaption"]) {
		assertNonEmptyString(snapshot[key], `snapshot.${key}`);
	}
	assertNonEmptyString(snapshot.summary, "snapshot.summary");
	if (snapshot.imageAlt !== null && typeof snapshot.imageAlt !== "string") {
		throw new ContractError("snapshot.imageAlt must be a string or null");
	}
	if (snapshot.author !== AUTHOR_NAME) {
		throw new ContractError(`snapshot.author must equal ${AUTHOR_NAME}`);
	}
	assertDateString(snapshot.published, "snapshot.published");
	assertNonEmptyString(snapshot.category, "snapshot.category");
	if (
		!Array.isArray(snapshot.tags) ||
		snapshot.tags.some((tag) => typeof tag !== "string") ||
		new Set(snapshot.tags).size !== snapshot.tags.length
	) {
		throw new ContractError(
			"snapshot.tags must contain unique strings in source order",
		);
	}
	if (
		snapshot.subtitle !== inventoryArticle.subtitle ||
		snapshot.summary !== inventoryArticle.summary ||
		snapshot.description !== inventoryArticle.description ||
		snapshot.published !== inventoryArticle.publishedAt ||
		snapshot.category !== inventoryArticle.communityName ||
		snapshot.tags.length !== inventoryArticle.tags.length ||
		snapshot.tags.some((tag, index) => tag !== inventoryArticle.tags[index])
	) {
		throw new ContractError(`Snapshot metadata mismatch for ${slug}`);
	}
	const provenance = assertPlainObject(
		snapshot.provenance,
		"snapshot.provenance",
	);
	assertOnlyKeys(
		provenance,
		new Set(["authority", "captureFormat", "capturedAt"]),
		"snapshot.provenance",
	);
	if (
		provenance.authority !== AUTHORITY_PLATFORM ||
		provenance.captureFormat !== CAPTURE_FORMAT
	) {
		throw new ContractError("snapshot.provenance has the wrong authority");
	}
	if (
		!(allowPendingCapturedAt && provenance.capturedAt === PENDING_CAPTURED_AT)
	) {
		assertCanonicalUtc(provenance.capturedAt, "snapshot.provenance.capturedAt");
	}
	const publication =
		snapshot.publication === undefined
			? undefined
			: assertVocalPublication(snapshot.publication, "snapshot.publication");
	if (!sameOptionalPublication(publication, inventoryArticle.publication)) {
		throw new ContractError(`Snapshot publication mismatch for ${slug}`);
	}
	const hero = assertPlainObject(snapshot.hero, "snapshot.hero");
	assertOnlyKeys(
		hero,
		new Set(["sha256", "mimeType", "width", "height", "byteSize", "rawAlt"]),
		"snapshot.hero",
	);
	assertSha256(hero.sha256, "snapshot.hero.sha256");
	if (hero.mimeType !== "image/png") {
		throw new ContractError("snapshot.hero.mimeType must equal image/png");
	}
	for (const key of ["width", "height", "byteSize"]) {
		assertInteger(hero[key], `snapshot.hero.${key}`, { positive: true });
	}
	assertString(hero.rawAlt, "snapshot.hero.rawAlt");
	if (
		(hero.rawAlt === "" && snapshot.imageAlt !== null) ||
		(hero.rawAlt !== "" && snapshot.imageAlt !== hero.rawAlt)
	) {
		throw new ContractError("snapshot.imageAlt does not preserve hero.rawAlt");
	}
	const bodyDocument = validateDocument(snapshot.bodyDocument);
	if (snapshot.bodyHtml !== renderBodyHtml(bodyDocument)) {
		throw new ContractError("snapshot.bodyHtml differs from bodyDocument");
	}
	if (snapshot.bodyTextSha256 !== bodyTextSha256(bodyDocument)) {
		throw new ContractError(
			"snapshot.bodyTextSha256 differs from bodyDocument",
		);
	}
	if (snapshot.bodyBlockCount !== bodyDocument.blocks.length) {
		throw new ContractError(
			"snapshot.bodyBlockCount differs from bodyDocument",
		);
	}
	const license = assertPlainObject(snapshot.license, "snapshot.license");
	assertOnlyKeys(license, new Set(["name"]), "snapshot.license");
	if (license.name !== ALL_RIGHTS_RESERVED) {
		throw new ContractError(
			`snapshot.license.name must equal ${ALL_RIGHTS_RESERVED}`,
		);
	}
	assertNoPrivateProtonReferences(snapshot, "snapshot");
	return snapshot;
}

function emptyManifest(repoRoot, inventoryBuffer) {
	const roots = getRepositoryPaths(repoRoot);
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		authority: {
			platform: AUTHORITY_PLATFORM,
			captureFormat: CAPTURE_FORMAT,
		},
		author: { name: AUTHOR_NAME },
		inventoryPath: toRepositoryPath(roots.root, roots.inventoryPath),
		inventorySha256: sha256(inventoryBuffer),
		articles: [],
	};
}

function validateManifest(value) {
	const manifest = assertPlainObject(value, "manifest");
	assertOnlyKeys(
		manifest,
		new Set([
			"schemaVersion",
			"authority",
			"author",
			"inventoryPath",
			"inventorySha256",
			"articles",
		]),
		"manifest",
	);
	if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
		throw new ContractError(
			`manifest.schemaVersion must equal ${MANIFEST_SCHEMA_VERSION}`,
		);
	}
	const authority = assertPlainObject(manifest.authority, "manifest.authority");
	assertOnlyKeys(
		authority,
		new Set(["platform", "captureFormat"]),
		"manifest.authority",
	);
	if (
		authority.platform !== AUTHORITY_PLATFORM ||
		authority.captureFormat !== CAPTURE_FORMAT
	) {
		throw new ContractError(
			"manifest.authority has the wrong platform or format",
		);
	}
	const author = assertPlainObject(manifest.author, "manifest.author");
	assertOnlyKeys(author, new Set(["name"]), "manifest.author");
	if (author.name !== AUTHOR_NAME) {
		throw new ContractError(`manifest.author.name must equal ${AUTHOR_NAME}`);
	}
	if (manifest.inventoryPath !== "provenance/tai-song/inventory.json") {
		throw new ContractError(
			"manifest.inventoryPath must equal provenance/tai-song/inventory.json",
		);
	}
	assertSha256(manifest.inventorySha256, "manifest.inventorySha256");
	if (!Array.isArray(manifest.articles)) {
		throw new ContractError("manifest.articles must be an array");
	}
	const slugs = new Set();
	const rawPageHashes = new Set();
	const publicationUrls = new Set();
	let previousSlug;
	for (const [index, entryValue] of manifest.articles.entries()) {
		const label = `manifest.articles[${index}]`;
		const entry = assertPlainObject(entryValue, label);
		assertOnlyKeys(
			entry,
			new Set([
				"slug",
				"capturedAt",
				"publication",
				"paths",
				"hashes",
				"content",
				"image",
			]),
			label,
		);
		const slug = assertSlug(entry.slug);
		if (slugs.has(slug))
			throw new ContractError(`manifest repeats slug ${slug}`);
		slugs.add(slug);
		if (previousSlug !== undefined && previousSlug.localeCompare(slug) > 0) {
			throw new ContractError("manifest.articles must be sorted by slug");
		}
		previousSlug = slug;
		assertCanonicalUtc(entry.capturedAt, `${label}.capturedAt`);
		if (entry.publication !== undefined) {
			const publication = assertVocalPublication(
				entry.publication,
				`${label}.publication`,
			);
			if (publicationUrls.has(publication.url)) {
				throw new ContractError(
					`manifest repeats publication URL ${publication.url}`,
				);
			}
			publicationUrls.add(publication.url);
		}
		const paths = assertPlainObject(entry.paths, `${label}.paths`);
		assertOnlyKeys(
			paths,
			new Set(["snapshot", "markdown", "image"]),
			`${label}.paths`,
		);
		for (const key of ["snapshot", "markdown", "image"]) {
			assertNonEmptyString(paths[key], `${label}.paths.${key}`);
		}
		const hashes = assertPlainObject(entry.hashes, `${label}.hashes`);
		assertOnlyKeys(
			hashes,
			new Set([
				"rawPage",
				"rawImage",
				"snapshot",
				"markdown",
				"image",
				"bodyText",
			]),
			`${label}.hashes`,
		);
		for (const key of [
			"rawPage",
			"rawImage",
			"snapshot",
			"markdown",
			"image",
			"bodyText",
		]) {
			assertSha256(hashes[key], `${label}.hashes.${key}`);
		}
		if (rawPageHashes.has(hashes.rawPage)) {
			throw new ContractError(
				`manifest repeats a Proton export hash for ${slug}`,
			);
		}
		rawPageHashes.add(hashes.rawPage);
		const content = assertPlainObject(entry.content, `${label}.content`);
		assertOnlyKeys(
			content,
			new Set(["subtitle", "imageCaption", "bodyTextSha256", "bodyBlockCount"]),
			`${label}.content`,
		);
		assertNonEmptyString(content.subtitle, `${label}.content.subtitle`);
		assertNonEmptyString(content.imageCaption, `${label}.content.imageCaption`);
		assertSha256(content.bodyTextSha256, `${label}.content.bodyTextSha256`);
		assertInteger(content.bodyBlockCount, `${label}.content.bodyBlockCount`, {
			positive: true,
		});
		if (hashes.bodyText !== content.bodyTextSha256) {
			throw new ContractError(`${label} body text hashes disagree`);
		}
		const image = assertPlainObject(entry.image, `${label}.image`);
		assertOnlyKeys(
			image,
			new Set(["sha256", "mimeType", "width", "height", "byteSize", "alt"]),
			`${label}.image`,
		);
		assertSha256(image.sha256, `${label}.image.sha256`);
		if (image.sha256 !== hashes.image) {
			throw new ContractError(`${label} image hashes disagree`);
		}
		if (image.mimeType !== "image/png") {
			throw new ContractError(`${label}.image.mimeType must equal image/png`);
		}
		for (const key of ["width", "height", "byteSize"]) {
			assertInteger(image[key], `${label}.image.${key}`, { positive: true });
		}
		if (image.alt !== null && typeof image.alt !== "string") {
			throw new ContractError(`${label}.image.alt must be a string or null`);
		}
	}
	assertNoPrivateProtonReferences(manifest, "manifest");
	return manifest;
}

async function loadManifest(repoRoot, inventoryBuffer) {
	const roots = getRepositoryPaths(repoRoot);
	const buffer = await readOptionalFile(roots.manifestPath);
	if (buffer === undefined) {
		return {
			manifest: emptyManifest(repoRoot, inventoryBuffer),
			exists: false,
		};
	}
	return {
		manifest: validateManifest(parseJsonBuffer(buffer, "Archive manifest")),
		exists: true,
	};
}

async function loadRawArticle(repoRoot, inventoryArticle, capturedAt) {
	const paths = getArticlePaths(repoRoot, inventoryArticle.slug);
	const rawPageBuffer = await readRequiredFile(
		paths.rawPagePath,
		"Raw Proton HTML export",
	);
	const rawImageBuffer = await readRequiredFile(
		paths.rawImagePath,
		"Raw Proton hero image",
	);
	const extracted = extractProtonHtml(
		decodeUtf8(rawPageBuffer, paths.rawPagePath),
	);
	const image = inspectPng(rawImageBuffer, paths.rawImagePath);
	if (
		inventoryArticle.expectedImage &&
		(image.width !== inventoryArticle.expectedImage.width ||
			image.height !== inventoryArticle.expectedImage.height)
	) {
		throw new ContractError(
			`Hero image for ${inventoryArticle.slug} is ${image.width}x${image.height}; inventory requires ${inventoryArticle.expectedImage.width}x${inventoryArticle.expectedImage.height}`,
		);
	}
	const snapshot = makeSnapshot(
		inventoryArticle,
		extracted,
		capturedAt,
		rawImageBuffer,
		image,
	);
	return {
		slug: inventoryArticle.slug,
		inventory: inventoryArticle,
		paths,
		rawPageBuffer,
		rawImageBuffer,
		extracted,
		image,
		snapshot,
	};
}

function renderArtifacts(article) {
	const snapshotBuffer = Buffer.from(serializeJson(article.snapshot), "utf8");
	const markdownBuffer = Buffer.from(
		renderIndexMarkdown(article.snapshot),
		"utf8",
	);
	assertNoPrivateProtonReferences(snapshotBuffer.toString("utf8"), "snapshot");
	assertNoPrivateProtonReferences(markdownBuffer.toString("utf8"), "Markdown");
	return {
		snapshotBuffer,
		markdownBuffer,
		imageBuffer: article.rawImageBuffer,
	};
}

function makeManifestEntry(repoRoot, article, capturedAt, artifacts) {
	const paths = getArticlePaths(repoRoot, article.slug);
	const snapshot = article.snapshot;
	return {
		slug: article.slug,
		capturedAt,
		...(snapshot.publication ? { publication: snapshot.publication } : {}),
		paths: {
			snapshot: toRepositoryPath(repoRoot, paths.snapshotPath),
			markdown: toRepositoryPath(repoRoot, paths.markdownPath),
			image: toRepositoryPath(repoRoot, paths.imagePath),
		},
		hashes: {
			rawPage: sha256(article.rawPageBuffer),
			rawImage: sha256(article.rawImageBuffer),
			snapshot: sha256(artifacts.snapshotBuffer),
			markdown: sha256(artifacts.markdownBuffer),
			image: sha256(article.rawImageBuffer),
			bodyText: snapshot.bodyTextSha256,
		},
		content: {
			subtitle: snapshot.subtitle,
			imageCaption: snapshot.imageCaption,
			bodyTextSha256: snapshot.bodyTextSha256,
			bodyBlockCount: snapshot.bodyBlockCount,
		},
		image: {
			sha256: snapshot.hero.sha256,
			mimeType: snapshot.hero.mimeType,
			width: snapshot.hero.width,
			height: snapshot.hero.height,
			byteSize: snapshot.hero.byteSize,
			alt: snapshot.imageAlt,
		},
	};
}

function entryBySlug(manifest) {
	return new Map(manifest.articles.map((entry) => [entry.slug, entry]));
}

async function classifyTarget(filePath, desired) {
	const current = await readOptionalFile(filePath);
	if (current === undefined) return "create";
	return current.equals(desired) ? "unchanged" : "replace";
}

async function writeAtomic(filePath, contents) {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.archive-import-${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, contents, { flag: "wx" });
		await rename(temporaryPath, filePath);
	} catch (error) {
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

async function assertCurrentMatchesEntry(repoRoot, entry) {
	const paths = getArticlePaths(repoRoot, entry.slug);
	for (const [kind, filePath] of [
		["snapshot", paths.snapshotPath],
		["markdown", paths.markdownPath],
		["image", paths.imagePath],
	]) {
		const buffer = await readRequiredFile(filePath, `Existing ${kind}`);
		if (sha256(buffer) !== entry.hashes[kind]) {
			throw new ContractError(
				`Refusing to update ${entry.slug}: current ${kind} does not match its recorded manifest hash`,
			);
		}
	}
}

function assertUniqueEvidence(plans, oldEntries, selectedSlugs) {
	const owners = new Map();
	for (const [slug, entry] of oldEntries) {
		if (!selectedSlugs.has(slug)) owners.set(entry.hashes.rawPage, slug);
	}
	for (const plan of plans) {
		const digest = sha256(plan.article.rawPageBuffer);
		const owner = owners.get(digest);
		if (owner !== undefined && owner !== plan.slug) {
			throw new ContractError(
				`Proton export for ${plan.slug} duplicates the raw document used by ${owner}`,
			);
		}
		owners.set(digest, plan.slug);
	}
}

export async function importArticles({
	repoRoot,
	slugs,
	all = false,
	write = false,
	update = false,
	capturedAt,
} = {}) {
	if (update && !write) throw new ContractError("--update requires --write");
	const inventory = await loadInventory(repoRoot);
	const selectedSlugs = all
		? inventory.articles.map((article) => article.slug)
		: slugs;
	if (!Array.isArray(selectedSlugs) || selectedSlugs.length === 0) {
		throw new ContractError("Select at least one --slug or use --all");
	}
	const uniqueSlugs = [...new Set(selectedSlugs.map(assertSlug))];
	if (uniqueSlugs.length !== selectedSlugs.length) {
		throw new ContractError("A slug was selected more than once");
	}
	const { manifest } = await loadManifest(repoRoot, inventory.buffer);
	const oldEntries = entryBySlug(manifest);
	const providedCapturedAt =
		capturedAt === undefined
			? undefined
			: assertCanonicalUtc(capturedAt, "capturedAt");
	const plans = [];

	for (const slug of uniqueSlugs) {
		const inventoryArticle = inventory.bySlug.get(slug);
		if (!inventoryArticle) {
			throw new ContractError(
				`Slug ${slug} is not present in the fixed inventory`,
			);
		}
		const oldEntry = oldEntries.get(slug);
		let effectiveCapturedAt = oldEntry?.capturedAt ?? providedCapturedAt;
		if (!oldEntry && effectiveCapturedAt === undefined) {
			if (write) {
				throw new ContractError(
					`First write for ${slug} requires --captured-at <ISO timestamp>`,
				);
			}
			effectiveCapturedAt = PENDING_CAPTURED_AT;
		}
		let article = await loadRawArticle(
			repoRoot,
			inventoryArticle,
			effectiveCapturedAt,
		);
		if (oldEntry) {
			const rawEvidenceChanged =
				sha256(article.rawPageBuffer) !== oldEntry.hashes.rawPage ||
				sha256(article.rawImageBuffer) !== oldEntry.hashes.rawImage;
			if (rawEvidenceChanged) {
				if (providedCapturedAt === undefined) {
					if (write) {
						throw new ContractError(
							`Changed raw evidence for ${slug} requires a new --captured-at <ISO timestamp>`,
						);
					}
					effectiveCapturedAt = PENDING_CAPTURED_AT;
				} else {
					if (providedCapturedAt === oldEntry.capturedAt) {
						throw new ContractError(
							`Changed raw evidence for ${slug} requires a capture timestamp different from ${oldEntry.capturedAt}`,
						);
					}
					effectiveCapturedAt = providedCapturedAt;
				}
				article = await loadRawArticle(
					repoRoot,
					inventoryArticle,
					effectiveCapturedAt,
				);
			}
		}
		const artifacts = renderArtifacts(article);
		const desiredEntry =
			effectiveCapturedAt === PENDING_CAPTURED_AT
				? undefined
				: makeManifestEntry(repoRoot, article, effectiveCapturedAt, artifacts);
		const actions = {
			snapshot: await classifyTarget(
				article.paths.snapshotPath,
				artifacts.snapshotBuffer,
			),
			markdown: await classifyTarget(
				article.paths.markdownPath,
				artifacts.markdownBuffer,
			),
			image: await classifyTarget(
				article.paths.imagePath,
				artifacts.imageBuffer,
			),
		};
		if (
			!oldEntry &&
			Object.values(actions).some((action) => action !== "create")
		) {
			throw new ContractError(
				`Refusing to adopt unmanaged existing output for ${slug}`,
			);
		}
		const entryChanged =
			oldEntry !== undefined &&
			desiredEntry !== undefined &&
			serializeJson(oldEntry) !== serializeJson(desiredEntry);
		if (
			oldEntry &&
			(Object.values(actions).some((action) => action !== "unchanged") ||
				entryChanged)
		) {
			if (write && !update) {
				throw new ContractError(
					`Recorded source or outputs for ${slug} differ; rerun with --write --update only after reviewing the source change`,
				);
			}
			if (update) await assertCurrentMatchesEntry(repoRoot, oldEntry);
		}
		plans.push({
			slug,
			capturedAt: effectiveCapturedAt,
			article,
			artifacts,
			desiredEntry,
			actions,
		});
	}

	assertUniqueEvidence(plans, oldEntries, new Set(uniqueSlugs));
	const nextEntries = entryBySlug(manifest);
	for (const plan of plans) {
		if (plan.capturedAt !== PENDING_CAPTURED_AT) {
			nextEntries.set(plan.slug, plan.desiredEntry);
		}
	}
	const nextManifest = {
		...emptyManifest(repoRoot, inventory.buffer),
		articles: [...nextEntries.values()].sort((left, right) =>
			left.slug.localeCompare(right.slug),
		),
	};
	validateManifest(nextManifest);
	const manifestBuffer = Buffer.from(serializeJson(nextManifest), "utf8");
	const roots = getRepositoryPaths(repoRoot);
	const manifestAction = await classifyTarget(
		roots.manifestPath,
		manifestBuffer,
	);

	if (write) {
		for (const plan of plans) {
			for (const [filePath, contents, action] of [
				[
					plan.article.paths.snapshotPath,
					plan.artifacts.snapshotBuffer,
					plan.actions.snapshot,
				],
				[
					plan.article.paths.markdownPath,
					plan.artifacts.markdownBuffer,
					plan.actions.markdown,
				],
				[
					plan.article.paths.imagePath,
					plan.artifacts.imageBuffer,
					plan.actions.image,
				],
			]) {
				if (action !== "unchanged") await writeAtomic(filePath, contents);
			}
		}
		await writeAtomic(roots.manifestPath, manifestBuffer);
	}

	return {
		mode: write ? "write" : "dry-run",
		articles: plans.map((plan) => ({
			slug: plan.slug,
			capturedAtRequired: plan.capturedAt === PENDING_CAPTURED_AT,
			actions: plan.actions,
		})),
		manifestAction,
	};
}

async function pathExists(filePath) {
	try {
		await stat(filePath);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

function assertManifestEntry(entry, inventoryArticle, repoRoot) {
	if (
		!sameOptionalPublication(entry.publication, inventoryArticle.publication)
	) {
		throw new ContractError(`Manifest publication mismatch for ${entry.slug}`);
	}
	const paths = getArticlePaths(repoRoot, entry.slug);
	const expectedPaths = {
		snapshot: toRepositoryPath(repoRoot, paths.snapshotPath),
		markdown: toRepositoryPath(repoRoot, paths.markdownPath),
		image: toRepositoryPath(repoRoot, paths.imagePath),
	};
	for (const [key, value] of Object.entries(expectedPaths)) {
		if (entry.paths[key] !== value) {
			throw new ContractError(
				`Manifest ${key} path mismatch for ${entry.slug}`,
			);
		}
	}
	return paths;
}

export async function verifyArticles({
	repoRoot,
	slugs,
	withRaw = false,
	requireComplete = false,
} = {}) {
	const inventory = await loadInventory(repoRoot);
	const { manifest, exists } = await loadManifest(repoRoot, inventory.buffer);
	if (!exists) throw new ContractError("Archive manifest is missing");
	if (manifest.inventorySha256 !== sha256(inventory.buffer)) {
		throw new ContractError(
			"Archive inventory hash does not match the manifest",
		);
	}
	const manifestEntries = entryBySlug(manifest);
	for (const slug of manifestEntries.keys()) {
		const inventoryArticle = inventory.bySlug.get(slug);
		if (!inventoryArticle) {
			throw new ContractError(
				`Manifest slug ${slug} is not in the fixed inventory`,
			);
		}
		for (const legacyPath of inventoryArticle.legacyPaths) {
			const absoluteLegacyPath = path.join(
				getRepositoryPaths(repoRoot).root,
				...legacyPath.split("/"),
			);
			if (await pathExists(absoluteLegacyPath)) {
				throw new ContractError(
					`Legacy duplicate route input still exists for ${slug}: ${legacyPath}`,
				);
			}
		}
	}
	const selectedSlugs =
		Array.isArray(slugs) && slugs.length > 0
			? [...new Set(slugs.map(assertSlug))]
			: [...manifestEntries.keys()].sort();
	if (selectedSlugs.length === 0) {
		throw new ContractError("Archive manifest contains no imported articles");
	}
	const results = [];

	for (const slug of selectedSlugs) {
		const entry = manifestEntries.get(slug);
		if (!entry) {
			throw new ContractError(`Manifest has no imported article ${slug}`);
		}
		const inventoryArticle = inventory.bySlug.get(slug);
		const paths = assertManifestEntry(entry, inventoryArticle, repoRoot);
		const snapshotBuffer = await readRequiredFile(
			paths.snapshotPath,
			"Snapshot",
		);
		const markdownBuffer = await readRequiredFile(
			paths.markdownPath,
			"Markdown output",
		);
		const imageBuffer = await readRequiredFile(paths.imagePath, "Image output");
		const snapshot = validateSnapshot(
			parseJsonBuffer(snapshotBuffer, `Snapshot for ${slug}`),
			inventoryArticle,
		);
		if (!snapshotBuffer.equals(Buffer.from(serializeJson(snapshot), "utf8"))) {
			throw new ContractError(`Snapshot for ${slug} is not canonical JSON`);
		}
		const expectedMarkdown = Buffer.from(renderIndexMarkdown(snapshot), "utf8");
		if (!markdownBuffer.equals(expectedMarkdown)) {
			throw new ContractError(`Generated Markdown differs for ${slug}`);
		}
		for (const [kind, buffer] of [
			["snapshot", snapshotBuffer],
			["markdown", markdownBuffer],
			["image", imageBuffer],
		]) {
			if (sha256(buffer) !== entry.hashes[kind]) {
				throw new ContractError(`${kind} hash mismatch for ${slug}`);
			}
		}
		const image = inspectPng(imageBuffer, paths.imagePath);
		if (
			entry.image.sha256 !== snapshot.hero.sha256 ||
			entry.image.sha256 !== sha256(imageBuffer) ||
			entry.image.byteSize !== imageBuffer.byteLength ||
			entry.image.width !== image.width ||
			entry.image.height !== image.height ||
			entry.image.alt !== snapshot.imageAlt ||
			entry.content.subtitle !== snapshot.subtitle ||
			entry.content.imageCaption !== snapshot.imageCaption ||
			entry.content.bodyTextSha256 !== snapshot.bodyTextSha256 ||
			entry.content.bodyBlockCount !== snapshot.bodyBlockCount
		) {
			throw new ContractError(`Manifest metadata mismatch for ${slug}`);
		}
		if (withRaw) {
			const rawPageBuffer = await readRequiredFile(
				paths.rawPagePath,
				`Raw Proton HTML export for ${slug}`,
			);
			const rawImageBuffer = await readRequiredFile(
				paths.rawImagePath,
				`Raw Proton hero image for ${slug}`,
			);
			if (sha256(rawPageBuffer) !== entry.hashes.rawPage) {
				throw new ContractError(`Raw page hash mismatch for ${slug}`);
			}
			if (
				sha256(rawImageBuffer) !== entry.hashes.rawImage ||
				!rawImageBuffer.equals(imageBuffer)
			) {
				throw new ContractError(`Raw image mismatch for ${slug}`);
			}
			const extracted = extractProtonHtml(
				decodeUtf8(rawPageBuffer, paths.rawPagePath),
			);
			const expectedSnapshot = makeSnapshot(
				inventoryArticle,
				extracted,
				entry.capturedAt,
				rawImageBuffer,
				inspectPng(rawImageBuffer, paths.rawImagePath),
			);
			if (
				!Buffer.from(serializeJson(expectedSnapshot), "utf8").equals(
					snapshotBuffer,
				)
			) {
				throw new ContractError(`Raw extraction differs for ${slug}`);
			}
		}
		results.push({ slug, status: "verified" });
	}

	const inventorySlugs = new Set(
		inventory.articles.map((article) => article.slug),
	);
	const isComplete =
		manifestEntries.size === inventory.expectedCount &&
		[...inventorySlugs].every((slug) => manifestEntries.has(slug));
	if (requireComplete && !isComplete) {
		throw new ContractError(
			`Import is incomplete: ${manifestEntries.size}/${inventory.expectedCount} articles`,
		);
	}
	return {
		articles: results,
		complete: isComplete,
		importedCount: manifestEntries.size,
		expectedCount: inventory.expectedCount,
	};
}
