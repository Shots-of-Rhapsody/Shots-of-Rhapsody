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
	assertCapturedAt,
	assertNonEmptyString,
	assertPlainObject,
	assertSlug,
	ContractError,
	getArticlePaths,
	getRepositoryPaths,
	MANIFEST_SCHEMA_VERSION,
	SNAPSHOT_JSON_POINTER,
	serializeJson,
	toRepositoryPath,
	VOCAL_AUTHOR_NAME,
	VOCAL_AUTHOR_URL,
	VOCAL_PLATFORM,
} from "./contract.js";
import { decodeUtf8, extractNextDataPost } from "./extract.js";
import { inspectPng, sha256 } from "./integrity.js";
import { renderIndexMarkdown, renderSlateDocument } from "./render.js";

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

function assertInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new ContractError(`${label} must be a non-negative safe integer`);
	}
	return value;
}

function assertDateString(value, label) {
	assertNonEmptyString(value, label);
	if (Number.isNaN(new Date(value).valueOf())) {
		throw new ContractError(`${label} must be a parseable date string`);
	}
	return value;
}

function assertVocalUrl(value, label) {
	const url = assertHttpsUrl(value, label);
	if (url.hostname !== "vocal.media") {
		throw new ContractError(`${label} must use https://vocal.media`);
	}
	return url.toString();
}

function assertHttpsUrl(value, label) {
	assertNonEmptyString(value, label);
	let url;
	try {
		url = new URL(value);
	} catch (error) {
		throw new ContractError(`${label} must be an absolute URL`, {
			cause: error,
		});
	}
	if (url.protocol !== "https:") {
		throw new ContractError(`${label} must use HTTPS`);
	}
	return url;
}

function assertString(value, label) {
	if (typeof value !== "string" || value.includes("\0")) {
		throw new ContractError(`${label} must be a string without NUL characters`);
	}
	return value;
}

function assertEmptyArray(value, label) {
	if (!Array.isArray(value)) {
		throw new ContractError(`${label} must be an array`);
	}
	if (value.length !== 0) {
		throw new ContractError(
			`${label} is non-empty and would require an unsupported media renderer`,
		);
	}
	return value;
}

function validateContent(content) {
	assertPlainObject(content, "post.content");
	for (const key of [
		"document",
		"heroImages",
		"images",
		"cloudinaryImages",
		"unsplashImages",
		"oEmbeds",
	]) {
		if (!(key in content)) {
			throw new ContractError(`post.content.${key} is required`);
		}
	}
	for (const key of Object.keys(content)) {
		if (
			![
				"document",
				"heroImages",
				"images",
				"cloudinaryImages",
				"unsplashImages",
				"oEmbeds",
			].includes(key)
		) {
			throw new ContractError(`post.content contains unsupported key ${key}`);
		}
	}
	assertEmptyArray(content.heroImages, "post.content.heroImages");
	assertEmptyArray(content.images, "post.content.images");
	assertEmptyArray(content.cloudinaryImages, "post.content.cloudinaryImages");
	assertEmptyArray(content.unsplashImages, "post.content.unsplashImages");
	assertEmptyArray(content.oEmbeds, "post.content.oEmbeds");
	renderSlateDocument(content.document);
	return content.document;
}

function validateTags(tags) {
	if (!Array.isArray(tags)) {
		throw new ContractError("post.tags must be an array");
	}
	return tags.map((tag, index) => {
		const label = `post.tags[${index}]`;
		assertPlainObject(tag, label);
		return {
			name: assertNonEmptyString(tag.name, `${label}.name`),
			slug: assertNonEmptyString(tag.slug, `${label}.slug`),
		};
	});
}

function validateInventoryArticle(article, index) {
	const label = `inventory.articles[${index}]`;
	assertPlainObject(article, label);
	const slug = assertSlug(article.slug);
	const expectedImage = assertPlainObject(
		article.expectedImage,
		`${label}.expectedImage`,
	);
	const width = assertInteger(
		expectedImage.width,
		`${label}.expectedImage.width`,
	);
	const height = assertInteger(
		expectedImage.height,
		`${label}.expectedImage.height`,
	);
	if (width === 0 || height === 0) {
		throw new ContractError(
			`${label}.expectedImage dimensions must be positive`,
		);
	}
	const legacyPaths = article.legacyPaths ?? [];
	if (!Array.isArray(legacyPaths)) {
		throw new ContractError(
			`${label}.legacyPaths must be an array when present`,
		);
	}
	const validatedLegacyPaths = legacyPaths.map((legacyPath, legacyIndex) => {
		const legacyLabel = `${label}.legacyPaths[${legacyIndex}]`;
		assertNonEmptyString(legacyPath, legacyLabel);
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
				`${legacyLabel} must be a safe repository-relative path below src/content/posts`,
			);
		}
		return legacyPath;
	});
	if (new Set(validatedLegacyPaths).size !== validatedLegacyPaths.length) {
		throw new ContractError(`${label}.legacyPaths contains a duplicate path`);
	}
	return {
		slug,
		title: assertNonEmptyString(article.title, `${label}.title`),
		sourceUrl: assertVocalUrl(article.sourceUrl, `${label}.sourceUrl`),
		communitySlug: assertNonEmptyString(
			article.communitySlug,
			`${label}.communitySlug`,
		),
		expectedImage: {
			width,
			height,
		},
		legacyPaths: validatedLegacyPaths,
	};
}

export function validateInventory(value) {
	const inventory = assertPlainObject(value, "inventory");
	if (inventory.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
		throw new ContractError(
			`inventory.schemaVersion must equal ${MANIFEST_SCHEMA_VERSION}`,
		);
	}
	const expectedCount = assertInteger(
		inventory.expectedCount,
		"inventory.expectedCount",
	);
	const expectedWordCount = assertInteger(
		inventory.expectedWordCount,
		"inventory.expectedWordCount",
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
	const sourceUrls = new Set();
	const legacyPaths = new Set();
	for (const article of articles) {
		if (bySlug.has(article.slug)) {
			throw new ContractError(`inventory repeats slug ${article.slug}`);
		}
		if (sourceUrls.has(article.sourceUrl)) {
			throw new ContractError(
				`inventory repeats source URL ${article.sourceUrl}`,
			);
		}
		bySlug.set(article.slug, article);
		sourceUrls.add(article.sourceUrl);
		for (const legacyPath of article.legacyPaths) {
			if (legacyPaths.has(legacyPath)) {
				throw new ContractError(`inventory repeats legacy path ${legacyPath}`);
			}
			legacyPaths.add(legacyPath);
		}
	}
	return { expectedCount, expectedWordCount, articles, bySlug };
}

export function validatePost(post, inventoryArticle, capturedAt) {
	assertPlainObject(post, "post");
	const id = assertNonEmptyString(post.id, "post.id");
	const title = assertNonEmptyString(post.name, "post.name");
	const subtitle = assertNonEmptyString(post.subtitle, "post.subtitle");
	const summary = assertNonEmptyString(post.summary, "post.summary");
	const slug = assertSlug(post.slug);
	const publishedAt = assertDateString(post.publishedAt, "post.publishedAt");
	const contentUpdatedAt =
		post.contentUpdatedAt === null
			? null
			: assertDateString(post.contentUpdatedAt, "post.contentUpdatedAt");
	const wordCount = assertInteger(post.wordCount, "post.wordCount");
	const author = assertPlainObject(post.author, "post.author");
	if (author.name !== VOCAL_AUTHOR_NAME) {
		throw new ContractError(
			`post.author.name must exactly equal ${JSON.stringify(VOCAL_AUTHOR_NAME)}`,
		);
	}
	const vocalSite = assertPlainObject(post.vocalSite, "post.vocalSite");
	const category = assertNonEmptyString(vocalSite.name, "post.vocalSite.name");
	const communitySlug = assertNonEmptyString(
		vocalSite.slug,
		"post.vocalSite.slug",
	);
	const tags = validateTags(post.tags);
	const heroImage = assertPlainObject(post.heroImage, "post.heroImage");
	assertHttpsUrl(heroImage.id, "post.heroImage.id");
	const imageSourceUrl = heroImage.id;
	assertNonEmptyString(heroImage.large, "post.heroImage.large");
	assertNonEmptyString(heroImage.socialMedia, "post.heroImage.socialMedia");
	const imageCaption = assertString(
		post.heroImageCaption,
		"post.heroImageCaption",
	);
	const imageAlt =
		post.heroImageAltText === null
			? null
			: assertString(post.heroImageAltText, "post.heroImageAltText");
	assertNonEmptyString(post.mediaType, "post.mediaType");
	const document = validateContent(post.content);

	if (slug !== inventoryArticle.slug) {
		throw new ContractError(
			`post.slug ${slug} does not match inventory slug ${inventoryArticle.slug}`,
		);
	}
	if (title !== inventoryArticle.title) {
		throw new ContractError(
			`post.name does not exactly match inventory title for ${slug}`,
		);
	}
	if (communitySlug !== inventoryArticle.communitySlug) {
		throw new ContractError(
			`post.vocalSite.slug does not match inventory communitySlug for ${slug}`,
		);
	}

	const publishedTime = new Date(publishedAt).valueOf();
	const updatedTime =
		contentUpdatedAt === null
			? undefined
			: new Date(contentUpdatedAt).valueOf();
	const updated =
		updatedTime !== undefined && updatedTime > publishedTime
			? contentUpdatedAt
			: undefined;
	return {
		metadata: {
			title,
			subtitle,
			summary,
			published: publishedAt,
			updated,
			imageAlt,
			imageCaption,
			imageSourceUrl,
			tags: tags.map((tag) => tag.name),
			category,
			sourceUrl: inventoryArticle.sourceUrl,
			source: {
				id,
				url: inventoryArticle.sourceUrl,
				capturedAt,
				publishedAt,
				contentUpdatedAt,
				wordCount,
				communitySlug,
			},
		},
		document,
	};
}

async function loadInventory(repoRoot) {
	const roots = getRepositoryPaths(repoRoot);
	const inventoryPath = path.join(
		roots.root,
		"provenance",
		"vocal",
		"inventory.json",
	);
	const buffer = await readRequiredFile(inventoryPath, "Vocal inventory");
	return {
		path: inventoryPath,
		buffer,
		...validateInventory(parseJsonBuffer(buffer, "Vocal inventory")),
	};
}

function emptyManifest(repoRoot, inventoryBuffer) {
	const roots = getRepositoryPaths(repoRoot);
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		platform: VOCAL_PLATFORM,
		author: {
			name: VOCAL_AUTHOR_NAME,
			profileUrl: VOCAL_AUTHOR_URL,
		},
		jsonPointer: SNAPSHOT_JSON_POINTER,
		inventoryPath: toRepositoryPath(
			roots.root,
			path.join(roots.root, "provenance", "vocal", "inventory.json"),
		),
		inventorySha256: sha256(inventoryBuffer),
		articles: [],
	};
}

function assertSha256(value, label) {
	if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
		throw new ContractError(`${label} must be a lowercase SHA-256 digest`);
	}
	return value;
}

function validateManifest(value) {
	const manifest = assertPlainObject(value, "manifest");
	if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
		throw new ContractError(
			`manifest.schemaVersion must equal ${MANIFEST_SCHEMA_VERSION}`,
		);
	}
	if (!Array.isArray(manifest.articles)) {
		throw new ContractError("manifest.articles must be an array");
	}
	if (manifest.platform !== VOCAL_PLATFORM) {
		throw new ContractError(`manifest.platform must equal ${VOCAL_PLATFORM}`);
	}
	const author = assertPlainObject(manifest.author, "manifest.author");
	if (
		author.name !== VOCAL_AUTHOR_NAME ||
		author.profileUrl !== VOCAL_AUTHOR_URL
	) {
		throw new ContractError(
			"manifest.author does not match the fixed Vocal author",
		);
	}
	if (manifest.jsonPointer !== SNAPSHOT_JSON_POINTER) {
		throw new ContractError(
			`manifest.jsonPointer must equal ${SNAPSHOT_JSON_POINTER}`,
		);
	}
	if (manifest.inventoryPath !== "provenance/vocal/inventory.json") {
		throw new ContractError(
			"manifest.inventoryPath must equal provenance/vocal/inventory.json",
		);
	}
	assertSha256(manifest.inventorySha256, "manifest.inventorySha256");
	const slugs = new Set();
	const sourceIds = new Set();
	let previousSlug;
	for (const [index, entryValue] of manifest.articles.entries()) {
		const entry = assertPlainObject(entryValue, `manifest.articles[${index}]`);
		const slug = assertSlug(entry.slug);
		if (slugs.has(slug)) {
			throw new ContractError(`manifest repeats slug ${slug}`);
		}
		slugs.add(slug);
		if (previousSlug !== undefined && previousSlug.localeCompare(slug) > 0) {
			throw new ContractError("manifest.articles must be sorted by slug");
		}
		previousSlug = slug;
		assertCapturedAt(entry.capturedAt);
		assertNonEmptyString(entry.sourceUrl, `manifest article ${slug}.sourceUrl`);
		const paths = assertPlainObject(
			entry.paths,
			`manifest article ${slug}.paths`,
		);
		for (const key of ["snapshot", "markdown", "image"]) {
			assertNonEmptyString(paths[key], `manifest article ${slug}.paths.${key}`);
		}
		const hashes = assertPlainObject(
			entry.hashes,
			`manifest article ${slug}.hashes`,
		);
		for (const key of [
			"rawPage",
			"rawImage",
			"snapshot",
			"markdown",
			"image",
		]) {
			assertSha256(hashes[key], `manifest article ${slug}.hashes.${key}`);
		}
		const image = assertPlainObject(
			entry.image,
			`manifest article ${slug}.image`,
		);
		if (image.mimeType !== "image/png") {
			throw new ContractError(
				`manifest article ${slug}.image.mimeType must be image/png`,
			);
		}
		for (const key of ["width", "height", "byteSize"]) {
			if (
				assertInteger(image[key], `manifest article ${slug}.image.${key}`) === 0
			) {
				throw new ContractError(
					`manifest article ${slug}.image.${key} must be positive`,
				);
			}
		}
		const source = assertPlainObject(
			entry.source,
			`manifest article ${slug}.source`,
		);
		const sourceId = assertNonEmptyString(
			source.id,
			`manifest article ${slug}.source.id`,
		);
		if (sourceIds.has(sourceId)) {
			throw new ContractError(`manifest repeats Vocal source id ${sourceId}`);
		}
		sourceIds.add(sourceId);
		assertDateString(
			source.publishedAt,
			`manifest article ${slug}.source.publishedAt`,
		);
		if (source.contentUpdatedAt !== null) {
			assertDateString(
				source.contentUpdatedAt,
				`manifest article ${slug}.source.contentUpdatedAt`,
			);
		}
		assertInteger(
			source.wordCount,
			`manifest article ${slug}.source.wordCount`,
		);
		assertNonEmptyString(
			source.communitySlug,
			`manifest article ${slug}.source.communitySlug`,
		);
	}
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
		manifest: validateManifest(parseJsonBuffer(buffer, "Vocal manifest")),
		exists: true,
	};
}

function makeManifestEntry(repoRoot, article, capturedAt, artifacts) {
	const paths = getArticlePaths(repoRoot, article.slug);
	return {
		slug: article.slug,
		sourceUrl: article.inventory.sourceUrl,
		capturedAt,
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
		},
		image: {
			mimeType: "image/png",
			width: article.image.width,
			height: article.image.height,
			byteSize: article.rawImageBuffer.byteLength,
		},
		source: {
			id: article.model.metadata.source.id,
			publishedAt: article.model.metadata.source.publishedAt,
			contentUpdatedAt: article.model.metadata.source.contentUpdatedAt,
			wordCount: article.model.metadata.source.wordCount,
			communitySlug: article.model.metadata.source.communitySlug,
		},
	};
}

async function loadRawArticle(repoRoot, inventoryArticle, capturedAt) {
	const paths = getArticlePaths(repoRoot, inventoryArticle.slug);
	const rawPageBuffer = await readRequiredFile(
		paths.rawPagePath,
		"Raw Vocal page",
	);
	const rawImageBuffer = await readRequiredFile(
		paths.rawImagePath,
		"Raw Vocal hero image",
	);
	const post = extractNextDataPost(
		decodeUtf8(rawPageBuffer, paths.rawPagePath),
	);
	const model = validatePost(post, inventoryArticle, capturedAt);
	const image = inspectPng(rawImageBuffer, paths.rawImagePath);
	if (
		image.width !== inventoryArticle.expectedImage.width ||
		image.height !== inventoryArticle.expectedImage.height
	) {
		throw new ContractError(
			`Hero image for ${inventoryArticle.slug} is ${image.width}x${image.height}; inventory requires ${inventoryArticle.expectedImage.width}x${inventoryArticle.expectedImage.height}`,
		);
	}
	return {
		slug: inventoryArticle.slug,
		inventory: inventoryArticle,
		paths,
		rawPageBuffer,
		rawImageBuffer,
		post,
		model,
		image,
	};
}

function renderArtifacts(article) {
	const snapshotBuffer = Buffer.from(serializeJson(article.post), "utf8");
	const markdownBuffer = Buffer.from(
		renderIndexMarkdown(article.model.metadata, article.model.document),
		"utf8",
	);
	return {
		snapshotBuffer,
		markdownBuffer,
		imageBuffer: article.rawImageBuffer,
	};
}

function entryBySlug(manifest) {
	return new Map(manifest.articles.map((entry) => [entry.slug, entry]));
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

async function classifyTarget(filePath, desired) {
	const current = await readOptionalFile(filePath);
	if (current === undefined) return "create";
	return current.equals(desired) ? "unchanged" : "replace";
}

async function writeAtomic(filePath, contents) {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.vocal-import-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
	try {
		await writeFile(temporaryPath, contents, { flag: "wx" });
		await rename(temporaryPath, filePath);
	} catch (error) {
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

async function ensureRegularFile(filePath, label) {
	try {
		const value = await stat(filePath);
		if (!value.isFile())
			throw new ContractError(`${label} is not a regular file`);
	} catch (error) {
		if (error?.code === "ENOENT")
			throw new ContractError(`${label} is missing`);
		throw error;
	}
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

export async function importArticles({
	repoRoot,
	slugs,
	all = false,
	write = false,
	update = false,
	capturedAt,
} = {}) {
	if (update && !write) {
		throw new ContractError("--update requires --write");
	}
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
	const plans = [];
	const providedCapturedAt =
		capturedAt === undefined ? undefined : assertCapturedAt(capturedAt);

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

		const article = await loadRawArticle(
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
				article.model = validatePost(
					article.post,
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

	const nextEntries = entryBySlug(manifest);
	for (const plan of plans) {
		if (plan.capturedAt === PENDING_CAPTURED_AT) continue;
		nextEntries.set(plan.slug, plan.desiredEntry);
	}
	const nextManifest = {
		...emptyManifest(repoRoot, inventory.buffer),
		articles: [...nextEntries.values()].sort((a, b) =>
			a.slug.localeCompare(b.slug),
		),
	};
	validateManifest(nextManifest);
	const manifestBuffer = Buffer.from(serializeJson(nextManifest), "utf8");
	const manifestAction = await classifyTarget(
		getRepositoryPaths(repoRoot).manifestPath,
		manifestBuffer,
	);

	if (write) {
		for (const plan of plans) {
			const filePlans = [
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
			];
			for (const [filePath, contents, action] of filePlans) {
				if (action !== "unchanged") await writeAtomic(filePath, contents);
			}
		}
		await writeAtomic(
			getRepositoryPaths(repoRoot).manifestPath,
			manifestBuffer,
		);
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

export async function inspectInventoryArticles({
	repoRoot,
	slugs,
	all = false,
} = {}) {
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
	const sourceIds = new Set();
	const results = [];
	for (const slug of uniqueSlugs) {
		const inventoryArticle = inventory.bySlug.get(slug);
		if (!inventoryArticle) {
			throw new ContractError(
				`Slug ${slug} is not present in the fixed inventory`,
			);
		}
		const paths = getArticlePaths(repoRoot, slug);
		const rawPageBuffer = await readRequiredFile(
			paths.rawPagePath,
			`Raw Vocal page for ${slug}`,
		);
		const post = extractNextDataPost(
			decodeUtf8(rawPageBuffer, paths.rawPagePath),
		);
		const model = validatePost(post, inventoryArticle, PENDING_CAPTURED_AT);
		const sourceId = model.metadata.source.id;
		if (sourceIds.has(sourceId)) {
			throw new ContractError(`Saved pages repeat Vocal source id ${sourceId}`);
		}
		sourceIds.add(sourceId);
		const heroImageUrl = model.metadata.imageSourceUrl;
		let parsedHeroUrl;
		try {
			parsedHeroUrl = new URL(heroImageUrl);
		} catch (error) {
			throw new ContractError(
				`post.heroImage.id for ${slug} is not an absolute URL`,
				{
					cause: error,
				},
			);
		}
		if (parsedHeroUrl.protocol !== "https:") {
			throw new ContractError(`post.heroImage.id for ${slug} must use HTTPS`);
		}
		results.push({
			slug,
			title: model.metadata.title,
			sourceId,
			sourceUrl: inventoryArticle.sourceUrl,
			communitySlug: inventoryArticle.communitySlug,
			heroImageUrl,
		});
	}
	return { articles: results };
}

function assertManifestEntry(entry, inventoryArticle, repoRoot) {
	if (entry.sourceUrl !== inventoryArticle.sourceUrl) {
		throw new ContractError(`Manifest sourceUrl mismatch for ${entry.slug}`);
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
	if (!exists) throw new ContractError("Vocal manifest is missing");
	if (manifest.inventorySha256 !== sha256(inventory.buffer)) {
		throw new ContractError("Vocal inventory hash does not match the manifest");
	}
	const manifestEntries = entryBySlug(manifest);
	for (const slug of manifestEntries.keys()) {
		if (!inventory.bySlug.has(slug)) {
			throw new ContractError(
				`Manifest slug ${slug} is not in the fixed inventory`,
			);
		}
		const inventoryArticle = inventory.bySlug.get(slug);
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
		throw new ContractError("Vocal manifest contains no imported articles");
	}
	const results = [];

	for (const slug of selectedSlugs) {
		const entry = manifestEntries.get(slug);
		if (!entry)
			throw new ContractError(`Manifest has no imported article ${slug}`);
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
		const post = assertPlainObject(
			parseJsonBuffer(snapshotBuffer, `Snapshot for ${slug}`),
			`Snapshot for ${slug}`,
		);
		const canonicalSnapshot = Buffer.from(serializeJson(post), "utf8");
		if (!snapshotBuffer.equals(canonicalSnapshot)) {
			throw new ContractError(`Snapshot for ${slug} is not canonical JSON`);
		}
		const model = validatePost(post, inventoryArticle, entry.capturedAt);
		const expectedMarkdown = Buffer.from(
			renderIndexMarkdown(model.metadata, model.document),
			"utf8",
		);
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
			entry.image.mimeType !== "image/png" ||
			entry.image.byteSize !== imageBuffer.byteLength ||
			image.width !== inventoryArticle.expectedImage.width ||
			image.height !== inventoryArticle.expectedImage.height ||
			image.width !== entry.image.width ||
			image.height !== entry.image.height
		) {
			throw new ContractError(`Image dimensions mismatch for ${slug}`);
		}
		if (
			entry.source.id !== model.metadata.source.id ||
			entry.source.publishedAt !== model.metadata.source.publishedAt ||
			entry.source.contentUpdatedAt !==
				model.metadata.source.contentUpdatedAt ||
			entry.source.wordCount !== model.metadata.source.wordCount ||
			entry.source.communitySlug !== model.metadata.source.communitySlug
		) {
			throw new ContractError(`Manifest source metadata mismatch for ${slug}`);
		}

		if (withRaw) {
			await ensureRegularFile(paths.rawPagePath, `Raw page for ${slug}`);
			await ensureRegularFile(paths.rawImagePath, `Raw image for ${slug}`);
			const rawPageBuffer = await readFile(paths.rawPagePath);
			const rawImageBuffer = await readFile(paths.rawImagePath);
			if (sha256(rawPageBuffer) !== entry.hashes.rawPage) {
				throw new ContractError(`Raw page hash mismatch for ${slug}`);
			}
			if (
				sha256(rawImageBuffer) !== entry.hashes.rawImage ||
				!rawImageBuffer.equals(imageBuffer)
			) {
				throw new ContractError(`Raw image mismatch for ${slug}`);
			}
			const rawPost = extractNextDataPost(
				decodeUtf8(rawPageBuffer, paths.rawPagePath),
			);
			if (!Buffer.from(serializeJson(rawPost), "utf8").equals(snapshotBuffer)) {
				throw new ContractError(`Raw post extraction differs for ${slug}`);
			}
		}
		results.push({ slug, status: "verified" });
	}

	const isComplete = manifestEntries.size === inventory.expectedCount;
	if (isComplete || requireComplete) {
		const inventorySlugs = new Set(
			inventory.articles.map((article) => article.slug),
		);
		if (
			manifestEntries.size !== inventory.expectedCount ||
			[...inventorySlugs].some((slug) => !manifestEntries.has(slug))
		) {
			throw new ContractError(
				`Import is incomplete: ${manifestEntries.size}/${inventory.expectedCount} articles`,
			);
		}
		const totalWordCount = [...manifestEntries.values()].reduce(
			(total, entry) => total + entry.source.wordCount,
			0,
		);
		if (totalWordCount !== inventory.expectedWordCount) {
			throw new ContractError(
				`Imported word count is ${totalWordCount}; inventory requires ${inventory.expectedWordCount}`,
			);
		}
	}

	return {
		articles: results,
		complete: isComplete,
		importedCount: manifestEntries.size,
		expectedCount: inventory.expectedCount,
	};
}
