import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
	bodyImageOutputPath,
	responsiveBodyImageWidths,
} from "../../scripts/medium/lib/render.js";
import { PODCAST_SHOW } from "../data/podcast.ts";
import { getApprovedPodcastEpisodes } from "../data/podcast-approval.ts";
import { DISPLAY_IMAGE_QUALITY } from "../utils/image-policy.ts";

const IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|svg|webp)$/iu;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MANIFEST_PATHS = {
	archive: path.join(
		REPOSITORY_ROOT,
		"provenance",
		"tai-song",
		"manifest.json",
	),
	medium: path.join(REPOSITORY_ROOT, "provenance", "medium", "manifest.json"),
	firstParty: path.join(
		REPOSITORY_ROOT,
		"provenance",
		"first-party",
		"manifest.json",
	),
	catalog: path.join(REPOSITORY_ROOT, "provenance", "publication-catalog.json"),
};

async function walk(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(entryPath)));
		else if (entry.isFile()) files.push(entryPath);
		else {
			throw new Error(
				`Publication output contains a non-regular entry: ${entryPath}`,
			);
		}
	}
	return files;
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function normalizePath(value) {
	return value.replace(/\\/gu, "/");
}

function stripSha256(value) {
	const digest = String(value ?? "").replace(/^sha256:/u, "");
	if (!/^[0-9a-f]{64}$/u.test(digest))
		throw new Error("Publication asset has an invalid SHA-256 digest");
	return digest;
}

function mimeFormat(mimeType) {
	if (mimeType === "image/png") return "png";
	if (mimeType === "image/jpeg") return "jpeg";
	if (mimeType === "image/webp") return "webp";
	throw new Error(
		`Publication asset has an unsupported MIME type: ${mimeType}`,
	);
}

function safeAssetId(asset) {
	const id = asset.id ?? path.basename(asset.path, path.extname(asset.path));
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id))
		throw new Error(`Publication asset ID is unsafe: ${id}`);
	return id;
}

async function readJson(filePath) {
	return JSON.parse(await readFile(filePath, "utf8"));
}

async function readVerifiedSourceAsset(asset, slug) {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
		throw new Error(`Publication slug is unsafe: ${slug}`);
	}
	const expectedPrefix = `src/content/posts/${slug}/`;
	if (
		typeof asset.path !== "string" ||
		!asset.path.startsWith(expectedPrefix) ||
		!/^src\/content\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*\.(?:jpe?g|png|webp)$/u.test(
			asset.path,
		) ||
		asset.path.includes("\\") ||
		asset.path.split("/").some((segment) => segment === "..")
	) {
		throw new Error(`Publication asset path is unsafe for ${slug}`);
	}
	if (
		(asset.role !== "hero" && asset.role !== "body") ||
		!Number.isSafeInteger(asset.byteSize) ||
		asset.byteSize <= 0 ||
		!Number.isSafeInteger(asset.width) ||
		asset.width <= 0 ||
		!Number.isSafeInteger(asset.height) ||
		asset.height <= 0
	) {
		throw new Error(`Publication asset metadata is invalid for ${slug}`);
	}
	const expectedFormat = mimeFormat(asset.mimeType);
	const absolutePath = path.resolve(REPOSITORY_ROOT, ...asset.path.split("/"));
	const contentRoot = path.resolve(REPOSITORY_ROOT, "src", "content", "posts");
	const relative = path.relative(contentRoot, absolutePath);
	const lexicalMetadata = await lstat(absolutePath);
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative) ||
		lexicalMetadata.isSymbolicLink() ||
		!lexicalMetadata.isFile()
	) {
		throw new Error(`Publication asset escapes the content root for ${slug}`);
	}
	const [realContentRoot, realAssetPath] = await Promise.all([
		realpath(contentRoot),
		realpath(absolutePath),
	]);
	const realRelative = path.relative(realContentRoot, realAssetPath);
	if (
		realRelative === "" ||
		realRelative === ".." ||
		realRelative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(realRelative)
	) {
		throw new Error(`Publication asset resolves outside content for ${slug}`);
	}
	const bytes = await readFile(realAssetPath);
	const metadata = await sharp(bytes).metadata();
	if (
		sha256(bytes) !== stripSha256(asset.sha256) ||
		bytes.byteLength !== asset.byteSize ||
		metadata.format !== expectedFormat ||
		metadata.width !== asset.width ||
		metadata.height !== asset.height ||
		(metadata.pages !== undefined && metadata.pages !== 1)
	) {
		throw new Error(`Publication asset differs from evidence for ${slug}`);
	}
	return bytes;
}

function normalizedArchiveAsset(article) {
	return {
		id: "hero",
		role: "hero",
		path: article.paths.image,
		sha256: article.image.sha256,
		mimeType: article.image.mimeType,
		width: article.image.width,
		height: article.image.height,
		byteSize: article.image.byteSize,
	};
}

function publicationEntries({ archive, medium, firstParty, catalog }) {
	const uniqueArticles = (manifest, label) => {
		if (!Array.isArray(manifest?.articles)) {
			throw new Error(`${label} publication manifest has no article list`);
		}
		const result = new Map();
		for (const article of manifest.articles) {
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(article?.slug ?? "")) {
				throw new Error(`${label} publication manifest has an unsafe slug`);
			}
			if (result.has(article.slug)) {
				throw new Error(
					`${label} publication manifest repeats ${article.slug}`,
				);
			}
			result.set(article.slug, article);
		}
		return result;
	};
	const archiveArticles = uniqueArticles(archive, "Archive");
	const mediumArticles = uniqueArticles(medium, "Medium");
	const firstPartyArticles = uniqueArticles(firstParty, "First-party");
	const bySource = {
		"tai-song": new Map(
			[...archiveArticles].map(([slug, article]) => [
				slug,
				{
					...article,
					assets: [normalizedArchiveAsset(article)],
				},
			]),
		),
		medium: mediumArticles,
		"first-party": firstPartyArticles,
	};
	if (
		catalog?.schemaVersion !== 1 ||
		!Array.isArray(catalog.entries) ||
		catalog.entries.length < 11
	)
		throw new Error("Publication catalog must contain the sealed archive");
	const seenSlugs = new Set();
	const seenAssetIds = new Set();
	const entries = catalog.entries.map((entry) => {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry?.slug ?? "")) {
			throw new Error("Publication catalog contains an unsafe slug");
		}
		if (seenSlugs.has(entry.slug))
			throw new Error(`Publication catalog repeats ${entry.slug}`);
		seenSlugs.add(entry.slug);
		const article = bySource[entry.source]?.get(entry.slug);
		if (!article)
			throw new Error(`Publication catalog lacks evidence for ${entry.slug}`);
		const assets = article.assets.map((asset) => ({
			...asset,
			id: safeAssetId(asset),
		}));
		for (const asset of assets) {
			const stableId = `${entry.slug}/${asset.id}`;
			if (seenAssetIds.has(stableId)) {
				throw new Error(`Publication entry repeats asset ID ${stableId}`);
			}
			seenAssetIds.add(stableId);
		}
		if (assets.filter((asset) => asset.role === "hero").length !== 1)
			throw new Error(`Publication entry requires one hero: ${entry.slug}`);
		return { ...entry, assets };
	});
	const assetPaths = entries.flatMap((entry) =>
		entry.assets.map((asset) => asset.path),
	);
	const assetHashes = entries.flatMap((entry) =>
		entry.assets.map((asset) => stripSha256(asset.sha256)),
	);
	if (
		new Set(assetPaths).size !== assetPaths.length ||
		new Set(assetHashes).size !== assetHashes.length
	) {
		throw new Error("Approved publication assets must be unique");
	}
	return entries;
}

async function emitBodyDerivatives(outputRoot, entries) {
	const expected = new Set();
	for (const entry of entries) {
		for (const asset of entry.assets.filter((asset) => asset.role === "body")) {
			const bytes = await readVerifiedSourceAsset(asset, entry.slug);
			for (const width of responsiveBodyImageWidths(asset.width)) {
				for (const format of ["avif", "webp"]) {
					const relative = bodyImageOutputPath(
						entry.slug,
						asset.id,
						width,
						format,
					);
					if (expected.has(relative)) {
						throw new Error(`Responsive body image path repeats: ${relative}`);
					}
					const target = path.join(outputRoot, ...relative.split("/"));
					await mkdir(path.dirname(target), { recursive: true });
					let pipeline = sharp(bytes).resize({
						width,
						fit: "inside",
						withoutEnlargement: true,
					});
					pipeline =
						format === "avif"
							? pipeline.avif({ quality: DISPLAY_IMAGE_QUALITY })
							: pipeline.webp({ quality: DISPLAY_IMAGE_QUALITY });
					await writeFile(target, await pipeline.toBuffer(), { flag: "wx" });
					expected.add(relative);
				}
			}
		}
	}
	return expected;
}

async function isFile(filePath) {
	try {
		return (await lstat(filePath)).isFile();
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function readRegularFileInside(root, relativePath, label) {
	const absolutePath = path.resolve(root, ...relativePath.split("/"));
	const relative = path.relative(path.resolve(root), absolutePath);
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error(`${label} escapes its approved root`);
	}
	const metadata = await lstat(absolutePath);
	if (metadata.isSymbolicLink() || !metadata.isFile()) {
		throw new Error(`${label} is not a regular file`);
	}
	const [realRoot, realFile] = await Promise.all([
		realpath(root),
		realpath(absolutePath),
	]);
	const realRelative = path.relative(realRoot, realFile);
	if (
		realRelative === "" ||
		realRelative === ".." ||
		realRelative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(realRelative)
	) {
		throw new Error(`${label} resolves outside its approved root`);
	}
	return readFile(realFile);
}

async function preparePodcastAssets(outputRoot) {
	const approvedEpisodes = getApprovedPodcastEpisodes();
	await rm(path.join(outputRoot, "media", "podcast"), {
		recursive: true,
		force: true,
	});
	if (approvedEpisodes.length === 0) {
		return { published: false, coverHash: undefined };
	}
	for (const episode of approvedEpisodes) {
		const route = `podcast/${episode.slug}/index.html`;
		if (!(await isFile(path.join(outputRoot, ...route.split("/"))))) {
			throw new Error(`Approved podcast route is missing: ${episode.slug}`);
		}
		const relativeAudioPath = `public/${episode.audio.publicPath.replace(/^\/+/, "")}`;
		const audio = await readRegularFileInside(
			REPOSITORY_ROOT,
			relativeAudioPath,
			`Podcast audio source for ${episode.slug}`,
		);
		if (
			audio.byteLength !== episode.audio.byteLength ||
			sha256(audio) !== stripSha256(episode.audio.sha256)
		) {
			throw new Error(
				`Podcast audio differs from approved evidence: ${episode.slug}`,
			);
		}
		const audioTarget = path.join(
			outputRoot,
			...episode.audio.publicPath.replace(/^\/+/, "").split("/"),
		);
		await mkdir(path.dirname(audioTarget), { recursive: true });
		await writeFile(audioTarget, audio, { flag: "wx" });
	}
	const cover = await readRegularFileInside(
		REPOSITORY_ROOT,
		PODCAST_SHOW.artwork.archivePath,
		"Podcast cover source",
	);
	const metadata = await sharp(cover).metadata();
	if (
		sha256(cover) !== stripSha256(PODCAST_SHOW.artwork.sha256) ||
		metadata.format !== "png" ||
		metadata.width !== PODCAST_SHOW.artwork.width ||
		metadata.height !== PODCAST_SHOW.artwork.height ||
		metadata.hasAlpha === true ||
		metadata.space !== "srgb"
	) {
		throw new Error("Podcast cover differs from approved evidence");
	}
	const coverPath = PODCAST_SHOW.artwork.publicPath.replace(/^\/+/, "");
	const coverTarget = path.join(outputRoot, ...coverPath.split("/"));
	await mkdir(path.dirname(coverTarget), { recursive: true });
	await writeFile(coverTarget, cover, { flag: "wx" });
	return {
		published: true,
		coverHash: stripSha256(PODCAST_SHOW.artwork.sha256),
		coverPath,
	};
}

export default function publicationAssets() {
	return {
		name: "shots-of-rhapsody-publication-assets",
		hooks: {
			"astro:build:done": async ({ dir }) => {
				const outputRoot = fileURLToPath(dir);
				const [archive, medium, firstParty, catalog] = await Promise.all([
					readJson(MANIFEST_PATHS.archive),
					readJson(MANIFEST_PATHS.medium),
					readJson(MANIFEST_PATHS.firstParty),
					readJson(MANIFEST_PATHS.catalog),
				]);
				const entries = publicationEntries({
					archive,
					medium,
					firstParty,
					catalog,
				});
				for (const entry of entries) {
					for (const asset of entry.assets) {
						await readVerifiedSourceAsset(asset, entry.slug);
					}
				}
				const expectedBodyImages = await emitBodyDerivatives(
					outputRoot,
					entries,
				);
				const podcast = await preparePodcastAssets(outputRoot);

				const approvedHeroHashes = new Set(
					entries.map((entry) =>
						stripSha256(
							entry.assets.find((asset) => asset.role === "hero").sha256,
						),
					),
				);
				if (podcast.coverHash) approvedHeroHashes.add(podcast.coverHash);
				const expectedSocialImages = new Set(
					entries.map((entry) => `social/${entry.slug}.jpg`),
				);
				expectedSocialImages.add("social/site.jpg");

				const sourceAssetStems = new Set();
				const foundOriginalHashes = new Set();
				for (const file of await walk(outputRoot)) {
					if (!IMAGE_EXTENSION.test(file)) continue;
					const bytes = await readFile(file);
					const digest = sha256(bytes);
					const relative = normalizePath(path.relative(outputRoot, file));
					if (
						digest === stripSha256(PODCAST_SHOW.artwork.sha256) &&
						/^_astro\/[^/]+\.png$/u.test(relative)
					) {
						if (podcast.published) {
							foundOriginalHashes.add(digest);
							sourceAssetStems.add(
								path.basename(relative, path.extname(relative)),
							);
						}
						await unlink(file);
						continue;
					}
					if (!approvedHeroHashes.has(digest)) continue;
					if (!/^_astro\/[^/]+\.(?:jpe?g|png|webp)$/u.test(relative)) {
						if (relative === podcast.coverPath && digest === podcast.coverHash)
							continue;
						throw new Error(
							`Publication original was emitted outside the Astro source boundary: ${relative}`,
						);
					}
					foundOriginalHashes.add(digest);
					sourceAssetStems.add(path.basename(relative, path.extname(relative)));
					await unlink(file);
				}
				if (
					foundOriginalHashes.size !== approvedHeroHashes.size ||
					sourceAssetStems.size !== approvedHeroHashes.size
				) {
					throw new Error(
						"Astro did not expose one unique source family for every approved hero",
					);
				}

				const emittedImages = (await walk(outputRoot))
					.filter((file) => IMAGE_EXTENSION.test(file))
					.map((file) => normalizePath(path.relative(outputRoot, file)));
				const expectedPodcastImages = new Set(
					podcast.published ? [podcast.coverPath] : [],
				);
				const unexpectedImages = emittedImages.filter(
					(relative) =>
						relative !== "mark.svg" &&
						!expectedSocialImages.has(relative) &&
						!expectedBodyImages.has(relative) &&
						!expectedPodcastImages.has(relative) &&
						(!/^_astro\/[^/]+\.(?:avif|webp)$/u.test(relative) ||
							![...sourceAssetStems].some((stem) =>
								path.basename(relative).startsWith(`${stem}_`),
							)),
				);
				const missingImages = [
					...expectedSocialImages,
					...expectedBodyImages,
					...expectedPodcastImages,
				].filter((relative) => !emittedImages.includes(relative));
				if (unexpectedImages.length > 0 || missingImages.length > 0) {
					throw new Error(
						[
							unexpectedImages.length > 0
								? `Unexpected built images: ${unexpectedImages.join(", ")}`
								: "",
							missingImages.length > 0
								? `Missing publication images: ${missingImages.join(", ")}`
								: "",
						]
							.filter(Boolean)
							.join("; "),
					);
				}
			},
		},
	};
}
