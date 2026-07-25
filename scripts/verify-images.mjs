import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { parse } from "parse5";
import sharp from "sharp";
import {
	bodyImageOutputPath,
	responsiveBodyImageWidths,
} from "./medium/lib/render.js";

const DEFAULT_DIST = "dist";
const SITE_SOCIAL_IMAGE = "social/site.jpg";
const IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|svg|webp)$/iu;
const AUDIO_EXTENSION = /\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/iu;
const TEXT_EXTENSION = /\.(?:css|html|js|json|map|mjs|svg|txt|xml)$/iu;
const RESPONSIVE_WIDTHS = new Set([320, 480, 640, 960, 1024, 1280, 1600, 2048]);
const PODCAST_COVER_PATH = "media/podcast/shots-of-rhapsody-podcast-cover.png";
const PODCAST_COVER_SHA256 =
	"293125a3959b91fd3f263905c3f67e360fdb0f62d784653d10311486b0008c70";

export const DEFAULT_IMAGE_LIMITS = Object.freeze({
	distBytes: 15 * 1024 * 1024,
	cardBytes: 200 * 1024,
	socialBytes: 500 * 1024,
	initialJavaScriptGzipBytes: 75 * 1024,
	homepageDesktopImageBytes: 1.25 * 1024 * 1024,
	homepageMobileImageBytes: 750 * 1024,
});

function normalizePath(value) {
	return value.replace(/\\/gu, "/");
}

async function walk(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(entryPath)));
		else if (entry.isFile()) files.push(entryPath);
		else {
			throw new Error(
				`Built output contains a non-regular entry: ${entryPath}`,
			);
		}
	}
	return files;
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function attributes(node) {
	return Object.fromEntries(
		(node.attrs ?? []).map(({ name, value }) => [name, value]),
	);
}

function visit(node, callback) {
	callback(node);
	for (const child of node.childNodes ?? []) visit(child, callback);
}

function responsiveAssetPath(value) {
	try {
		const parsed = new URL(
			value.replace(/&amp;/gu, "&"),
			"https://build.invalid/",
		);
		if (parsed.origin !== "https://build.invalid") return undefined;
		const { pathname } = parsed;
		const marker = "/_astro/";
		const markerIndex = pathname.indexOf(marker);
		if (markerIndex < 0) return undefined;
		return `_astro/${decodeURIComponent(pathname.slice(markerIndex + marker.length))}`;
	} catch {
		return undefined;
	}
}

function responsivePathsFromNode(node) {
	const paths = new Set();
	visit(node, (descendant) => {
		if (descendant.tagName !== "source" && descendant.tagName !== "img") return;
		const nodeAttributes = attributes(descendant);
		for (const candidate of (nodeAttributes.srcset ?? "").split(",")) {
			const assetPath = responsiveAssetPath(candidate.trim().split(/\s+/u)[0]);
			if (assetPath) paths.add(assetPath);
		}
		const sourcePath = responsiveAssetPath(nodeAttributes.src ?? "");
		if (sourcePath) paths.add(sourcePath);
	});
	return paths;
}

function writingMediaPath(value) {
	try {
		const parsed = new URL(
			value.replace(/&amp;/gu, "&"),
			"https://build.invalid/",
		);
		if (parsed.origin !== "https://build.invalid") return undefined;
		const { pathname } = parsed;
		const marker = "/media/writing/";
		const markerIndex = pathname.indexOf(marker);
		if (markerIndex < 0) return undefined;
		return `media/writing/${decodeURIComponent(pathname.slice(markerIndex + marker.length))}`;
	} catch {
		return undefined;
	}
}

function writingMediaPathsFromNode(node) {
	const paths = new Set();
	visit(node, (descendant) => {
		if (descendant.tagName !== "source" && descendant.tagName !== "img") return;
		const nodeAttributes = attributes(descendant);
		for (const candidate of (nodeAttributes.srcset ?? "").split(",")) {
			const assetPath = writingMediaPath(candidate.trim().split(/\s+/u)[0]);
			if (assetPath) paths.add(assetPath);
		}
		const sourcePath = writingMediaPath(nodeAttributes.src ?? "");
		if (sourcePath) paths.add(sourcePath);
	});
	return paths;
}

function referencedFile(value, relativeToFile) {
	try {
		const pathname = decodeURIComponent(
			new URL(value, "https://build.invalid/").pathname,
		);
		for (const [relative, file] of relativeToFile) {
			if (pathname === `/${relative}` || pathname.endsWith(`/${relative}`)) {
				return file;
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

async function initialJavaScriptBytes(htmlDocuments, relativeToFile, failures) {
	let maximumBytes = 0;
	for (const [file, document] of htmlDocuments) {
		const scriptParts = [];
		const externalScripts = new Set();
		visit(document, (node) => {
			if (node.tagName !== "script") return;
			const nodeAttributes = attributes(node);
			if (
				nodeAttributes.type === "application/ld+json" ||
				nodeAttributes.type === "application/json"
			) {
				return;
			}
			if (nodeAttributes.src) {
				const scriptFile = referencedFile(nodeAttributes.src, relativeToFile);
				if (scriptFile) externalScripts.add(scriptFile);
				else if (!/^https?:/iu.test(nodeAttributes.src)) {
					failures.push(
						`initial script reference does not resolve in dist: ${nodeAttributes.src}`,
					);
				}
				return;
			}
			const source = (node.childNodes ?? [])
				.map((child) => child.value ?? "")
				.join("");
			if (source.trim()) scriptParts.push(Buffer.from(source));
		});
		for (const scriptFile of externalScripts) {
			scriptParts.push(await readFile(scriptFile));
		}
		const pageBytes = scriptParts.reduce(
			(total, bytes) => total + gzipSync(bytes).byteLength,
			0,
		);
		maximumBytes = Math.max(maximumBytes, pageBytes);
		if (!Number.isFinite(pageBytes)) {
			failures.push(`could not measure initial JavaScript for ${file}`);
		}
	}
	return maximumBytes;
}

async function homepageInitialImageBytes(
	homeDocument,
	relativeToFile,
	failures,
) {
	if (!homeDocument) {
		failures.push("homepage HTML is missing for initial image verification");
		return 0;
	}
	const initialImages = [];
	visit(homeDocument, (node) => {
		if (node.tagName !== "img") return;
		const nodeAttributes = attributes(node);
		if (
			nodeAttributes.loading !== "lazy" ||
			nodeAttributes.fetchpriority === "high"
		) {
			initialImages.push({ node, attributes: nodeAttributes });
		}
	});
	const eagerImages = initialImages.filter(
		(image) => image.attributes.loading === "eager",
	);
	const priorityImages = initialImages.filter(
		(image) => image.attributes.fetchpriority === "high",
	);
	if (
		initialImages.length !== 1 ||
		eagerImages.length !== 1 ||
		priorityImages.length !== 1 ||
		eagerImages[0]?.node !== priorityImages[0]?.node
	) {
		failures.push(
			`homepage must have exactly one initially loaded eager/high-priority image (initial=${initialImages.length}, eager=${eagerImages.length}, high=${priorityImages.length})`,
		);
	}

	let worstCaseBytes = 0;
	for (const { node, attributes: imageAttributes } of initialImages) {
		const candidateGroups = [];
		const picture =
			node.parentNode?.tagName === "picture" ? node.parentNode : undefined;
		if (picture) {
			for (const child of picture.childNodes ?? []) {
				if (child.tagName !== "source") continue;
				const sourceAttributes = attributes(child);
				candidateGroups.push(
					sourceAttributes.srcset ?? sourceAttributes.src ?? "",
				);
			}
		}
		candidateGroups.push(imageAttributes.srcset ?? imageAttributes.src ?? "");

		let imageWorstCaseBytes = 0;
		for (const candidates of candidateGroups) {
			let groupWorstCaseBytes = 0;
			for (const candidate of candidates.split(",")) {
				const candidateUrl = candidate.trim().split(/\s+/u)[0];
				if (!candidateUrl) continue;
				const candidateFile = referencedFile(candidateUrl, relativeToFile);
				if (!candidateFile) {
					failures.push(
						`homepage initial image candidate does not resolve in dist: ${candidateUrl}`,
					);
					continue;
				}
				groupWorstCaseBytes = Math.max(
					groupWorstCaseBytes,
					(await stat(candidateFile)).size,
				);
			}
			imageWorstCaseBytes = Math.max(imageWorstCaseBytes, groupWorstCaseBytes);
		}
		worstCaseBytes += imageWorstCaseBytes;
	}
	return worstCaseBytes;
}

function parseArguments(argv) {
	const options = { dist: DEFAULT_DIST, repoRoot: process.cwd() };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--dist" || argument === "--repo-root") {
			const value = argv[index + 1];
			if (!value) throw new Error(`${argument} requires a value`);
			options[argument === "--dist" ? "dist" : "repoRoot"] = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}
	return options;
}

export async function inspectBuiltImages({
	dist = DEFAULT_DIST,
	repoRoot: repoRootValue = process.cwd(),
	files: providedFiles,
	limits: limitOverrides = {},
} = {}) {
	const distRoot = path.resolve(dist);
	const repoRoot = path.resolve(repoRootValue);
	const limits = { ...DEFAULT_IMAGE_LIMITS, ...limitOverrides };
	const failures = [];
	const files = providedFiles ?? (await walk(distRoot));
	const readJson = async (...segments) =>
		JSON.parse(await readFile(path.join(repoRoot, ...segments), "utf8"));
	const [archiveManifest, mediumManifest, firstPartyManifest, catalog] =
		await Promise.all([
			readJson("provenance", "tai-song", "manifest.json"),
			readJson("provenance", "medium", "manifest.json"),
			readJson("provenance", "first-party", "manifest.json"),
			readJson("provenance", "publication-catalog.json"),
		]);
	const archiveBySlug = new Map(
		(archiveManifest.articles ?? []).map((article) => [article.slug, article]),
	);
	const mediumBySlug = new Map(
		(mediumManifest.articles ?? []).map((article) => [article.slug, article]),
	);
	const firstPartyBySlug = new Map(
		(firstPartyManifest.articles ?? []).map((article) => [
			article.slug,
			article,
		]),
	);
	const articles = (catalog.entries ?? []).map((entry) => {
		let source;
		if (entry.source === "tai-song") source = archiveBySlug.get(entry.slug);
		else if (entry.source === "medium") source = mediumBySlug.get(entry.slug);
		else if (entry.source === "first-party")
			source = firstPartyBySlug.get(entry.slug);
		else failures.push(`publication source is unsupported for ${entry.slug}`);
		const assets =
			entry.source === "tai-song"
				? source
					? [
							{
								id: "hero",
								role: "hero",
								path: source.paths?.image,
								...source.image,
							},
						]
					: []
				: (source?.assets ?? []).map((asset) => ({
						...asset,
						id: asset.id ?? path.basename(asset.path, path.extname(asset.path)),
					}));
		const image = assets.find((asset) => asset.role === "hero");
		if (!source || !image)
			failures.push(`publication image evidence is missing for ${entry.slug}`);
		return { slug: entry.slug, image, assets };
	});
	const slugs = articles.map((article) => article.slug);
	if (articles.length < 11 || new Set(slugs).size !== articles.length)
		failures.push(
			"image publication catalog must contain at least eleven unique slugs",
		);

	const originalHashes = new Set(
		[
			...(archiveManifest.articles ?? []).map((article) => article.image),
			...(mediumManifest.articles ?? []).flatMap(
				(article) => article.assets ?? [],
			),
			...(firstPartyManifest.articles ?? []).flatMap(
				(article) => article.assets ?? [],
			),
		]
			.map((image) => String(image?.sha256 ?? "").replace(/^sha256:/u, ""))
			.filter(Boolean),
	);
	const expectedSocialImages = new Set(
		slugs.map((slug) => `social/${slug}.jpg`),
	);
	const expectedBodyImages = new Map();
	const bodyAssetsById = new Map();
	for (const article of articles) {
		if (
			!article.image ||
			!Number.isSafeInteger(article.image.width) ||
			article.image.width <= 0 ||
			!Number.isSafeInteger(article.image.height) ||
			article.image.height <= 0
		) {
			failures.push(
				`publication hero dimensions are invalid for ${article.slug}`,
			);
		}
		for (const asset of article.assets.filter(
			(asset) => asset.role === "body",
		)) {
			const stableId = `${article.slug}/${asset.id}`;
			if (bodyAssetsById.has(stableId))
				failures.push(`publication body image ID is duplicated: ${stableId}`);
			bodyAssetsById.set(stableId, asset);
			for (const width of responsiveBodyImageWidths(asset.width)) {
				for (const format of ["avif", "webp"]) {
					const relative = bodyImageOutputPath(
						article.slug,
						asset.id,
						width,
						format,
					);
					if (expectedBodyImages.has(relative)) {
						failures.push(
							`publication body image path is duplicated: ${relative}`,
						);
					}
					expectedBodyImages.set(relative, {
						width,
						ratio: asset.width / asset.height,
						stableId,
					});
				}
			}
		}
	}
	const relativeByFile = new Map(
		files.map((file) => [file, normalizePath(path.relative(distRoot, file))]),
	);
	const relativeToFile = new Map(
		[...relativeByFile].map(([file, relative]) => [relative, file]),
	);
	const imageFiles = files.filter((file) => IMAGE_EXTENSION.test(file));
	const emittedImages = imageFiles.map((file) => relativeByFile.get(file));
	const emittedImageSet = new Set(emittedImages);

	const textParts = [];
	const htmlDocuments = new Map();
	for (const file of files) {
		if (!TEXT_EXTENSION.test(file) || IMAGE_EXTENSION.test(file)) continue;
		try {
			const text = await readFile(file, "utf8");
			textParts.push(text);
			if (file.endsWith(".html")) htmlDocuments.set(file, parse(text));
		} catch {
			failures.push(
				`built image reference source could not be read: ${relativeByFile.get(file)}`,
			);
		}
	}
	const referenceCorpus = textParts.join("\n");
	const manifestSlugSet = new Set(slugs);
	const manifestResponsiveImages = new Set();
	const responsiveImageOwners = new Map();
	const sourceAspectRatios = new Map(
		articles.map((article) => [
			article.slug,
			article.image?.width > 0 && article.image?.height > 0
				? article.image.width / article.image.height
				: undefined,
		]),
	);
	sourceAspectRatios.set("podcast-cover", 1);
	const bindResponsiveImage = (assetPath, slug) => {
		manifestResponsiveImages.add(assetPath);
		const owners = responsiveImageOwners.get(assetPath) ?? new Set();
		owners.add(slug);
		responsiveImageOwners.set(assetPath, owners);
	};
	const heroSlugs = new Set();
	const bodyMarkerCounts = new Map();
	const renderedBodyImages = new Set();
	let podcastArtworkMarkers = 0;
	const podcastRouteFile = path.join(
		distRoot,
		"podcast",
		"modular-ethics",
		"index.html",
	);
	const podcastPublished = htmlDocuments.has(podcastRouteFile);
	for (const [file, document] of htmlDocuments) {
		const relative = relativeByFile.get(file);
		const articleMatch = relative.match(/^posts\/([^/]+)\/index\.html$/u);
		visit(document, (node) => {
			const nodeAttributes = attributes(node);
			const writingAssetId = nodeAttributes["data-writing-asset-id"];
			if (writingAssetId) {
				bodyMarkerCounts.set(
					writingAssetId,
					(bodyMarkerCounts.get(writingAssetId) ?? 0) + 1,
				);
				if (!bodyAssetsById.has(writingAssetId)) {
					failures.push(
						`rendered body image lacks publication evidence: ${writingAssetId}`,
					);
				} else {
					const [approvedSlug] = writingAssetId.split("/");
					if (articleMatch?.[1] !== approvedSlug) {
						failures.push(
							`body image is rendered outside its approved article: ${writingAssetId}`,
						);
					}
					const renderedPaths = writingMediaPathsFromNode(node);
					if (renderedPaths.size === 0) {
						failures.push(
							`body image has no same-origin responsive sources: ${writingAssetId}`,
						);
					}
					for (const assetPath of renderedPaths) {
						if (expectedBodyImages.get(assetPath)?.stableId !== writingAssetId)
							failures.push(
								`body image path is not bound to its approved asset: ${assetPath}`,
							);
						else renderedBodyImages.add(assetPath);
					}
				}
			}
			const podcastArtwork = nodeAttributes["data-podcast-artwork"];
			if (podcastArtwork !== undefined) {
				if (podcastArtwork !== `sha256:${PODCAST_COVER_SHA256}`) {
					failures.push("podcast artwork marker has an unapproved digest");
					return;
				}
				podcastArtworkMarkers += 1;
				if (file !== podcastRouteFile) {
					failures.push(
						"podcast artwork is rendered outside its episode route",
					);
				}
				const responsivePaths = responsivePathsFromNode(node);
				if (responsivePaths.size === 0) {
					failures.push(
						"podcast artwork has no same-origin responsive sources",
					);
				}
				for (const assetPath of responsivePaths) {
					bindResponsiveImage(assetPath, "podcast-cover");
				}
			}
			const editorialSlug = nodeAttributes["data-editorial-slug"];
			if (editorialSlug) {
				if (!manifestSlugSet.has(editorialSlug)) {
					failures.push(
						`responsive editorial image is bound to a non-manifest slug: ${editorialSlug}`,
					);
				} else {
					const responsivePaths = responsivePathsFromNode(node);
					if (responsivePaths.size === 0) {
						failures.push(
							`editorial image has no same-origin responsive sources: ${editorialSlug}`,
						);
					}
					for (const assetPath of responsivePaths) {
						bindResponsiveImage(assetPath, editorialSlug);
					}
				}
			}
			if (
				articleMatch &&
				manifestSlugSet.has(articleMatch[1]) &&
				nodeAttributes["data-image-variant"] === "hero"
			) {
				heroSlugs.add(articleMatch[1]);
				const responsivePaths = responsivePathsFromNode(node);
				if (responsivePaths.size === 0) {
					failures.push(
						`article hero has no same-origin responsive sources: ${articleMatch[1]}`,
					);
				}
				for (const assetPath of responsivePaths) {
					bindResponsiveImage(assetPath, articleMatch[1]);
				}
			}
		});
	}
	for (const slug of slugs) {
		if (!heroSlugs.has(slug)) {
			failures.push(
				`manifest article hero is missing from built HTML: ${slug}`,
			);
		}
	}
	for (const stableId of bodyAssetsById.keys()) {
		if (bodyMarkerCounts.get(stableId) !== 1) {
			failures.push(
				`approved body image must render exactly once: ${stableId} (rendered ${bodyMarkerCounts.get(stableId) ?? 0})`,
			);
		}
	}
	for (const relative of expectedBodyImages.keys()) {
		if (!renderedBodyImages.has(relative)) {
			failures.push(`responsive body image is not rendered: ${relative}`);
		}
	}
	if (podcastPublished && podcastArtworkMarkers !== 1) {
		failures.push(
			`published podcast must render one approved artwork marker (rendered ${podcastArtworkMarkers})`,
		);
	}
	if (!podcastPublished && podcastArtworkMarkers !== 0) {
		failures.push(
			"draft podcast artwork was rendered without an episode route",
		);
	}

	let totalDistBytes = 0;
	let distBytes = 0;
	let responsiveBytes = 0;
	let socialBytes = 0;
	for (const file of files) {
		const fileStat = await stat(file);
		totalDistBytes += fileStat.size;
		if (!AUDIO_EXTENSION.test(file)) distBytes += fileStat.size;
	}
	const initialJavaScriptGzipBytes = await initialJavaScriptBytes(
		htmlDocuments,
		relativeToFile,
		failures,
	);
	const homepageInitialImageBytesValue = await homepageInitialImageBytes(
		htmlDocuments.get(path.join(distRoot, "index.html")),
		relativeToFile,
		failures,
	);
	if (distBytes > limits.distBytes) {
		failures.push(
			`non-audio built artifact is ${distBytes} bytes; budget is ${limits.distBytes} bytes`,
		);
	}
	if (initialJavaScriptGzipBytes > limits.initialJavaScriptGzipBytes) {
		failures.push(
			`compressed JavaScript is ${initialJavaScriptGzipBytes} bytes; budget is ${limits.initialJavaScriptGzipBytes} bytes`,
		);
	}
	if (homepageInitialImageBytesValue > limits.homepageDesktopImageBytes) {
		failures.push(
			`homepage initial desktop images are ${homepageInitialImageBytesValue} bytes; budget is ${limits.homepageDesktopImageBytes} bytes`,
		);
	}
	if (homepageInitialImageBytesValue > limits.homepageMobileImageBytes) {
		failures.push(
			`homepage initial mobile images are ${homepageInitialImageBytesValue} bytes; budget is ${limits.homepageMobileImageBytes} bytes`,
		);
	}

	for (const file of imageFiles) {
		const relative = relativeByFile.get(file);
		const bytes = await readFile(file);
		const fileHash = sha256(bytes);
		if (originalHashes.has(fileHash)) {
			failures.push(`archival original image leaked into dist: ${relative}`);
		}
		if (!referenceCorpus.includes(path.basename(file))) {
			failures.push(`built image is not referenced by any output: ${relative}`);
		}

		if (relative === "mark.svg") continue;
		if (relative === PODCAST_COVER_PATH) {
			const metadata = await sharp(bytes).metadata();
			if (
				fileHash !== PODCAST_COVER_SHA256 ||
				metadata.format !== "png" ||
				metadata.width !== 3000 ||
				metadata.height !== 3000 ||
				metadata.hasAlpha === true ||
				metadata.space !== "srgb"
			) {
				failures.push(
					`podcast cover differs from approved evidence: ${relative}`,
				);
			}
			if (!podcastPublished) {
				failures.push(`draft podcast cover leaked into dist: ${relative}`);
			}
			continue;
		}
		if (relative === SITE_SOCIAL_IMAGE) {
			const metadata = await sharp(bytes).metadata();
			socialBytes += bytes.byteLength;
			if (
				metadata.format !== "jpeg" ||
				metadata.width !== 1200 ||
				metadata.height !== 630
			) {
				failures.push(`site social image must be 1200x630 JPEG: ${relative}`);
			}
			if (bytes.byteLength > limits.socialBytes) {
				failures.push(
					`site social image exceeds ${limits.socialBytes} bytes: ${relative} (${bytes.byteLength})`,
				);
			}
			continue;
		}
		if (expectedSocialImages.has(relative)) {
			const metadata = await sharp(bytes).metadata();
			socialBytes += bytes.byteLength;
			if (
				metadata.format !== "jpeg" ||
				metadata.width !== 1200 ||
				metadata.height !== 1200
			) {
				failures.push(`social image must be 1200x1200 JPEG: ${relative}`);
			}
			if (bytes.byteLength > limits.socialBytes) {
				failures.push(
					`social image exceeds ${limits.socialBytes} bytes: ${relative} (${bytes.byteLength})`,
				);
			}
			continue;
		}
		if (expectedBodyImages.has(relative)) {
			const expected = expectedBodyImages.get(relative);
			const metadata = await sharp(bytes).metadata();
			const expectedFormat = relative.endsWith(".avif") ? "heif" : "webp";
			const actualRatio = metadata.width / metadata.height;
			if (
				metadata.format !== expectedFormat ||
				metadata.width !== expected.width ||
				!metadata.height ||
				Math.abs(actualRatio - expected.ratio) > 1 / metadata.height
			) {
				failures.push(
					`responsive body image differs from its approved source: ${relative}`,
				);
			}
			responsiveBytes += bytes.byteLength;
			continue;
		}

		if (!/^_astro\/[^/]+\.(?:avif|webp)$/u.test(relative)) {
			failures.push(`image is outside the publication allowlist: ${relative}`);
			continue;
		}
		if (!manifestResponsiveImages.has(relative)) {
			failures.push(
				`responsive image is not bound to a manifest article source: ${relative}`,
			);
		}
		const metadata = await sharp(bytes).metadata();
		responsiveBytes += bytes.byteLength;
		const formatMatchesExtension = relative.endsWith(".avif")
			? metadata.format === "heif"
			: metadata.format === "webp";
		if (
			!formatMatchesExtension ||
			!RESPONSIVE_WIDTHS.has(metadata.width) ||
			!metadata.height
		) {
			failures.push(
				`responsive image has an unexpected format or dimensions: ${relative}`,
			);
		}
		const actualRatio = metadata.width / metadata.height;
		const owners = [...(responsiveImageOwners.get(relative) ?? [])];
		const ownerRatios = owners.map((slug) => sourceAspectRatios.get(slug));
		if (
			owners.length === 0 ||
			ownerRatios.some((ratio) => !Number.isFinite(ratio)) ||
			ownerRatios.some(
				(ratio) => Math.abs(actualRatio - ratio) > 1 / metadata.height,
			)
		)
			failures.push(
				`responsive image aspect ratio differs from its approved source: ${relative}`,
			);
		if (metadata.width <= 640 && bytes.byteLength > limits.cardBytes) {
			failures.push(
				`card-sized image exceeds ${limits.cardBytes} bytes: ${relative} (${bytes.byteLength})`,
			);
		}
	}

	for (const relative of expectedSocialImages) {
		if (!emittedImageSet.has(relative)) {
			failures.push(`required social image is missing: ${relative}`);
		}
	}
	for (const relative of expectedBodyImages.keys()) {
		if (!emittedImageSet.has(relative)) {
			failures.push(`required responsive body image is missing: ${relative}`);
		}
	}
	for (const relative of manifestResponsiveImages) {
		if (!emittedImageSet.has(relative)) {
			failures.push(`referenced responsive image is missing: ${relative}`);
		}
	}
	if (podcastPublished && !emittedImageSet.has(PODCAST_COVER_PATH)) {
		failures.push(`published podcast cover is missing: ${PODCAST_COVER_PATH}`);
	}
	if (!podcastPublished && emittedImageSet.has(PODCAST_COVER_PATH)) {
		failures.push(`draft podcast cover is present: ${PODCAST_COVER_PATH}`);
	}
	if (!emittedImageSet.has(SITE_SOCIAL_IMAGE)) {
		failures.push(
			`required site social image is missing: ${SITE_SOCIAL_IMAGE}`,
		);
	}
	if (!emittedImageSet.has("mark.svg")) {
		failures.push("vector project mark is missing: mark.svg");
	}
	if (!imageFiles.some((file) => file.endsWith(".avif"))) {
		failures.push("no responsive AVIF images were emitted");
	}
	if (!imageFiles.some((file) => file.endsWith(".webp"))) {
		failures.push("no responsive WebP fallback images were emitted");
	}

	return {
		failures,
		stats: {
			distBytes,
			totalDistBytes,
			imageCount: imageFiles.length,
			responsiveBytes,
			socialBytes,
			initialJavaScriptGzipBytes,
			homepageInitialImageBytes: homepageInitialImageBytesValue,
		},
	};
}

export async function verifyBuiltImages(options = {}) {
	const result = await inspectBuiltImages(options);
	if (result.failures.length > 0) {
		throw new Error(
			`Built-image verification failed:\n- ${result.failures.join("\n- ")}`,
		);
	}
	return result.stats;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	try {
		const stats = await verifyBuiltImages(
			parseArguments(process.argv.slice(2)),
		);
		console.log(
			`Built-image verification passed: ${stats.imageCount} images, ${stats.distBytes} non-audio bytes, ${stats.initialJavaScriptGzipBytes} compressed JavaScript bytes`,
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
