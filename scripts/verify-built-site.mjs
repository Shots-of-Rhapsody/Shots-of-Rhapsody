import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { parse, parseFragment } from "parse5";
import { inspectPng, sha256 } from "./archive/lib/integrity.js";
import { bodyTextSha256, renderBodyHtml } from "./archive/lib/render.js";
import { evaluateReviewSignoffs } from "./archive/lib/review-signoff.js";

const DEFAULT_DIST = "dist";
const DEFAULT_SITE = "https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/";
const EXPECTED_ARCHIVE_COUNT = 11;
const REQUIRED_NON_POST_ROUTES = [
	"",
	"2/",
	"about/",
	"archive/",
	"authors/tai-song/",
	"content-license/",
];
const EXPECTED_DRAFT_POST_PATHS = [
	"src/content/posts/guide/index.md",
	"src/content/posts/video.md",
	"src/content/posts/Modular Ethics/Modular Ethics.md",
	"src/content/posts/The Last Cup/The Last Cup.md",
];
const AUDIO_ARTIFACT_PATTERN = /\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/iu;

export function parseArguments(argv) {
	const options = {
		dist: DEFAULT_DIST,
		site: DEFAULT_SITE,
		requireSignoff: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--require-signoff") {
			options.requireSignoff = true;
			continue;
		}
		if (argument === "--dist" || argument === "--site") {
			const value = argv[index + 1];
			if (!value) throw new Error(`${argument} requires a value`);
			options[argument.slice(2)] = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}
	return options;
}

async function walk(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(entryPath)));
		else if (entry.isFile()) files.push(entryPath);
	}
	return files;
}

function decodeHtml(value) {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#(\d+);/g, (_, codePoint) =>
			String.fromCodePoint(Number(codePoint)),
		)
		.replace(/&#x([0-9a-f]+);/gi, (_, codePoint) =>
			String.fromCodePoint(Number.parseInt(codePoint, 16)),
		);
}

function visibleText(markup) {
	return decodeHtml(markup.replace(/<[^>]*>/g, ""));
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markedField(html, field) {
	const escapedField = escapeRegExp(field);
	const match = html.match(
		new RegExp(
			`<([a-z][a-z0-9]*)\\b[^>]*data-archive-field=["']${escapedField}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
			"i",
		),
	);
	return match ? visibleText(match[2]) : undefined;
}

function elementsWithAttribute(root, name) {
	const matches = [];
	const visit = (node) => {
		if (node.attrs?.some((attribute) => attribute.name === name)) {
			matches.push(node);
		}
		for (const child of node.childNodes ?? []) visit(child);
	};
	visit(root);
	return matches;
}

function normalizedArchiveNode(node) {
	if (node.nodeName === "#text") return ["text", node.value];
	if (node.nodeName === "#comment") return ["comment", node.data];
	if (!node.tagName) return [node.nodeName];
	return [
		"element",
		node.tagName,
		(node.attrs ?? [])
			.map((attribute) => [attribute.name, attribute.value])
			.sort(([left], [right]) => left.localeCompare(right)),
		(node.childNodes ?? []).map(normalizedArchiveNode),
	];
}

function archiveBodyStructureFromNodes(nodes) {
	return nodes
		.filter((node) => node.nodeName !== "#text" || /\S/u.test(node.value ?? ""))
		.map(normalizedArchiveNode);
}

export function archiveBodyStructure(value) {
	return archiveBodyStructureFromNodes(parseFragment(String(value)).childNodes);
}

function canonicalBodyHtml(value) {
	return String(value)
		.replace(/\r\n?/g, "\n")
		.replace(/>\s+</g, "><")
		.replace(/<br\s*\/?\s*>/gi, "<br>")
		.trim();
}

function exactSha256(value) {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
		? value
		: undefined;
}

function isoString(value) {
	if (value === null || value === undefined || value === "") return undefined;
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function samePublication(left, right) {
	if (left === undefined || right === undefined) return left === right;
	return (
		isPlainObject(left) &&
		isPlainObject(right) &&
		Object.keys(left).length === 2 &&
		Object.keys(right).length === 2 &&
		left.platform === right.platform &&
		left.url === right.url
	);
}

function resolveManifestPath(repoRoot, rawPath, label, failures) {
	if (typeof rawPath !== "string" || rawPath.length === 0) {
		failures.push(`${label}: manifest path is missing`);
		return undefined;
	}
	const resolved = path.resolve(
		repoRoot,
		...rawPath.replace(/\\/g, "/").split("/"),
	);
	const relative = path.relative(repoRoot, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		failures.push(`${label}: manifest path escapes the repository`);
		return undefined;
	}
	return resolved;
}

function hasPrivateProtonReference(value) {
	if (typeof value === "string") {
		return /https?:\/\/[^\s"'<>]*proton[^\s"'<>]*/i.test(value);
	}
	if (Array.isArray(value)) return value.some(hasPrivateProtonReference);
	if (!isPlainObject(value)) return false;
	return Object.entries(value).some(
		([key, child]) =>
			/(?:proton|document|doc).*(?:id|url)|(?:id|url).*(?:proton|document|doc)/i.test(
				key,
			) || hasPrivateProtonReference(child),
	);
}

function xmlElementText(xml, name) {
	const escapedName = escapeRegExp(name);
	const match = xml.match(
		new RegExp(
			`<${escapedName}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${escapedName}>`,
		),
	);
	return match ? decodeHtml(match[1]) : undefined;
}

function attributes(tag) {
	const result = {};
	const expression =
		/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	for (const match of tag.matchAll(expression)) {
		result[match[1].toLowerCase()] = decodeHtml(
			match[2] ?? match[3] ?? match[4] ?? "",
		);
	}
	return result;
}

function tags(html, name) {
	return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map(
		(match) => ({ raw: match[0], attributes: attributes(match[0]) }),
	);
}

function normalizedPath(value) {
	return value.replace(/\\/gu, "/");
}

function sortedUnique(values) {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function compareExactValues(actualValues, expectedValues, label, failures) {
	const actual = sortedUnique(actualValues);
	const expected = sortedUnique(expectedValues);
	if (actualValues.length !== actual.length) {
		failures.push(`${label} contains duplicate entries`);
	}
	for (const value of expected) {
		if (!actual.includes(value)) failures.push(`${label} is missing ${value}`);
	}
	for (const value of actual) {
		if (!expected.includes(value))
			failures.push(`${label} unexpectedly includes ${value}`);
	}
}

function manifestPostUrls(manifest, site) {
	return manifest.articles.map((article) =>
		new URL(`posts/${article.slug}/`, site).toString(),
	);
}

export function frontmatterDraftValue(markdown) {
	const match = String(markdown).match(
		/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u,
	);
	if (!match) return undefined;
	const values = [...match[1].matchAll(/^draft:\s*(true|false)\s*$/gmu)];
	if (values.length !== 1) return undefined;
	return values[0][1] === "true";
}

export function markedAttributeValues(html, tagName, attributeName) {
	return tags(html, tagName)
		.map((tag) => tag.attributes[attributeName])
		.filter((value) => typeof value === "string" && value.length > 0);
}

export function validateRobotsText(text, siteValue = DEFAULT_SITE) {
	const site = new URL(siteValue);
	if (!site.pathname.endsWith("/")) site.pathname += "/";
	const expectedSitemap = new URL("sitemap-index.xml", site).toString();
	const failures = [];
	const normalized = String(text).replace(/\r\n?/gu, "\n").trim();
	const expected = `User-agent: *\nAllow: /\n\nSitemap: ${expectedSitemap}`;
	if (normalized !== expected) {
		failures.push("robots.txt does not match the base-aware launch policy");
	}
	if (/^\s*Disallow:/gimu.test(normalized)) {
		failures.push("robots.txt must not disallow public site resources");
	}
	if (/_astro/iu.test(normalized)) {
		failures.push("robots.txt must not block Astro assets");
	}
	return failures;
}

function expectedPageUrl(filePath, distRoot, site) {
	const relativePath = path.relative(distRoot, filePath).replace(/\\/g, "/");
	if (relativePath === "index.html") return site.toString();
	if (relativePath.endsWith("/index.html")) {
		return new URL(
			relativePath.slice(0, -"index.html".length),
			site,
		).toString();
	}
	return new URL(relativePath, site).toString();
}

function getCanonical(html, label, failures) {
	const canonicals = tags(html, "link").filter((tag) =>
		tag.attributes.rel?.split(/\s+/).includes("canonical"),
	);
	if (canonicals.length !== 1 || !canonicals[0].attributes.href) {
		failures.push(`${label}: expected exactly one canonical link`);
		return undefined;
	}
	return canonicals[0].attributes.href;
}

function metaContent(html, selector) {
	const matches = tags(html, "meta").filter(
		(tag) =>
			tag.attributes.name === selector || tag.attributes.property === selector,
	);
	return matches.map((tag) => tag.attributes.content);
}

async function isFile(filePath) {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function resolveBuiltUrl(
	rawValue,
	pageUrl,
	distRoot,
	site,
	label,
	failures,
) {
	if (!rawValue || /^(?:#|mailto:|tel:|data:|javascript:)/i.test(rawValue))
		return;
	let target;
	try {
		target = new URL(decodeHtml(rawValue), pageUrl);
	} catch {
		failures.push(`${label}: invalid URL ${rawValue}`);
		return;
	}
	if (target.origin !== site.origin) return;

	const basePath = site.pathname.endsWith("/")
		? site.pathname
		: `${site.pathname}/`;
	if (
		target.pathname !== basePath.slice(0, -1) &&
		!target.pathname.startsWith(basePath)
	) {
		failures.push(
			`${label}: same-origin URL escapes the configured base path: ${target}`,
		);
		return;
	}

	let relativePath =
		target.pathname === basePath.slice(0, -1)
			? ""
			: target.pathname.slice(basePath.length);
	try {
		relativePath = decodeURIComponent(relativePath);
	} catch {
		failures.push(
			`${label}: URL path is not valid percent-encoding: ${target}`,
		);
		return;
	}
	const candidates =
		relativePath.endsWith("/") || relativePath === ""
			? [path.join(distRoot, relativePath, "index.html")]
			: [
					path.join(distRoot, relativePath),
					path.join(distRoot, relativePath, "index.html"),
				];
	if (
		!(await Promise.any(
			candidates.map(async (candidate) => {
				if (!(await isFile(candidate))) throw new Error("missing");
				return candidate;
			}),
		).catch(() => undefined))
	) {
		failures.push(`${label}: built target is missing for ${target}`);
	}
}

function extractJsonLd(html, label, failures) {
	const scripts = [
		...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
	].filter((match) => attributes(match[1]).type === "application/ld+json");
	if (scripts.length !== 1) {
		failures.push(`${label}: expected exactly one JSON-LD script`);
		return undefined;
	}
	try {
		return JSON.parse(scripts[0][2]);
	} catch (error) {
		failures.push(`${label}: invalid JSON-LD (${error.message})`);
		return undefined;
	}
}

async function verifyHtml(filePath, distRoot, site, failures, postPages) {
	const relativePath = path.relative(distRoot, filePath).replace(/\\/g, "/");
	if (relativePath.startsWith("pagefind/")) return;
	const html = await readFile(filePath, "utf8");
	const pageUrl = expectedPageUrl(filePath, distRoot, site);
	const canonical = getCanonical(html, relativePath, failures);
	if (canonical !== pageUrl) {
		failures.push(
			`${relativePath}: canonical ${canonical ?? "<missing>"} does not equal ${pageUrl}`,
		);
	}
	if (canonical?.startsWith("https://vocal.media/")) {
		failures.push(`${relativePath}: Vocal must not be the canonical URL`);
	}
	if (/\bdata-vocal-/i.test(html)) {
		failures.push(
			`${relativePath}: legacy data-vocal markers remain in output`,
		);
	}
	if (hasPrivateProtonReference(html)) {
		failures.push(`${relativePath}: output exposes a private Proton URL or ID`);
	}

	for (const selector of [
		"description",
		"author",
		"og:url",
		"og:title",
		"og:description",
	]) {
		const values = metaContent(html, selector);
		if (values.length !== 1 || !values[0]) {
			failures.push(
				`${relativePath}: expected one nonempty ${selector} meta value`,
			);
		}
	}
	for (const selector of ["og:url", "twitter:url"]) {
		const values = metaContent(html, selector);
		if (values.length !== 1 || values[0] !== canonical) {
			failures.push(
				`${relativePath}: ${selector} must equal the canonical URL`,
			);
		}
	}
	for (const selector of ["og:image", "twitter:image"]) {
		for (const imageUrl of metaContent(html, selector)) {
			await resolveBuiltUrl(
				imageUrl,
				pageUrl,
				distRoot,
				site,
				`${relativePath} ${selector}`,
				failures,
			);
		}
	}

	const urlAttributes = [];
	for (const tagName of ["a", "link", "script", "img", "source"]) {
		for (const tag of tags(html, tagName)) {
			for (const attributeName of ["href", "src"]) {
				if (tag.attributes[attributeName]) {
					urlAttributes.push([
						tag.attributes[attributeName],
						`${relativePath} ${tagName}[${attributeName}]`,
					]);
				}
			}
			if (tag.attributes.srcset) {
				for (const candidate of tag.attributes.srcset.split(",")) {
					const candidateUrl = candidate.trim().split(/\s+/)[0];
					if (candidateUrl)
						urlAttributes.push([
							candidateUrl,
							`${relativePath} ${tagName}[srcset]`,
						]);
				}
			}
		}
	}
	for (const [target, label] of urlAttributes) {
		await resolveBuiltUrl(target, pageUrl, distRoot, site, label, failures);
	}

	if (
		relativePath.startsWith("posts/") &&
		relativePath.endsWith("/index.html")
	) {
		postPages.push(pageUrl);
		const jsonLd = extractJsonLd(html, relativePath, failures);
		if (!jsonLd) return;
		if (jsonLd["@type"] !== "BlogPosting")
			failures.push(`${relativePath}: JSON-LD type is not BlogPosting`);
		if (!jsonLd.headline || !jsonLd.author?.name || !jsonLd.datePublished) {
			failures.push(
				`${relativePath}: JSON-LD lacks headline, author, or publication date`,
			);
		}
		if (
			jsonLd.url !== canonical ||
			jsonLd.mainEntityOfPage?.["@id"] !== canonical
		) {
			failures.push(
				`${relativePath}: JSON-LD page URLs do not equal the canonical URL`,
			);
		}
		if (jsonLd.image) {
			for (const key of ["url", "contentUrl"]) {
				if (!jsonLd.image[key])
					failures.push(`${relativePath}: JSON-LD image.${key} is missing`);
				else
					await resolveBuiltUrl(
						jsonLd.image[key],
						pageUrl,
						distRoot,
						site,
						`${relativePath} JSON-LD image.${key}`,
						failures,
					);
			}
		}
	}
}

async function verifyRss(distRoot, site, failures, postPages) {
	const rssPath = path.join(distRoot, "rss.xml");
	if (!(await isFile(rssPath))) {
		failures.push("rss.xml is missing");
		return;
	}
	const xml = await readFile(rssPath, "utf8");
	if (!/<rss\b/.test(xml) || !/<channel>/.test(xml))
		failures.push("rss.xml is not an RSS channel");
	if (/<dc:source(?:\s|>)/i.test(xml))
		failures.push("rss.xml must not publish dc:source provenance");
	if (hasPrivateProtonReference(xml))
		failures.push("rss.xml exposes a private Proton URL or ID");
	const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(
		(match) => match[1],
	);
	if (itemBlocks.length !== postPages.length) {
		failures.push(
			`rss.xml has ${itemBlocks.length} items but ${postPages.length} post pages were built`,
		);
	}
	const rssLinks = [];
	for (const [index, item] of itemBlocks.entries()) {
		const link = xmlElementText(item, "link");
		if (!link) {
			failures.push(`rss.xml item ${index + 1} has no link`);
			continue;
		}
		let absolute;
		try {
			absolute = new URL(decodeHtml(link));
		} catch {
			failures.push(`rss.xml item ${index + 1} link is not absolute: ${link}`);
			continue;
		}
		rssLinks.push(absolute.toString());
		const guid = xmlElementText(item, "guid");
		if (guid !== absolute.toString()) {
			failures.push(
				`rss.xml item ${index + 1} GUID does not equal its local link`,
			);
		}
		await resolveBuiltUrl(
			absolute.toString(),
			site,
			distRoot,
			site,
			`rss.xml item ${index + 1}`,
			failures,
		);
	}
	for (const postPage of postPages) {
		if (!rssLinks.includes(postPage))
			failures.push(`rss.xml is missing post ${postPage}`);
	}
	for (const match of xml.matchAll(/<media:content\b[^>]*\burl="([^"]+)"/g)) {
		const imageUrl = decodeHtml(match[1]);
		if (!/^https?:\/\//.test(imageUrl))
			failures.push(`rss.xml image URL is not absolute: ${imageUrl}`);
		else
			await resolveBuiltUrl(
				imageUrl,
				site,
				distRoot,
				site,
				"rss.xml media image",
				failures,
			);
	}
}

async function verifySitemap(distRoot, site, expectedPageUrls, failures) {
	const indexPath = path.join(distRoot, "sitemap-index.xml");
	if (!(await isFile(indexPath))) {
		failures.push("sitemap-index.xml is missing");
		return;
	}
	const indexXml = await readFile(indexPath, "utf8");
	const indexLocations = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
		(match) => decodeHtml(match[1]),
	);
	for (const location of indexLocations) {
		await resolveBuiltUrl(
			location,
			site,
			distRoot,
			site,
			"sitemap index",
			failures,
		);
	}
	const sitemapFiles = (await walk(distRoot)).filter((file) =>
		/sitemap-\d+\.xml$/.test(file),
	);
	if (sitemapFiles.length === 0)
		failures.push("no sitemap content file was built");
	const expectedIndexLocations = sitemapFiles.map((file) =>
		new URL(path.basename(file), site).toString(),
	);
	compareExactValues(
		indexLocations,
		expectedIndexLocations,
		"sitemap index",
		failures,
	);
	const pageLocations = [];
	for (const file of sitemapFiles) {
		const xml = await readFile(file, "utf8");
		for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
			const location = decodeHtml(match[1]);
			pageLocations.push(location);
			await resolveBuiltUrl(
				location,
				site,
				distRoot,
				site,
				path.basename(file),
				failures,
			);
		}
	}
	compareExactValues(
		pageLocations,
		expectedPageUrls,
		"sitemap pages",
		failures,
	);
}

function sameStringArray(left, right) {
	return (
		Array.isArray(left) &&
		Array.isArray(right) &&
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

async function verifyArchiveManifest(
	repoRoot,
	distRoot,
	site,
	failures,
	{ requireSignoff, notices },
) {
	const manifestPath = path.join(
		repoRoot,
		"provenance",
		"tai-song",
		"manifest.json",
	);
	if (!(await isFile(manifestPath))) {
		failures.push("Author-master manifest is missing");
		return undefined;
	}

	let manifest;
	let manifestBytes;
	try {
		manifestBytes = await readFile(manifestPath);
		manifest = JSON.parse(manifestBytes.toString("utf8"));
	} catch (error) {
		failures.push(`Author-master manifest is invalid JSON (${error.message})`);
		return undefined;
	}
	if (hasPrivateProtonReference(manifest)) {
		failures.push("Author-master manifest contains a private Proton URL or ID");
	}
	if (manifest.author?.name !== "Tai Song") {
		failures.push("Author-master manifest author must be Tai Song");
	}
	if (
		manifest.authority?.platform !== "Proton Docs" ||
		manifest.authority?.captureFormat !== "html-export"
	) {
		failures.push("Author-master manifest authority contract is invalid");
	}
	if (!Array.isArray(manifest.articles)) {
		failures.push("Author-master manifest has no articles array");
		return undefined;
	}
	if (manifest.articles.length !== EXPECTED_ARCHIVE_COUNT) {
		failures.push(
			`Author-master manifest must contain exactly ${EXPECTED_ARCHIVE_COUNT} articles`,
		);
	}

	const reviewSignoffPath = path.join(
		repoRoot,
		"provenance",
		"tai-song",
		"review-signoffs.json",
	);
	if (!(await isFile(reviewSignoffPath))) {
		failures.push("Human review signoff record is missing");
	} else {
		try {
			const reviewRecord = JSON.parse(
				await readFile(reviewSignoffPath, "utf8"),
			);
			const review = evaluateReviewSignoffs({
				record: reviewRecord,
				manifest,
				requireSignoff,
			});
			for (const failure of review.failures) {
				failures.push(`Human review: ${failure}`);
			}
			if (review.status === "pending") {
				notices.push(
					"Human review signoff is pending; run pnpm verify:release to enforce all 11 signoffs",
				);
			}
		} catch (error) {
			failures.push(
				`Human review signoff record is invalid JSON (${error.message})`,
			);
		}
	}
	const inventoryPath = resolveManifestPath(
		repoRoot,
		manifest.inventoryPath,
		"Author-master inventory",
		failures,
	);
	if (inventoryPath && (await isFile(inventoryPath))) {
		const inventoryDigest = sha256(await readFile(inventoryPath));
		if (inventoryDigest !== exactSha256(manifest.inventorySha256)) {
			failures.push("Author-master inventory hash differs from manifest");
		}
	} else {
		failures.push("Author-master inventory is missing");
	}

	const rssPath = path.join(distRoot, "rss.xml");
	const rssXml = (await isFile(rssPath)) ? await readFile(rssPath, "utf8") : "";
	const rssItems = [...rssXml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(
		(match) => match[1],
	);
	const seenSlugs = new Set();

	for (const entry of manifest.articles) {
		const slug = typeof entry?.slug === "string" ? entry.slug : "<missing>";
		const label = `Author-master ${slug}`;
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
			failures.push(`${label}: slug is invalid`);
			continue;
		}
		if (seenSlugs.has(slug)) {
			failures.push(`${label}: manifest slug is duplicated`);
			continue;
		}
		seenSlugs.add(slug);

		const snapshotPath = resolveManifestPath(
			repoRoot,
			entry.paths?.snapshot,
			`${label} snapshot`,
			failures,
		);
		const markdownPath = resolveManifestPath(
			repoRoot,
			entry.paths?.markdown,
			`${label} Markdown`,
			failures,
		);
		const sourceImagePath = resolveManifestPath(
			repoRoot,
			entry.paths?.image,
			`${label} image`,
			failures,
		);
		if (!snapshotPath || !(await isFile(snapshotPath))) {
			failures.push(`${label}: snapshot is missing`);
			continue;
		}

		const snapshotBytes = await readFile(snapshotPath);
		const snapshotDigest = sha256(snapshotBytes);
		if (snapshotDigest !== exactSha256(entry.hashes?.snapshot)) {
			failures.push(`${label}: snapshot hash differs from manifest`);
		}
		let post;
		try {
			post = JSON.parse(snapshotBytes.toString("utf8"));
		} catch (error) {
			failures.push(`${label}: snapshot is invalid JSON (${error.message})`);
			continue;
		}
		if (hasPrivateProtonReference(post)) {
			failures.push(`${label}: snapshot contains a private Proton URL or ID`);
		}

		if (markdownPath && (await isFile(markdownPath))) {
			const markdownDigest = sha256(await readFile(markdownPath));
			if (markdownDigest !== exactSha256(entry.hashes?.markdown)) {
				failures.push(`${label}: Markdown hash differs from manifest`);
			}
		} else {
			failures.push(`${label}: generated Markdown is missing`);
		}
		if (sourceImagePath && (await isFile(sourceImagePath))) {
			const imageBytes = await readFile(sourceImagePath);
			const imageDigest = sha256(imageBytes);
			for (const [source, expected] of [
				["manifest", entry.hashes?.image],
				["manifest raw image", entry.hashes?.rawImage],
				["manifest image metadata", entry.image?.sha256],
				["snapshot hero metadata", post.hero?.sha256],
			]) {
				if (imageDigest !== exactSha256(expected)) {
					failures.push(`${label}: repository PNG differs from ${source}`);
				}
			}
			let dimensions;
			try {
				dimensions = inspectPng(imageBytes, `${label} repository hero`);
			} catch (error) {
				failures.push(`${label}: ${error.message}`);
			}
			if (dimensions) {
				for (const [source, metadata] of [
					["manifest", entry.image],
					["snapshot", post.hero],
				]) {
					if (
						metadata?.mimeType !== "image/png" ||
						metadata.width !== dimensions.width ||
						metadata.height !== dimensions.height ||
						metadata.byteSize !== imageBytes.length
					) {
						failures.push(`${label}: ${source} PNG metadata differs from file`);
					}
				}
			}
		} else {
			failures.push(`${label}: repository PNG is missing`);
		}

		if (post.slug !== slug)
			failures.push(`${label}: snapshot slug differs from manifest`);
		for (const field of [
			"title",
			"subtitle",
			"summary",
			"description",
			"author",
			"category",
			"imageCaption",
		]) {
			if (typeof post[field] !== "string" || post[field].length === 0) {
				failures.push(`${label}: snapshot ${field} must be nonempty`);
			}
		}
		if (post.author !== "Tai Song")
			failures.push(`${label}: snapshot author must be Tai Song`);
		if (post.description !== post.subtitle) {
			failures.push(`${label}: snapshot description must equal its subtitle`);
		}
		if (
			!Array.isArray(post.tags) ||
			post.tags.some((tag) => typeof tag !== "string" || tag.length === 0) ||
			new Set(post.tags).size !== post.tags.length
		) {
			failures.push(`${label}: snapshot tags must be an ordered string array`);
		}
		if (post.imageAlt !== null && typeof post.imageAlt !== "string") {
			failures.push(
				`${label}: snapshot imageAlt must preserve the source string or null`,
			);
		}
		if (post.license?.name !== "All Rights Reserved") {
			failures.push(`${label}: snapshot license is not All Rights Reserved`);
		}
		if (
			Object.hasOwn(post, "updated") ||
			Object.hasOwn(post, "contentUpdatedAt")
		) {
			failures.push(`${label}: snapshot must not infer an updated timestamp`);
		}

		const provenance = post.provenance;
		const allowedProvenanceKeys = new Set([
			"authority",
			"captureFormat",
			"capturedAt",
		]);
		if (
			!isPlainObject(provenance) ||
			provenance.authority !== "Proton Docs" ||
			provenance.captureFormat !== "html-export" ||
			!isoString(provenance.capturedAt)
		) {
			failures.push(`${label}: snapshot provenance contract is invalid`);
		} else {
			for (const key of Object.keys(provenance)) {
				if (!allowedProvenanceKeys.has(key)) {
					failures.push(`${label}: snapshot provenance has unexpected ${key}`);
				}
			}
		}
		if (entry.capturedAt !== provenance?.capturedAt) {
			failures.push(
				`${label}: capturedAt differs between manifest and snapshot`,
			);
		}

		const expectedBodyHash = exactSha256(post.bodyTextSha256);
		const expectedBlockCount = post.bodyBlockCount;
		if (typeof post.bodyHtml !== "string" || post.bodyHtml.length === 0) {
			failures.push(`${label}: snapshot bodyHtml must be nonempty`);
		}
		if (!expectedBodyHash) {
			failures.push(`${label}: snapshot bodyTextSha256 is invalid`);
		}
		if (!Number.isInteger(expectedBlockCount) || expectedBlockCount <= 0) {
			failures.push(`${label}: snapshot bodyBlockCount must be positive`);
		}
		try {
			if (bodyTextSha256(post.bodyDocument) !== expectedBodyHash) {
				failures.push(
					`${label}: canonical body document hash differs from snapshot`,
				);
			}
			if (
				canonicalBodyHtml(renderBodyHtml(post.bodyDocument)) !==
				canonicalBodyHtml(post.bodyHtml)
			) {
				failures.push(
					`${label}: bodyHtml differs from the canonical body document`,
				);
			}
			if (post.bodyDocument.blocks.length !== expectedBlockCount) {
				failures.push(
					`${label}: body document block count differs from snapshot`,
				);
			}
		} catch (error) {
			failures.push(`${label}: bodyDocument is invalid (${error.message})`);
		}
		for (const [source, expected] of [
			["manifest hash", entry.hashes?.bodyText],
			["manifest content", entry.content?.bodyTextSha256],
		]) {
			if (exactSha256(expected) !== expectedBodyHash) {
				failures.push(`${label}: ${source} differs from snapshot body hash`);
			}
		}
		if (entry.content?.bodyBlockCount !== expectedBlockCount) {
			failures.push(`${label}: manifest block count differs from snapshot`);
		}
		for (const [field, expected] of [
			["subtitle", post.subtitle],
			["imageCaption", post.imageCaption],
		]) {
			if (entry.content?.[field] !== expected) {
				failures.push(`${label}: manifest ${field} differs from snapshot`);
			}
		}
		if (entry.image?.alt !== post.imageAlt) {
			failures.push(`${label}: manifest image alt differs from snapshot`);
		}

		const expectedPublication = post.publication;
		if (expectedPublication !== undefined) {
			let publicationUrl;
			try {
				publicationUrl = new URL(expectedPublication.url);
			} catch {
				publicationUrl = undefined;
			}
			if (
				expectedPublication.platform !== "Vocal" ||
				publicationUrl?.protocol !== "https:"
			) {
				failures.push(`${label}: snapshot publication contract is invalid`);
			}
		}
		if (!samePublication(entry.publication, expectedPublication)) {
			failures.push(
				`${label}: publication differs between manifest and snapshot`,
			);
		}

		const expectedPublished = isoString(post.published);
		const expectedModified = undefined;
		if (!expectedPublished)
			failures.push(`${label}: snapshot published date is invalid`);
		const expectedTags = Array.isArray(post.tags) ? post.tags : [];
		const expectedAlt = post.imageAlt ?? "";
		const expectedImageDescription = post.imageAlt ?? undefined;
		const expectedCaption = post.imageCaption || undefined;
		const expectedAuthorUrl = new URL("authors/tai-song/", site).toString();

		const pagePath = path.join(distRoot, "posts", slug, "index.html");
		if (!(await isFile(pagePath))) {
			failures.push(`${label}: built article route is missing`);
			continue;
		}
		const html = await readFile(pagePath, "utf8");
		const document = parse(html);
		const expectedUrl = new URL(`posts/${slug}/`, site).toString();
		const canonical = getCanonical(html, label, failures);
		if (canonical !== expectedUrl)
			failures.push(`${label}: canonical URL is not the expected local route`);
		for (const [selector, expected] of [
			["author", post.author],
			["description", post.description],
			["og:title", post.title],
			["twitter:title", post.title],
			["og:description", post.description],
			["twitter:description", post.description],
			["article:published_time", expectedPublished],
			["article:section", post.category],
		]) {
			const values = metaContent(html, selector);
			if (values.length !== 1 || values[0] !== expected) {
				failures.push(`${label}: ${selector} metadata differs from snapshot`);
			}
		}
		if (metaContent(html, "article:modified_time").length !== 0) {
			failures.push(`${label}: page must not infer an updated timestamp`);
		}
		if (!sameStringArray(metaContent(html, "article:tag"), expectedTags)) {
			failures.push(
				`${label}: article tag metadata order differs from snapshot`,
			);
		}

		for (const [field, expected] of [
			["title", post.title],
			["subtitle", post.subtitle],
			["author", `By ${post.author}`],
			["image-caption", expectedCaption],
		]) {
			if (markedField(html, field) !== expected)
				failures.push(`${label}: visible ${field} differs from snapshot`);
		}
		const authorField = html.match(
			/<span\b[^>]*data-archive-field=["']author["'][^>]*>([\s\S]*?)<\/span>/iu,
		);
		const authorLinks = authorField ? tags(authorField[1], "a") : [];
		if (
			authorLinks.length !== 1 ||
			new URL(authorLinks[0].attributes.href, site).toString() !==
				expectedAuthorUrl
		) {
			failures.push(
				`${label}: visible author link differs from the local author page`,
			);
		}
		const publicationLinks = tags(html, "a").filter((tag) =>
			Object.hasOwn(tag.attributes, "data-archive-publication-url"),
		);
		if (expectedPublication) {
			if (
				publicationLinks.length !== 1 ||
				publicationLinks[0].attributes.href !== expectedPublication.url
			) {
				failures.push(`${label}: historical Vocal link differs from snapshot`);
			}
		} else if (publicationLinks.length !== 0) {
			failures.push(
				`${label}: unexpected historical publication link is visible`,
			);
		}
		const licenseBlocks = tags(html, "div").filter((tag) =>
			Object.hasOwn(tag.attributes, "data-license-name"),
		);
		if (
			licenseBlocks.length !== 1 ||
			licenseBlocks[0].attributes["data-license-name"] !== "All Rights Reserved"
		) {
			failures.push(`${label}: visible license is not All Rights Reserved`);
		}

		const bodyWrappers = elementsWithAttribute(document, "data-archive-body");
		if (bodyWrappers.length !== 1) {
			failures.push(`${label}: expected exactly one rendered archive body`);
		} else {
			const bodyNodes = bodyWrappers[0].childNodes ?? [];
			const renderedBody = archiveBodyStructureFromNodes(bodyNodes);
			const expectedBody = archiveBodyStructure(post.bodyHtml);
			if (JSON.stringify(renderedBody) !== JSON.stringify(expectedBody)) {
				failures.push(`${label}: rendered body HTML differs from snapshot`);
			}
			const renderedBlockCount = bodyNodes.filter(
				(node) => node.tagName,
			).length;
			if (renderedBlockCount !== expectedBlockCount) {
				failures.push(
					`${label}: rendered body block count ${renderedBlockCount} differs from snapshot ${expectedBlockCount}`,
				);
			}
		}

		const jsonLd = extractJsonLd(html, label, failures);
		if (jsonLd) {
			const expectedValues = [
				["headline", jsonLd.headline, post.title],
				["alternativeHeadline", jsonLd.alternativeHeadline, post.subtitle],
				["description", jsonLd.description, post.description],
				["author", jsonLd.author?.name, post.author],
				["author URL", jsonLd.author?.url, expectedAuthorUrl],
				["author ID", jsonLd.author?.["@id"], `${expectedAuthorUrl}#person`],
				["datePublished", jsonLd.datePublished, expectedPublished],
				["dateModified", jsonLd.dateModified, expectedModified],
				["url", jsonLd.url, expectedUrl],
				["mainEntityOfPage", jsonLd.mainEntityOfPage?.["@id"], expectedUrl],
				["source", jsonLd.isBasedOn, expectedPublication?.url],
				["category", jsonLd.articleSection, post.category],
				["license", jsonLd.copyrightNotice, "All Rights Reserved"],
				["caption", jsonLd.image?.caption, expectedCaption],
			];
			if (provenance?.wordCount !== undefined) {
				expectedValues.push([
					"wordCount",
					jsonLd.wordCount,
					provenance.wordCount,
				]);
			}
			for (const [field, actual, expected] of expectedValues) {
				if (actual !== expected)
					failures.push(`${label}: JSON-LD ${field} differs from snapshot`);
			}
			if (Object.hasOwn(jsonLd.image ?? {}, "sameAs")) {
				failures.push(`${label}: JSON-LD image must not publish a source URL`);
			}
			if (!sameStringArray(jsonLd.keywords, expectedTags))
				failures.push(`${label}: JSON-LD tag order differs from snapshot`);
			if (jsonLd.image?.description !== expectedImageDescription)
				failures.push(`${label}: JSON-LD image alt differs from snapshot`);
			if (jsonLd.image?.url !== jsonLd.image?.contentUrl)
				failures.push(`${label}: JSON-LD image must use one local emitted URL`);
			for (const selector of ["og:image", "twitter:image"]) {
				const values = metaContent(html, selector);
				if (values.length !== 1 || values[0] !== jsonLd.image?.url)
					failures.push(`${label}: ${selector} does not match JSON-LD image`);
			}
			for (const selector of ["og:image:alt", "twitter:image:alt"]) {
				const values = metaContent(html, selector);
				if (values.length !== 1 || values[0] !== expectedAlt)
					failures.push(`${label}: ${selector} differs from the alt contract`);
			}
		}

		const heroMatch = html.match(
			/<figure\b[^>]*data-archive-hero[^>]*>([\s\S]*?)<\/figure>/i,
		);
		const heroImages = heroMatch ? tags(heroMatch[1], "img") : [];
		if (
			heroImages.length !== 1 ||
			heroImages[0].attributes.alt !== expectedAlt
		) {
			failures.push(`${label}: visible hero or its alt text differs`);
		} else {
			const hero = heroImages[0];
			const captionTags = heroMatch
				? tags(heroMatch[1], "figcaption").filter(
						(tag) => tag.attributes["data-archive-field"] === "image-caption",
					)
				: [];
			const captionId = captionTags[0]?.attributes.id;
			if (
				captionTags.length !== 1 ||
				!captionId ||
				hero.attributes["aria-describedby"] !== captionId
			) {
				failures.push(
					`${label}: hero must reference its exact visible caption`,
				);
			}
			const imageClasses = new Set((hero.attributes.class ?? "").split(/\s+/u));
			if (
				!imageClasses.has("object-contain") ||
				imageClasses.has("object-cover") ||
				hero.attributes.width !== String(entry.image?.width) ||
				hero.attributes.height !== String(entry.image?.height)
			) {
				failures.push(
					`${label}: visible hero does not preserve contain fit and source dimensions`,
				);
			}
		}

		const matchingRssItems = rssItems.filter(
			(item) => xmlElementText(item, "link") === expectedUrl,
		);
		if (matchingRssItems.length !== 1) {
			failures.push(`${label}: RSS must contain exactly one local item`);
		} else {
			const item = matchingRssItems[0];
			if (xmlElementText(item, "title") !== post.title)
				failures.push(`${label}: RSS title differs from snapshot`);
			if (xmlElementText(item, "guid") !== expectedUrl)
				failures.push(`${label}: RSS GUID differs from local URL`);
			if (xmlElementText(item, "description") !== post.summary)
				failures.push(`${label}: RSS summary differs from snapshot`);
			if (xmlElementText(item, "dc:creator") !== post.author)
				failures.push(`${label}: RSS author differs from snapshot`);
			if (
				xmlElementText(item, "pubDate") !==
				new Date(post.published).toUTCString()
			)
				failures.push(`${label}: RSS publication date differs from snapshot`);
			if (xmlElementText(item, "dc:relation") !== expectedPublication?.url)
				failures.push(
					`${label}: RSS publication relation differs from snapshot`,
				);
			if (xmlElementText(item, "dc:source") !== undefined)
				failures.push(`${label}: RSS must not publish dc:source provenance`);
			if (xmlElementText(item, "dcterms:modified") !== undefined)
				failures.push(`${label}: RSS must not infer an updated timestamp`);
			const mediaImages = tags(item, "media:content");
			if (
				mediaImages.length !== 1 ||
				mediaImages[0].attributes.url !== jsonLd?.image?.url
			) {
				failures.push(`${label}: RSS hero URL differs from the local page`);
			}
			if (xmlElementText(item, "media:description") !== post.imageCaption) {
				failures.push(`${label}: RSS image caption differs from snapshot`);
			}
			const encodedContent = xmlElementText(item, "content:encoded") ?? "";
			const encodedHeroImages = tags(encodedContent, "img").filter(
				(tag) => tag.attributes.src === jsonLd?.image?.url,
			);
			if (
				encodedHeroImages.length !== 1 ||
				encodedHeroImages[0].attributes.alt !== expectedAlt
			) {
				failures.push(`${label}: RSS content hero alt differs from snapshot`);
			}
			const encodedCaption = encodedContent.match(
				/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i,
			);
			if (
				!encodedCaption ||
				visibleText(encodedCaption[1]) !== post.imageCaption
			) {
				failures.push(`${label}: RSS content caption differs from snapshot`);
			}
			const categories = [
				...item.matchAll(
					/<category>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/g,
				),
			].map((match) => decodeHtml(match[1]));
			const expectedCategories = [...expectedTags, post.category];
			if (!sameStringArray(categories, expectedCategories))
				failures.push(`${label}: RSS category order differs from snapshot`);
		}
	}

	const builtPostsRoot = path.join(distRoot, "posts");
	let builtPostFiles = [];
	try {
		builtPostFiles = (await walk(builtPostsRoot)).filter((file) =>
			file.endsWith("index.html"),
		);
	} catch {
		// The generic verifier already reports missing post routes.
	}
	for (const file of builtPostFiles) {
		const html = await readFile(file, "utf8");
		if (!/\bdata-archive-body(?:\s|=|>)/i.test(html)) continue;
		const relative = path.relative(builtPostsRoot, file).replace(/\\/g, "/");
		const slug = relative.replace(/\/index\.html$/, "");
		if (!seenSlugs.has(slug)) {
			failures.push(
				`Author-master ${slug}: rendered archive post is absent from manifest`,
			);
		}
	}
	return manifest;
}

async function verifyRobots(distRoot, site, failures) {
	const robotsPath = path.join(distRoot, "robots.txt");
	if (!(await isFile(robotsPath))) {
		failures.push("robots.txt is missing");
		return;
	}
	for (const failure of validateRobotsText(
		await readFile(robotsPath, "utf8"),
		site.toString(),
	)) {
		failures.push(failure);
	}
}

async function verifyDraftSources(repoRoot, manifest, failures) {
	const postsRoot = path.join(repoRoot, "src", "content", "posts");
	const markdownFiles = (await walk(postsRoot)).filter((file) =>
		file.toLowerCase().endsWith(".md"),
	);
	const draftPaths = [];
	for (const file of markdownFiles) {
		const draft = frontmatterDraftValue(await readFile(file, "utf8"));
		if (draft === true) {
			draftPaths.push(normalizedPath(path.relative(repoRoot, file)));
		}
	}
	compareExactValues(
		draftPaths,
		EXPECTED_DRAFT_POST_PATHS,
		"draft source allowlist",
		failures,
	);
	for (const article of manifest.articles) {
		const markdownPath = resolveManifestPath(
			repoRoot,
			article.paths?.markdown,
			`Author-master ${article.slug} Markdown`,
			failures,
		);
		if (
			markdownPath &&
			frontmatterDraftValue(await readFile(markdownPath, "utf8")) === true
		) {
			failures.push(`Author-master ${article.slug} must not be a draft`);
		}
	}
}

async function verifyLaunchRoutes(
	distRoot,
	htmlFiles,
	postPages,
	manifest,
	site,
	failures,
) {
	const expectedPostUrls = manifestPostUrls(manifest, site);
	compareExactValues(
		postPages,
		expectedPostUrls,
		"built post routes",
		failures,
	);
	const expectedHtmlUrls = [
		...REQUIRED_NON_POST_ROUTES.map((route) => new URL(route, site).toString()),
		...expectedPostUrls,
	];
	const actualHtmlUrls = htmlFiles
		.filter(
			(file) =>
				!normalizedPath(path.relative(distRoot, file)).startsWith("pagefind/"),
		)
		.map((file) => expectedPageUrl(file, distRoot, site));
	compareExactValues(
		actualHtmlUrls,
		expectedHtmlUrls,
		"built HTML routes",
		failures,
	);
	return expectedHtmlUrls;
}

async function verifyLaunchRss(distRoot, manifest, site, failures) {
	const rssPath = path.join(distRoot, "rss.xml");
	if (!(await isFile(rssPath))) return 0;
	const xml = await readFile(rssPath, "utf8");
	const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gu)].map(
		(match) => match[1],
	);
	const links = items
		.map((item) => xmlElementText(item, "link"))
		.filter((value) => typeof value === "string");
	compareExactValues(
		links,
		manifestPostUrls(manifest, site),
		"RSS items",
		failures,
	);
	if (items.length !== EXPECTED_ARCHIVE_COUNT) {
		failures.push(`RSS must contain exactly ${EXPECTED_ARCHIVE_COUNT} items`);
	}
	return items.length;
}

async function verifyArchiveIndex(distRoot, manifest, site, failures) {
	const archivePath = path.join(distRoot, "archive", "index.html");
	if (!(await isFile(archivePath))) {
		failures.push("archive route is missing");
		return 0;
	}
	const html = await readFile(archivePath, "utf8");
	const entries = tags(html, "a").filter(
		(tag) => typeof tag.attributes["data-archive-entry-slug"] === "string",
	);
	const slugs = entries.map(
		(entry) => entry.attributes["data-archive-entry-slug"],
	);
	const expectedSlugs = manifest.articles.map((article) => article.slug);
	compareExactValues(slugs, expectedSlugs, "archive entries", failures);
	for (const entry of entries) {
		const expectedHref = new URL(
			`posts/${entry.attributes["data-archive-entry-slug"]}/`,
			site,
		).toString();
		if (new URL(entry.attributes.href, site).toString() !== expectedHref) {
			failures.push(
				`archive entry ${entry.attributes["data-archive-entry-slug"]} has an incorrect link`,
			);
		}
	}
	const islands = tags(html, "astro-island").filter((tag) =>
		String(tag.attributes["component-url"] ?? "").includes("ArchivePanel"),
	);
	if (islands.length !== 1) {
		failures.push("archive route must contain exactly one ArchivePanel island");
	} else {
		for (const attributeName of [
			"component-url",
			"renderer-url",
			"before-hydration-url",
		]) {
			await resolveBuiltUrl(
				islands[0].attributes[attributeName],
				new URL("archive/", site),
				distRoot,
				site,
				`archive Astro island ${attributeName}`,
				failures,
			);
		}
	}
	return entries.length;
}

async function readManifestTitles(repoRoot, manifest, failures) {
	const result = new Map();
	for (const article of manifest.articles) {
		const snapshotPath = resolveManifestPath(
			repoRoot,
			article.paths?.snapshot,
			`Author-master ${article.slug} snapshot`,
			failures,
		);
		if (!snapshotPath || !(await isFile(snapshotPath))) continue;
		try {
			const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
			result.set(article.slug, snapshot.title);
		} catch (error) {
			failures.push(
				`Author-master ${article.slug} snapshot cannot supply a title (${error.message})`,
			);
		}
	}
	return result;
}

async function verifyAuthorPage(repoRoot, distRoot, manifest, site, failures) {
	const authorPath = path.join(distRoot, "authors", "tai-song", "index.html");
	if (!(await isFile(authorPath))) {
		failures.push("Tai Song author route is missing");
		return 0;
	}
	const html = await readFile(authorPath, "utf8");
	const document = parse(html);
	const authorMarkers = elementsWithAttribute(document, "data-author-archive");
	if (
		authorMarkers.length !== 1 ||
		!authorMarkers[0].attrs?.some(
			(attribute) =>
				attribute.name === "data-author-archive" &&
				attribute.value === "Tai Song",
		)
	) {
		failures.push("Tai Song author page has an invalid archive marker");
	}
	const articleNodes = elementsWithAttribute(
		document,
		"data-author-article-slug",
	);
	const slugs = articleNodes.map(
		(node) =>
			node.attrs?.find(
				(attribute) => attribute.name === "data-author-article-slug",
			)?.value,
	);
	compareExactValues(
		slugs,
		manifest.articles.map((article) => article.slug),
		"Tai Song author works",
		failures,
	);
	const titles = await readManifestTitles(repoRoot, manifest, failures);
	for (const node of articleNodes) {
		const slug = node.attrs?.find(
			(attribute) => attribute.name === "data-author-article-slug",
		)?.value;
		const anchors = [];
		const visit = (candidate) => {
			if (candidate.tagName === "a") anchors.push(candidate);
			for (const child of candidate.childNodes ?? []) visit(child);
		};
		visit(node);
		const anchorAttributes = Object.fromEntries(
			(anchors[0]?.attrs ?? []).map((attribute) => [
				attribute.name,
				attribute.value,
			]),
		);
		const anchorText = anchors[0]
			? archiveBodyStructureFromNodes(anchors[0].childNodes ?? [])
					.filter((entry) => entry[0] === "text")
					.map((entry) => entry[1])
					.join("")
			: undefined;
		if (
			anchors.length !== 1 ||
			new URL(anchorAttributes.href, site).toString() !==
				new URL(`posts/${slug}/`, site).toString() ||
			anchorText !== titles.get(slug)
		) {
			failures.push(
				`Tai Song author work ${slug} has an incorrect link or title`,
			);
		}
	}

	const authorUrl = new URL("authors/tai-song/", site).toString();
	const jsonLd = extractJsonLd(html, "Tai Song author page", failures);
	if (jsonLd) {
		if (
			jsonLd["@type"] !== "Person" ||
			jsonLd.name !== "Tai Song" ||
			jsonLd.url !== authorUrl ||
			jsonLd["@id"] !== `${authorUrl}#person`
		) {
			failures.push("Tai Song author JSON-LD identity is incorrect");
		}
		const works = Array.isArray(jsonLd.workExample) ? jsonLd.workExample : [];
		const actualWorks = works.map((work) => `${work.url}\n${work.name}`);
		const expectedWorks = manifest.articles.map(
			(article) =>
				`${new URL(`posts/${article.slug}/`, site)}\n${titles.get(article.slug)}`,
		);
		compareExactValues(
			actualWorks,
			expectedWorks,
			"Tai Song author JSON-LD works",
			failures,
		);
	}
	return articleNodes.length;
}

export function decodePagefindFragment(buffer) {
	const inflated = gunzipSync(buffer);
	const prefix = Buffer.from("pagefind_dcd", "utf8");
	if (!inflated.subarray(0, prefix.length).equals(prefix)) {
		throw new Error("Pagefind fragment has an unknown payload prefix");
	}
	return JSON.parse(inflated.subarray(prefix.length).toString("utf8"));
}

function pagefindResultUrl(rawUrl, site) {
	if (typeof rawUrl !== "string" || rawUrl.length === 0) return undefined;
	if (/^https?:\/\//iu.test(rawUrl)) return new URL(rawUrl).toString();
	const basePath = site.pathname.endsWith("/")
		? site.pathname
		: `${site.pathname}/`;
	if (rawUrl.startsWith(basePath))
		return new URL(rawUrl, site.origin).toString();
	return new URL(rawUrl.replace(/^\/+/, ""), site).toString();
}

async function verifyPagefind(repoRoot, distRoot, manifest, site, failures) {
	const pagefindRoot = path.join(distRoot, "pagefind");
	let pagefindFiles;
	try {
		pagefindFiles = await walk(pagefindRoot);
	} catch {
		failures.push("Pagefind output is missing");
		return 0;
	}
	const relativeFiles = pagefindFiles.map((file) =>
		normalizedPath(path.relative(pagefindRoot, file)),
	);
	for (const pattern of [
		/^pagefind\.js$/u,
		/(?:\.wasm$|(?:^|\/)wasm\.[^/]+\.pagefind$)/u,
		/\.pf_meta$/u,
		/\.pf_index$/u,
	]) {
		const matches = pagefindFiles.filter((_, index) =>
			pattern.test(relativeFiles[index]),
		);
		if (
			matches.length === 0 ||
			(await Promise.all(matches.map((file) => readFile(file)))).some(
				(buffer) => buffer.length === 0,
			)
		) {
			failures.push(`Pagefind output lacks a nonempty ${pattern} artifact`);
		}
	}
	const entryPath = path.join(pagefindRoot, "pagefind-entry.json");
	let entry;
	try {
		entry = JSON.parse(await readFile(entryPath, "utf8"));
	} catch (error) {
		failures.push(`Pagefind entry is missing or invalid (${error.message})`);
		return 0;
	}
	if (entry.version !== "1.4.0") {
		failures.push(
			`Pagefind entry version ${entry.version} is not the reviewed 1.4.0 format`,
		);
	}
	const languages = Object.keys(entry.languages ?? {});
	if (
		languages.length !== 1 ||
		languages[0] !== "en" ||
		entry.languages?.en?.page_count !== EXPECTED_ARCHIVE_COUNT
	) {
		failures.push(
			`Pagefind must contain exactly ${EXPECTED_ARCHIVE_COUNT} English pages`,
		);
	}
	const fragmentFiles = pagefindFiles.filter((_, index) =>
		/^fragment\/.*\.pf_fragment$/u.test(relativeFiles[index]),
	);
	const records = [];
	for (const file of fragmentFiles) {
		try {
			records.push(decodePagefindFragment(await readFile(file)));
		} catch (error) {
			failures.push(
				`Pagefind fragment ${path.basename(file)} is invalid (${error.message})`,
			);
		}
	}
	const titles = await readManifestTitles(repoRoot, manifest, failures);
	const actualRecords = records.map(
		(record) => `${pagefindResultUrl(record.url, site)}\n${record.meta?.title}`,
	);
	const expectedRecords = manifest.articles.map(
		(article) =>
			`${new URL(`posts/${article.slug}/`, site)}\n${titles.get(article.slug)}`,
	);
	compareExactValues(
		actualRecords,
		expectedRecords,
		"Pagefind records",
		failures,
	);
	if (records.length !== EXPECTED_ARCHIVE_COUNT) {
		failures.push(
			`Pagefind must emit exactly ${EXPECTED_ARCHIVE_COUNT} fragments`,
		);
	}
	return records.length;
}

function verifyNoPodcastArtifacts(files, distRoot, failures) {
	for (const file of files) {
		const relative = normalizedPath(path.relative(distRoot, file));
		if (
			/(?:^|\/)podcast(?:\/|$)/iu.test(relative) ||
			AUDIO_ARTIFACT_PATTERN.test(relative)
		) {
			failures.push(
				`forbidden podcast/audio artifact was emitted: ${relative}`,
			);
		}
	}
}

export async function verifyBuiltSite({
	dist = DEFAULT_DIST,
	site: siteValue = DEFAULT_SITE,
	repoRoot: repoRootValue = process.cwd(),
	requireSignoff = false,
} = {}) {
	const distRoot = path.resolve(dist);
	const repoRoot = path.resolve(repoRootValue);
	const site = new URL(siteValue);
	if (!site.pathname.endsWith("/")) site.pathname += "/";
	const files = await walk(distRoot);
	const htmlFiles = files.filter((file) => file.endsWith(".html"));
	if (htmlFiles.length === 0)
		throw new Error(`No built HTML files found under ${distRoot}`);

	const failures = [];
	const notices = [];
	const postPages = [];
	for (const file of htmlFiles)
		await verifyHtml(file, distRoot, site, failures, postPages);
	await verifyRss(distRoot, site, failures, postPages);
	const manifest = await verifyArchiveManifest(
		repoRoot,
		distRoot,
		site,
		failures,
		{ requireSignoff, notices },
	);
	let expectedPageUrls = [];
	let rssItems = 0;
	let pagefindRecords = 0;
	let archiveEntries = 0;
	let authorWorks = 0;
	if (manifest) {
		expectedPageUrls = await verifyLaunchRoutes(
			distRoot,
			htmlFiles,
			postPages,
			manifest,
			site,
			failures,
		);
		rssItems = await verifyLaunchRss(distRoot, manifest, site, failures);
		archiveEntries = await verifyArchiveIndex(
			distRoot,
			manifest,
			site,
			failures,
		);
		authorWorks = await verifyAuthorPage(
			repoRoot,
			distRoot,
			manifest,
			site,
			failures,
		);
		pagefindRecords = await verifyPagefind(
			repoRoot,
			distRoot,
			manifest,
			site,
			failures,
		);
		await verifyDraftSources(repoRoot, manifest, failures);
	}
	await verifySitemap(distRoot, site, expectedPageUrls, failures);
	await verifyRobots(distRoot, site, failures);
	verifyNoPodcastArtifacts(files, distRoot, failures);

	if (failures.length > 0) {
		throw new Error(
			`Built-site verification failed:\n- ${failures.join("\n- ")}`,
		);
	}
	return {
		htmlPages: htmlFiles.length,
		postPages: postPages.length,
		rssItems,
		pagefindRecords,
		archiveEntries,
		authorWorks,
		notices,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	try {
		const result = await verifyBuiltSite(parseArguments(process.argv.slice(2)));
		for (const notice of result.notices) {
			console.warn(`Built-site verification notice: ${notice}`);
		}
		console.log(
			`Built-site verification passed: ${result.htmlPages} HTML pages, ${result.postPages} posts, ${result.rssItems} RSS items, ${result.pagefindRecords} Pagefind records, ${result.archiveEntries} archive links, ${result.authorWorks} author works`,
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
