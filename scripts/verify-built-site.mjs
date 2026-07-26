import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { parse, parseFragment } from "parse5";
import { PODCAST_SHOW } from "../src/data/podcast.ts";
import { getApprovedPodcastEpisodes } from "../src/data/podcast-approval.ts";
import { inspectPng, sha256 } from "./archive/lib/integrity.js";
import { bodyTextSha256, renderBodyHtml } from "./archive/lib/render.js";
import {
	evaluateReviewSignoffs,
	validateReviewSignoffCommitBinding,
} from "./archive/lib/review-signoff.js";
import { inspectBuiltImages } from "./verify-images.mjs";

const DEFAULT_DIST = "dist";
const DEFAULT_SITE = "https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/";
const EXPECTED_ARCHIVE_COUNT = 11;
const RELEASE_TARGETS = new Set(["archive", "catalog"]);
const REQUIRED_NON_POST_ROUTES = [
	"",
	"about/",
	"archive/",
	"authors/tai-song/",
	"rights/",
];
const REQUIRED_NON_INDEXABLE_HTML_ROUTES = ["404.html"];
const HOME_DESCRIPTION =
	"Enter the eleven-work Shots of Rhapsody archive: fiction, poetry, and reflections by Tai Song.";
const AUTHOR_BIO =
	"Tai Song is a Singapore-based commodity trader and trade strategist whose writing spans fiction, poetry, reflection, and nonfiction. Across global markets and imagined futures, Tai explores power, policy, inequality, memory, the consequences of invention, and the fragile things people try to preserve.";
const AUDIO_ARTIFACT_PATTERN = /\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/iu;

export function parseArguments(argv) {
	const options = {
		dist: DEFAULT_DIST,
		site: DEFAULT_SITE,
		requireSignoff: false,
		releaseTarget: "catalog",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--require-signoff") {
			options.requireSignoff = true;
			continue;
		}
		if (
			argument === "--dist" ||
			argument === "--site" ||
			argument === "--release-target"
		) {
			const value = argv[index + 1];
			if (!value) throw new Error(`${argument} requires a value`);
			const key =
				argument === "--release-target" ? "releaseTarget" : argument.slice(2);
			options[key] = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}
	if (!RELEASE_TARGETS.has(options.releaseTarget))
		throw new Error(`Unsupported release target: ${options.releaseTarget}`);
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

function attributeValue(node, name) {
	return node.attrs?.find((attribute) => attribute.name === name)?.value;
}

function nodeText(node) {
	if (node.nodeName === "#text") return node.value ?? "";
	return (node.childNodes ?? []).map(nodeText).join("");
}

function trimSerializationBoundaryWhitespace(value) {
	return value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, "");
}

function markedFieldFromDocument(document, field) {
	const matches = elementsWithAttribute(document, "data-archive-field").filter(
		(node) => attributeValue(node, "data-archive-field") === field,
	);
	return matches.length === 1
		? trimSerializationBoundaryWhitespace(nodeText(matches[0]))
		: undefined;
}

export function markedField(html, field) {
	return markedFieldFromDocument(parse(html), field);
}

function verifyPublicationTime(
	container,
	marker,
	expectedPublished,
	expectedText,
	label,
	failures,
) {
	const times = elementsWithAttribute(container, marker).filter(
		(node) => node.tagName === "time",
	);
	if (
		times.length !== 1 ||
		attributeValue(times[0], "datetime") !== expectedPublished ||
		nodeText(times[0]).trim() !== expectedText
	) {
		failures.push(`${label}: visible publication date differs from snapshot`);
	}
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

function hasExactKeys(value, expectedKeys) {
	if (!isPlainObject(value)) return false;
	const keys = Object.keys(value);
	return (
		keys.length === expectedKeys.size &&
		keys.every((key) => expectedKeys.has(key))
	);
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

const PRIVATE_BUILD_REFERENCE_PATTERNS = [
	/https?:\/\/[^\s"'<>]*proton[^\s"'<>]*/iu,
	/\bprotonusercontent\.(?:com|ch)\b/iu,
	/\.proton-import(?:[\\/]|\b)/iu,
	/\bfile:\/\/[^\s"'<>]*/iu,
	/\b(?:localhost|127\.0\.0\.1)(?::[0-9]+)?\b/iu,
	/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/iu,
	/(?:^|[\s"'(])\/(?:home|Users)\/[^/\s]+\//u,
];

const SITE_COPY_BRAND_PATTERN =
	/\b(?:GitHub|Vocal|Medium|Proton|Fuwari|Astro|Twitter)\b/iu;
const SITE_COPY_INTERNAL_PATTERN =
	/\b(?:repository|manifest|upstream|deployment|backend|system-level)\b|\b(?:source|content)\s+(?:hash|path|import)\b/iu;
const SITE_COPY_EDITORIAL_PROCESS_PATTERN =
	/\b(?:author-approved sources?|(?:careful\s+)?source review|preserved author text|reviewed claim by claim|human-reviewed transcripts?)\b/iu;
const BLOCKED_PUBLIC_LINK_HOSTS = new Set([
	"github.com",
	"medium.com",
	"vocal.media",
	"proton.me",
	"docs.proton.me",
	"fuwari.vercel.app",
]);
const AUTHORED_CONTENT_MARKERS = new Set([
	"data-authored-content",
	"data-archive-body",
	"data-archive-field",
	"data-archive-hero",
	"data-medium-field",
	"data-medium-hero",
	"data-archive-entry-slug",
]);
const AUTHORED_CONTENT_CLASSES = new Set([
	"editorial-card__title",
	"editorial-card__subtitle",
	"editorial-card__meta",
]);
const BLOG_POSTING_AUTHORED_JSON_LD_FIELDS = new Set([
	"headline",
	"alternativeHeadline",
	"description",
	"keywords",
	"articleSection",
]);
const BLOG_POSTING_AUTHORED_IMAGE_FIELDS = new Set(["description", "caption"]);

function publicCopyIssues(value) {
	const issues = [];
	if (SITE_COPY_BRAND_PATTERN.test(value)) {
		issues.push("site-authored copy contains third-party platform branding");
	}
	if (SITE_COPY_INTERNAL_PATTERN.test(value)) {
		issues.push("site-authored copy contains internal implementation language");
	}
	if (SITE_COPY_EDITORIAL_PROCESS_PATTERN.test(value)) {
		issues.push("site-authored copy contains editorial process language");
	}
	if (/shots-of-rhapsody\.github\.io/iu.test(value)) {
		issues.push(
			"site-authored visible copy exposes the temporary hosting address",
		);
	}
	return issues;
}

function isRequiredSelfHostedUrl(value) {
	try {
		const parsed = new URL(value);
		return (
			(parsed.protocol === "https:" || parsed.protocol === "http:") &&
			parsed.hostname.toLowerCase() === "shots-of-rhapsody.github.io"
		);
	} catch {
		return false;
	}
}

function publicMetadataCopyIssues(value) {
	return isRequiredSelfHostedUrl(value) ? [] : publicCopyIssues(value);
}

function blogPostingAuthoredMetaValues(posting, field) {
	const keywords = Array.isArray(posting.keywords)
		? posting.keywords.filter((value) => typeof value === "string")
		: typeof posting.keywords === "string"
			? [posting.keywords]
			: [];
	const authorName = isPlainObject(posting.author)
		? posting.author.name
		: undefined;
	const image = isPlainObject(posting.image) ? posting.image : undefined;
	switch (field) {
		case "description":
		case "og:description":
			return [posting.description];
		case "og:title":
			return [posting.headline];
		case "author":
		case "article:author":
			return [authorName];
		case "keywords":
		case "article:tag":
			return keywords;
		case "article:section":
			return [posting.articleSection];
		case "og:image:alt":
			return [image?.description, image?.caption];
		default:
			return [];
	}
}

function isAuthoredBlogPostingMetaValue(postings, field, value) {
	return postings.some((posting) =>
		blogPostingAuthoredMetaValues(posting, field).some(
			(candidate) => typeof candidate === "string" && candidate === value,
		),
	);
}

function publicTitleCopyIssues(value, blogPostings) {
	for (const posting of blogPostings) {
		if (typeof posting.headline !== "string") continue;
		if (value === posting.headline) return [];
		const authoredPrefix = `${posting.headline} — `;
		if (value.startsWith(authoredPrefix)) {
			return publicMetadataCopyIssues(value.slice(authoredPrefix.length));
		}
	}
	return publicMetadataCopyIssues(value);
}

function isAuthoredStructuredDataPath(rootType, pathParts) {
	const [rootField, nestedField] = pathParts;
	if (rootType === "BlogPosting") {
		return (
			BLOG_POSTING_AUTHORED_JSON_LD_FIELDS.has(rootField) ||
			(rootField === "image" &&
				BLOG_POSTING_AUTHORED_IMAGE_FIELDS.has(nestedField))
		);
	}
	if (rootType === "CollectionPage") {
		return (
			pathParts[0] === "mainEntity" &&
			pathParts[1] === "itemListElement" &&
			typeof pathParts[2] === "number" &&
			pathParts[3] === "name"
		);
	}
	if (rootType === "ProfilePage") {
		return (
			pathParts[0] === "mainEntity" &&
			pathParts[1] === "workExample" &&
			typeof pathParts[2] === "number" &&
			pathParts[3] === "name"
		);
	}
	return false;
}

function structuredDataCopyIssues(value, rootType, pathParts = []) {
	if (typeof value === "string") {
		if (isAuthoredStructuredDataPath(rootType, pathParts)) {
			return [];
		}
		return publicMetadataCopyIssues(value);
	}
	if (Array.isArray(value)) {
		return value.flatMap((child, index) =>
			structuredDataCopyIssues(child, rootType, [...pathParts, index]),
		);
	}
	if (!isPlainObject(value)) return [];
	return Object.entries(value).flatMap(([key, child]) =>
		structuredDataCopyIssues(child, rootType, [...pathParts, key]),
	);
}

export function publicFacingCopyViolations(html) {
	const document = parse(String(html));
	const violations = [];
	const structuredData = new Map();
	for (const node of elementsWithAttribute(document, "type")) {
		if (
			node.tagName?.toLowerCase() !== "script" ||
			attributeValue(node, "type") !== "application/ld+json"
		) {
			continue;
		}
		try {
			structuredData.set(node, JSON.parse(nodeText(node)));
		} catch {
			// JSON-LD syntax is reported by the dedicated metadata verifier.
		}
	}
	const blogPostings = [...structuredData.values()].filter(
		(value) => isPlainObject(value) && value["@type"] === "BlogPosting",
	);
	const visit = (node, { authored = false, visible = true } = {}) => {
		const attributesByName = Object.fromEntries(
			(node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]),
		);
		const classes = new Set((attributesByName.class ?? "").split(/\s+/u));
		const isAuthored =
			authored ||
			(node.attrs ?? []).some((attribute) =>
				AUTHORED_CONTENT_MARKERS.has(attribute.name),
			) ||
			[...AUTHORED_CONTENT_CLASSES].some((className) => classes.has(className));
		if (isAuthored) return;

		const tagName = node.tagName?.toLowerCase();
		const isVisible =
			visible &&
			!["head", "script", "style", "template", "noscript"].includes(tagName);
		if (tagName === "meta") {
			const name = attributesByName.name?.toLowerCase();
			const property = attributesByName.property?.toLowerCase();
			const field = name ?? property;
			if (name === "generator") {
				violations.push("framework generator metadata is public");
			}
			if (name?.startsWith("twitter:")) {
				violations.push("platform-specific social metadata is public");
			}
			if (
				attributesByName.content !== undefined &&
				!isAuthoredBlogPostingMetaValue(
					blogPostings,
					field,
					attributesByName.content,
				)
			) {
				violations.push(...publicMetadataCopyIssues(attributesByName.content));
			}
		}
		if (tagName === "title") {
			violations.push(...publicTitleCopyIssues(nodeText(node), blogPostings));
		}
		if (
			tagName === "script" &&
			attributesByName.type === "application/ld+json"
		) {
			const jsonLd = structuredData.get(node);
			if (jsonLd !== undefined) {
				if (isPlainObject(jsonLd) && Object.hasOwn(jsonLd, "isBasedOn")) {
					violations.push(
						"structured data exposes historical-source provenance",
					);
				}
				const rootType = isPlainObject(jsonLd) ? jsonLd["@type"] : undefined;
				violations.push(...structuredDataCopyIssues(jsonLd, rootType));
			}
		}
		if (tagName === "a" && attributesByName.href) {
			try {
				const target = new URL(attributesByName.href, "https://shots.invalid/");
				if (BLOCKED_PUBLIC_LINK_HOSTS.has(target.hostname.toLowerCase())) {
					violations.push(
						"site-authored navigation exposes a third-party platform link",
					);
				}
			} catch {
				// Invalid URLs are reported by the dedicated URL verifier.
			}
		}
		if (node.nodeName === "#text" && visible) {
			violations.push(...publicCopyIssues(node.value ?? ""));
		}
		if (isVisible) {
			for (const attributeName of ["alt", "aria-label", "title"]) {
				violations.push(
					...publicCopyIssues(attributesByName[attributeName] ?? ""),
				);
			}
		}
		for (const child of node.childNodes ?? []) {
			visit(child, { authored: false, visible: isVisible });
		}
	};
	visit(document);
	return sortedUnique(violations);
}

function normalizedReferenceText(value) {
	return value
		.replace(/\\\//gu, "/")
		.replace(/\\u([0-9a-f]{4})/giu, (_, codePoint) =>
			String.fromCodePoint(Number.parseInt(codePoint, 16)),
		)
		.replace(/\\x([0-9a-f]{2})/giu, (_, codePoint) =>
			String.fromCodePoint(Number.parseInt(codePoint, 16)),
		)
		.replace(/&(?:sol|#0*47|#x0*2f);/giu, "/")
		.replace(/&(?:colon|#0*58|#x0*3a);/giu, ":")
		.replace(/&(?:period|#0*46|#x0*2e);/giu, ".");
}

export function hasPrivateProtonReference(value) {
	if (typeof value === "string") {
		const normalized = normalizedReferenceText(value);
		return PRIVATE_BUILD_REFERENCE_PATTERNS.some((pattern) =>
			pattern.test(normalized),
		);
	}
	if (Array.isArray(value)) return value.some(hasPrivateProtonReference);
	if (!isPlainObject(value)) return false;
	return Object.entries(value).some(
		([key, child]) =>
			/(?:proton|document|doc|raw(?:source)?).*(?:id|url|path|root|directory)|(?:id|url|path|root|directory).*(?:proton|document|doc|raw(?:source)?)/iu.test(
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

function frontmatterJsonValue(markdown, field, label, failures) {
	const match = String(markdown).match(
		/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u,
	);
	if (!match) {
		failures.push(`${label}: Markdown frontmatter is missing`);
		return undefined;
	}
	const expression = new RegExp(`^${field}:\\s*(.+?)\\s*$`, "gmu");
	const values = [...match[1].matchAll(expression)];
	if (values.length !== 1) {
		failures.push(`${label}: frontmatter ${field} must occur exactly once`);
		return undefined;
	}
	try {
		return JSON.parse(values[0][1]);
	} catch {
		failures.push(`${label}: frontmatter ${field} must use JSON string syntax`);
		return undefined;
	}
}

export async function loadPublicationManifest(
	repoRoot,
	archiveManifest,
	releaseTarget,
	failures,
) {
	if (releaseTarget === "archive") return archiveManifest;
	const catalogPath = path.join(
		repoRoot,
		"provenance",
		"publication-catalog.json",
	);
	let catalog;
	try {
		catalog = JSON.parse(await readFile(catalogPath, "utf8"));
	} catch (error) {
		failures.push(`Publication catalog is invalid (${error.message})`);
		return archiveManifest;
	}
	if (
		!hasExactKeys(catalog, new Set(["schemaVersion", "entries"])) ||
		catalog.schemaVersion !== 1 ||
		!Array.isArray(catalog.entries) ||
		catalog.entries.length < EXPECTED_ARCHIVE_COUNT
	) {
		failures.push(
			"Publication catalog must use the exact version 1 contract and preserve the sealed archive",
		);
		return archiveManifest;
	}
	const allowedSources = new Set(["tai-song", "medium", "first-party"]);
	const allowedSections = new Set([
		"fiction",
		"poetry-reflection",
		"nonfiction",
	]);
	const articles = [];
	const seenSlugs = new Set();
	for (const entry of catalog.entries) {
		const label = `Publication catalog ${entry?.slug ?? "<missing>"}`;
		if (
			!hasExactKeys(
				entry,
				new Set(["slug", "source", "markdown", "section"]),
			) ||
			typeof entry.slug !== "string" ||
			!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.slug) ||
			seenSlugs.has(entry.slug) ||
			!allowedSources.has(entry.source) ||
			!allowedSections.has(entry.section) ||
			(entry.source === "medium" && entry.section !== "nonfiction") ||
			entry.markdown !== `src/content/posts/${entry.slug}/index.md`
		) {
			failures.push(`${label}: entry contract is invalid or duplicated`);
			continue;
		}
		seenSlugs.add(entry.slug);
		const markdownPath = resolveManifestPath(
			repoRoot,
			entry.markdown,
			`${label} Markdown`,
			failures,
		);
		if (!markdownPath || !(await isFile(markdownPath))) {
			failures.push(`${label}: Markdown is missing`);
			continue;
		}
		const markdown = await readFile(markdownPath, "utf8");
		const draft = frontmatterDraftValue(markdown);
		if (
			(entry.source === "tai-song" && draft === true) ||
			(entry.source !== "tai-song" && draft !== false)
		) {
			failures.push(
				entry.source === "tai-song"
					? `${label}: sealed archive writing must not be a draft`
					: `${label}: new cataloged writing must declare draft: false`,
			);
		}
		const title = frontmatterJsonValue(markdown, "title", label, failures);
		const published = frontmatterJsonValue(
			markdown,
			"published",
			label,
			failures,
		);
		const section =
			entry.source === "tai-song"
				? entry.section
				: frontmatterJsonValue(markdown, "section", label, failures);
		if (typeof title !== "string" || title.length === 0)
			failures.push(`${label}: title is invalid`);
		if (
			typeof published !== "string" ||
			Number.isNaN(Date.parse(published)) ||
			new Date(published).toISOString() !== published
		)
			failures.push(`${label}: publication date is not canonical UTC`);
		if (entry.source !== "tai-song" && section !== entry.section)
			failures.push(`${label}: Markdown section differs from the catalog`);
		articles.push({
			slug: entry.slug,
			source: entry.source,
			section: entry.section,
			title,
			published,
			paths: { markdown: entry.markdown },
		});
	}
	const sealedBySlug = new Map(
		archiveManifest.articles.map((article) => [article.slug, article]),
	);
	const sealedEntries = articles.filter(
		(article) => article.source === "tai-song",
	);
	if (
		sealedEntries.length !== EXPECTED_ARCHIVE_COUNT ||
		sealedEntries.some(
			(article) =>
				sealedBySlug.get(article.slug)?.paths.markdown !==
				article.paths.markdown,
		)
	) {
		failures.push("Publication catalog changed the sealed eleven-work archive");
	}
	return { articles };
}

export function markedAttributeValues(html, tagName, attributeName) {
	return tags(html, tagName)
		.map((tag) => tag.attributes[attributeName])
		.filter((value) => typeof value === "string" && value.length > 0);
}

export function validateNoProjectRobots(relativePaths) {
	const robotsFiles = relativePaths.filter((relativePath) =>
		/(?:^|\/)robots\.txt$/iu.test(normalizedPath(relativePath)),
	);
	return robotsFiles.length === 0
		? []
		: [
				"the project artifact must not emit robots.txt because only the GitHub Pages host-root file can control crawling",
			];
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
	for (const violation of publicFacingCopyViolations(html)) {
		failures.push(`${relativePath}: ${violation}`);
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
	for (const selector of ["og:url"]) {
		const values = metaContent(html, selector);
		if (values.length !== 1 || values[0] !== canonical) {
			failures.push(
				`${relativePath}: ${selector} must equal the canonical URL`,
			);
		}
	}
	for (const selector of ["og:image"]) {
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
	if (/<dc:relation(?:\s|>)/i.test(xml))
		failures.push("rss.xml must not publish historical-source provenance");
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
	{ requireSignoff, notices, validateReviewCommitBinding = true },
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
			if (review.status === "complete" && validateReviewCommitBinding) {
				for (const failure of validateReviewSignoffCommitBinding({
					record: reviewRecord,
					repoRoot,
				})) {
					failures.push(`Human review: ${failure}`);
				}
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
		if (expectedPublished) {
			const expectedDateOnly = expectedPublished.slice(0, 10);
			verifyPublicationTime(
				document,
				"data-post-published",
				expectedPublished,
				expectedDateOnly,
				`${label} metadata`,
				failures,
			);
			verifyPublicationTime(
				document,
				"data-license-published",
				expectedPublished,
				expectedDateOnly,
				`${label} license`,
				failures,
			);
		}
		const canonical = getCanonical(html, label, failures);
		if (canonical !== expectedUrl)
			failures.push(`${label}: canonical URL is not the expected local route`);
		for (const [selector, expected] of [
			["author", post.author],
			["description", post.description],
			["og:title", post.title],
			["og:description", post.description],
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
			if (markedFieldFromDocument(document, field) !== expected)
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
		if (publicationLinks.length !== 0) {
			failures.push(
				`${label}: historical publication provenance must not be visible`,
			);
		}
		const licenseBlocks = ["aside", "div"].flatMap((tagName) =>
			tags(html, tagName).filter((tag) =>
				Object.hasOwn(tag.attributes, "data-license-name"),
			),
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
				["category", jsonLd.articleSection, post.category],
				["license", jsonLd.copyrightNotice, "All Rights Reserved"],
				["caption", jsonLd.image?.caption, expectedCaption],
				["image MIME type", jsonLd.image?.encodingFormat, "image/jpeg"],
				["image width", jsonLd.image?.width, 1200],
				["image height", jsonLd.image?.height, 1200],
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
			if (Object.hasOwn(jsonLd, "isBasedOn")) {
				failures.push(`${label}: JSON-LD must not publish source provenance`);
			}
			if (!sameStringArray(jsonLd.keywords, expectedTags))
				failures.push(`${label}: JSON-LD tag order differs from snapshot`);
			if (jsonLd.image?.description !== expectedImageDescription)
				failures.push(`${label}: JSON-LD image alt differs from snapshot`);
			if (jsonLd.image?.url !== jsonLd.image?.contentUrl)
				failures.push(`${label}: JSON-LD image must use one local emitted URL`);
			for (const selector of ["og:image"]) {
				const values = metaContent(html, selector);
				if (values.length !== 1 || values[0] !== jsonLd.image?.url)
					failures.push(`${label}: ${selector} does not match JSON-LD image`);
			}
			for (const selector of ["og:image:alt"]) {
				const values = metaContent(html, selector);
				if (values.length !== 1 || values[0] !== expectedAlt)
					failures.push(`${label}: ${selector} differs from the alt contract`);
			}
			for (const [selector, expected] of [
				["og:image:type", "image/jpeg"],
				["og:image:width", "1200"],
				["og:image:height", "1200"],
			]) {
				const values = metaContent(html, selector);
				if (values.length !== 1 || values[0] !== expected) {
					failures.push(
						`${label}: ${selector} differs from social image metadata`,
					);
				}
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
			const heroSources = heroMatch ? tags(heroMatch[1], "source") : [];
			const expectedHeroWidths = [640, 960, 1280, 1600, 2048].filter(
				(width) => width <= entry.image?.width,
			);
			if (!expectedHeroWidths.includes(entry.image?.width)) {
				expectedHeroWidths.push(entry.image?.width);
			}
			const srcsetWidths = (value = "") =>
				value
					.split(",")
					.map((candidate) => Number(candidate.trim().match(/\s(\d+)w$/u)?.[1]))
					.filter(Number.isFinite);
			const expectedHeroSizes = hero.attributes.sizes;
			if (
				heroSources.length !== 1 ||
				heroSources[0].attributes.type !== "image/avif" ||
				!expectedHeroSizes?.includes("100vw") ||
				heroSources[0].attributes.sizes !== expectedHeroSizes ||
				JSON.stringify(srcsetWidths(heroSources[0].attributes.srcset)) !==
					JSON.stringify(expectedHeroWidths) ||
				!heroSources[0].attributes.srcset
					?.split(",")
					.every((candidate) => /\.avif\s+\d+w$/u.test(candidate.trim()))
			) {
				failures.push(`${label}: hero AVIF source contract is invalid`);
			}
			if (
				hero.attributes.sizes !== expectedHeroSizes ||
				JSON.stringify(srcsetWidths(hero.attributes.srcset)) !==
					JSON.stringify(expectedHeroWidths) ||
				!hero.attributes.src?.endsWith(".webp") ||
				!hero.attributes.srcset
					?.split(",")
					.every((candidate) => /\.webp\s+\d+w$/u.test(candidate.trim())) ||
				hero.attributes.loading !== "eager" ||
				hero.attributes.fetchpriority !== "high"
			) {
				failures.push(
					`${label}: hero WebP fallback, responsive sizes, or LCP priority is invalid`,
				);
			}
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
			if (xmlElementText(item, "dc:relation") !== undefined)
				failures.push(`${label}: RSS must not publish source provenance`);
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
			} else if (
				mediaImages[0].attributes.type !== "image/jpeg" ||
				mediaImages[0].attributes.width !== "1200" ||
				mediaImages[0].attributes.height !== "1200"
			) {
				failures.push(`${label}: RSS social image metadata is invalid`);
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

function expectedHomeDescription(manifest) {
	return manifest.articles.some((article) => article.section === "nonfiction")
		? `Enter the ${manifest.articles.length}-work Shots of Rhapsody collection: fiction, poetry, reflections, and nonfiction by Tai Song.`
		: HOME_DESCRIPTION;
}

async function verifyHomepageMetadata(distRoot, site, manifest, failures) {
	const homepagePath = path.join(distRoot, "index.html");
	if (!(await isFile(homepagePath))) {
		failures.push("homepage is missing");
		return;
	}
	const html = await readFile(homepagePath, "utf8");
	const homepageUrl = site.toString();
	const authorUrl = new URL("authors/tai-song/", site).toString();
	const socialImageUrl = new URL("social/site.jpg", site).toString();
	const socialImageAlt =
		"Shots of Rhapsody — Stories, poems, and reflections by Tai Song";
	const jsonLd = extractJsonLd(html, "homepage", failures);
	if (jsonLd) {
		const expectedValues = [
			["context", jsonLd["@context"], "https://schema.org"],
			["type", jsonLd["@type"], "WebSite"],
			["ID", jsonLd["@id"], `${homepageUrl}#website`],
			["name", jsonLd.name, "Shots of Rhapsody"],
			["description", jsonLd.description, expectedHomeDescription(manifest)],
			["URL", jsonLd.url, homepageUrl],
			["language", jsonLd.inLanguage, "en"],
			["author type", jsonLd.author?.["@type"], "Person"],
			["author ID", jsonLd.author?.["@id"], `${authorUrl}#person`],
			["author name", jsonLd.author?.name, "Tai Song"],
			["author URL", jsonLd.author?.url, authorUrl],
			["image type", jsonLd.image?.["@type"], "ImageObject"],
			["image URL", jsonLd.image?.url, socialImageUrl],
			["image content URL", jsonLd.image?.contentUrl, socialImageUrl],
			["image MIME type", jsonLd.image?.encodingFormat, "image/jpeg"],
			["image width", jsonLd.image?.width, 1200],
			["image height", jsonLd.image?.height, 630],
			["image description", jsonLd.image?.description, socialImageAlt],
		];
		for (const [field, actual, expected] of expectedValues) {
			if (actual !== expected) {
				failures.push(`homepage: WebSite JSON-LD ${field} is incorrect`);
			}
		}
	}
	for (const [selector, expected] of [
		["og:image", socialImageUrl],
		["og:image:alt", socialImageAlt],
		["og:image:type", "image/jpeg"],
		["og:image:width", "1200"],
		["og:image:height", "630"],
	]) {
		const values = metaContent(html, selector);
		if (values.length !== 1 || values[0] !== expected) {
			failures.push(`homepage: ${selector} does not match the site card`);
		}
	}
}

async function verifyCustomNotFound(distRoot, site, failures) {
	const notFoundPath = path.join(distRoot, "404.html");
	if (!(await isFile(notFoundPath))) {
		failures.push("custom 404 route is missing");
		return;
	}
	const html = await readFile(notFoundPath, "utf8");
	const document = parse(html);
	const markers = elementsWithAttribute(document, "data-custom-404");
	if (markers.length !== 1) {
		failures.push("custom 404 must contain one branded error-page marker");
	}
	const robots = metaContent(html, "robots");
	if (robots.length !== 1 || robots[0] !== "noindex") {
		failures.push("custom 404 must have one noindex directive");
	}
	for (const [attribute, expectedUrl] of [
		["data-404-home", site.toString()],
		["data-404-archive", new URL("archive/", site).toString()],
	]) {
		const links = elementsWithAttribute(document, attribute).filter(
			(node) => node.tagName === "a",
		);
		const href = links[0] ? attributeValue(links[0], "href") : undefined;
		if (
			links.length !== 1 ||
			!href ||
			new URL(href, site).toString() !== expectedUrl
		) {
			failures.push(`custom 404 has an invalid ${attribute} link`);
		}
	}
}

async function verifyDraftSources(repoRoot, manifest, failures) {
	const postsRoot = path.join(repoRoot, "src", "content", "posts");
	const markdownFiles = (await walk(postsRoot)).filter((file) =>
		file.toLowerCase().endsWith(".md"),
	);
	const publishedPaths = new Set(
		manifest.articles.map((article) =>
			normalizedPath(
				path.resolve(repoRoot, ...article.paths.markdown.split("/")),
			),
		),
	);
	for (const file of markdownFiles) {
		const draft = frontmatterDraftValue(await readFile(file, "utf8"));
		const normalized = normalizedPath(path.resolve(file));
		const cataloged = publishedPaths.has(normalized);
		if (cataloged && draft === true)
			failures.push(
				`Cataloged writing must not be a draft: ${normalizedPath(path.relative(repoRoot, file))}`,
			);
		if (!cataloged && draft !== true)
			failures.push(
				`Uncataloged writing must remain an explicit draft: ${normalizedPath(path.relative(repoRoot, file))}`,
			);
	}
}

async function verifyLaunchRoutes(
	distRoot,
	htmlFiles,
	postPages,
	manifest,
	site,
	failures,
	additionalRoutes = [],
) {
	const expectedPostUrls = manifestPostUrls(manifest, site);
	compareExactValues(
		postPages,
		expectedPostUrls,
		"built post routes",
		failures,
	);
	const expectedIndexableHtmlUrls = [
		...REQUIRED_NON_POST_ROUTES.map((route) => new URL(route, site).toString()),
		...additionalRoutes.map((route) => new URL(route, site).toString()),
		...expectedPostUrls,
	];
	const expectedHtmlUrls = [
		...expectedIndexableHtmlUrls,
		...REQUIRED_NON_INDEXABLE_HTML_ROUTES.map((route) =>
			new URL(route, site).toString(),
		),
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
	return expectedIndexableHtmlUrls;
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
	if (items.length !== manifest.articles.length) {
		failures.push(
			`RSS must contain exactly ${manifest.articles.length} approved writing items`,
		);
	}
	return items.length;
}

async function readManifestPublicationDates(repoRoot, manifest, failures) {
	const result = new Map();
	for (const article of manifest.articles) {
		if (typeof article.published === "string") {
			result.set(article.slug, article.published);
			continue;
		}
		const snapshotPath = resolveManifestPath(
			repoRoot,
			article.paths?.snapshot,
			`Author-master ${article.slug} snapshot`,
			failures,
		);
		if (!snapshotPath || !(await isFile(snapshotPath))) continue;
		try {
			const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
			const published = isoString(snapshot.published);
			if (!published || published !== snapshot.published) {
				failures.push(
					`Author-master ${article.slug} snapshot publication date is not canonical UTC`,
				);
				continue;
			}
			result.set(article.slug, published);
		} catch (error) {
			failures.push(
				`Author-master ${article.slug} snapshot cannot supply a publication date (${error.message})`,
			);
		}
	}
	return result;
}

async function verifyHomePublicationDates(
	repoRoot,
	distRoot,
	manifest,
	failures,
) {
	const publishedBySlug = await readManifestPublicationDates(
		repoRoot,
		manifest,
		failures,
	);
	const cards = [];
	const nonfictionCards = [];
	for (const relativePath of ["index.html", path.join("2", "index.html")]) {
		const pagePath = path.join(distRoot, relativePath);
		if (!(await isFile(pagePath))) continue;
		const document = parse(await readFile(pagePath, "utf8"));
		cards.push(...elementsWithAttribute(document, "data-post-card-slug"));
		nonfictionCards.push(
			...elementsWithAttribute(document, "data-home-nonfiction-slug"),
		);
	}
	const slugs = cards.map((card) =>
		attributeValue(card, "data-post-card-slug"),
	);
	compareExactValues(
		slugs,
		manifest.articles
			.filter((article) => article.section !== "nonfiction")
			.map((article) => article.slug),
		"home publication-date cards",
		failures,
	);
	const expectedRecentNonfiction = manifest.articles
		.filter((article) => article.section === "nonfiction")
		.toSorted(
			(left, right) =>
				new Date(right.published).valueOf() -
				new Date(left.published).valueOf(),
		)
		.slice(0, 3)
		.map((article) => article.slug);
	compareExactValues(
		nonfictionCards.map((card) =>
			attributeValue(card, "data-home-nonfiction-slug"),
		),
		expectedRecentNonfiction,
		"home recent nonfiction cards",
		failures,
	);
	for (const card of [...cards, ...nonfictionCards]) {
		const slug = attributeValue(card, "data-post-card-slug");
		const effectiveSlug =
			slug ?? attributeValue(card, "data-home-nonfiction-slug");
		const published = publishedBySlug.get(effectiveSlug);
		if (!published) continue;
		verifyPublicationTime(
			card,
			"data-post-published",
			published,
			published.slice(0, 10),
			`home card ${effectiveSlug}`,
			failures,
		);
	}
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
	if (tags(html, "astro-island").length !== 0) {
		failures.push(
			"archive route must be server-rendered without client islands",
		);
	}
	return entries.length;
}

async function verifyNonfictionIndex(distRoot, manifest, failures) {
	const expected = manifest.articles
		.filter((article) => article.section === "nonfiction")
		.map((article) => article.slug);
	if (expected.length === 0) return 0;
	const indexPath = path.join(distRoot, "nonfiction", "index.html");
	if (!(await isFile(indexPath))) {
		failures.push("Nonfiction index route is missing");
		return 0;
	}
	const document = parse(await readFile(indexPath, "utf8"));
	if (elementsWithAttribute(document, "data-nonfiction-index").length !== 1)
		failures.push("Nonfiction index must contain one approved-list marker");
	const slugs = elementsWithAttribute(document, "data-editorial-slug").map(
		(node) => attributeValue(node, "data-editorial-slug"),
	);
	compareExactValues(slugs, expected, "nonfiction index entries", failures);
	return slugs.length;
}

export async function verifyMediumRenderedBodies(
	repoRoot,
	distRoot,
	publicationManifest,
	failures,
	site = DEFAULT_SITE,
) {
	const expectedSlugs = publicationManifest.articles
		.filter((article) => article.source === "medium")
		.map((article) => article.slug);
	if (expectedSlugs.length === 0) return;
	let mediumManifest;
	try {
		mediumManifest = JSON.parse(
			await readFile(
				path.join(repoRoot, "provenance", "medium", "manifest.json"),
				"utf8",
			),
		);
	} catch (error) {
		failures.push(`Medium manifest is invalid (${error.message})`);
		return;
	}
	if (
		mediumManifest?.state !== "active" ||
		!Array.isArray(mediumManifest.articles)
	) {
		failures.push(
			"Medium manifest must be active before Medium writing is rendered",
		);
		return;
	}
	const manifestSlugs = mediumManifest.articles.map((article) => article?.slug);
	compareExactValues(
		manifestSlugs.filter((slug) => typeof slug === "string"),
		expectedSlugs,
		"Medium manifest articles",
		failures,
	);
	if (manifestSlugs.some((slug) => typeof slug !== "string")) {
		failures.push("Medium manifest contains an article without a valid slug");
	}
	const bySlug = new Map(
		mediumManifest.articles.map((article) => [article?.slug, article]),
	);
	const rssPath = path.join(distRoot, "rss.xml");
	let rssItems = [];
	if (!(await isFile(rssPath))) {
		failures.push("Medium rendered verification requires rss.xml");
	} else {
		const rssXml = await readFile(rssPath, "utf8");
		rssItems = [...rssXml.matchAll(/<item>([\s\S]*?)<\/item>/gu)].map(
			(match) => match[1],
		);
	}
	for (const slug of expectedSlugs) {
		const article = bySlug.get(slug);
		const snapshotPath = article
			? resolveManifestPath(
					repoRoot,
					article.paths?.snapshot,
					`Medium ${slug} snapshot`,
					failures,
				)
			: undefined;
		if (!article || !snapshotPath || !(await isFile(snapshotPath))) {
			failures.push(`Medium ${slug}: snapshot evidence is missing`);
			continue;
		}
		let snapshot;
		try {
			const snapshotBytes = await readFile(snapshotPath);
			if (sha256(snapshotBytes) !== exactSha256(article.hashes?.snapshot)) {
				failures.push(
					`Medium ${slug}: snapshot hash differs from its manifest`,
				);
			}
			snapshot = JSON.parse(snapshotBytes.toString("utf8"));
		} catch (error) {
			failures.push(`Medium ${slug}: snapshot is invalid (${error.message})`);
			continue;
		}
		if (
			snapshot?.slug !== slug ||
			typeof snapshot.exportTitle !== "string" ||
			snapshot.exportTitle.length === 0 ||
			(snapshot.exportSummary !== null &&
				typeof snapshot.exportSummary !== "string") ||
			typeof snapshot.title !== "string" ||
			snapshot.title.length === 0 ||
			typeof snapshot.subtitle !== "string" ||
			snapshot.subtitle.length === 0 ||
			typeof snapshot.seriesLine !== "string" ||
			snapshot.seriesLine.length === 0 ||
			typeof snapshot.summary !== "string" ||
			snapshot.summary.length === 0 ||
			typeof snapshot.description !== "string" ||
			snapshot.description !== snapshot.summary ||
			(snapshot.exportSummary !== null &&
				snapshot.exportSummary !== snapshot.summary) ||
			snapshot.author !== "Tai Song" ||
			!isoString(snapshot.published) ||
			typeof snapshot.category !== "string" ||
			!Array.isArray(snapshot.tags) ||
			(snapshot.imageAlt !== null && typeof snapshot.imageAlt !== "string") ||
			typeof snapshot.imageCaption !== "string" ||
			snapshot.license?.name !== "All Rights Reserved" ||
			typeof snapshot.bodyHtml !== "string" ||
			snapshot.bodyHtml.length === 0
		) {
			failures.push(`Medium ${slug}: snapshot body contract is invalid`);
			continue;
		}
		const pagePath = path.join(distRoot, "posts", slug, "index.html");
		if (!(await isFile(pagePath))) {
			failures.push(`Medium ${slug}: built page is missing`);
			continue;
		}
		const html = await readFile(pagePath, "utf8");
		const document = parse(html);
		const mediumFields = elementsWithAttribute(document, "data-medium-field");
		const fieldByName = new Map();
		for (const node of mediumFields) {
			const field = attributeValue(node, "data-medium-field");
			if (fieldByName.has(field)) {
				failures.push(`Medium ${slug}: rendered ${field} field is duplicated`);
				continue;
			}
			fieldByName.set(field, node);
		}
		for (const [field, expected] of [
			["export-title", snapshot.exportTitle],
			["summary", snapshot.summary],
			["title", snapshot.title],
			["subtitle", snapshot.subtitle],
			["series-line", snapshot.seriesLine],
			["author", `By ${snapshot.author}`],
		]) {
			const node = fieldByName.get(field);
			if (
				!node ||
				trimSerializationBoundaryWhitespace(nodeText(node)) !== expected
			) {
				failures.push(
					`Medium ${slug}: rendered ${field} differs from its snapshot`,
				);
			}
		}
		if (fieldByName.size !== 6) {
			failures.push(
				`Medium ${slug}: rendered presentation must contain exactly export-title, summary, title, subtitle, series-line, and author fields`,
			);
		}
		if (
			fieldByName.get("export-title")?.tagName !== "h1" ||
			fieldByName.get("summary")?.tagName !== "p" ||
			fieldByName.get("title")?.tagName !== "h2" ||
			fieldByName.get("subtitle")?.tagName !== "p" ||
			fieldByName.get("series-line")?.tagName !== "p" ||
			fieldByName.get("author")?.tagName !== "span"
		) {
			failures.push(
				`Medium ${slug}: headline, summary, authored title, subtitle, Ledger Series line, or author uses the wrong semantic element`,
			);
		}
		const heroes = elementsWithAttribute(document, "data-medium-hero");
		const bodies = elementsWithAttribute(
			document,
			"data-authored-content",
		).filter((node) =>
			(attributeValue(node, "class") ?? "")
				.split(/\s+/u)
				.includes("article-body"),
		);
		if (heroes.length !== 1 || heroes[0].tagName !== "figure") {
			failures.push(`Medium ${slug}: rendered hero is ambiguous`);
			continue;
		}
		const heroWrappers = elementsWithAttribute(
			heroes[0],
			"data-image-variant",
		).filter((node) => attributeValue(node, "data-image-variant") === "hero");
		const heroDescendants = [];
		const visitHero = (node) => {
			if (node.tagName) heroDescendants.push(node);
			for (const child of node.childNodes ?? []) visitHero(child);
		};
		visitHero(heroes[0]);
		const heroPictures = heroDescendants.filter(
			(node) => node.tagName === "picture",
		);
		const heroSources = heroDescendants.filter(
			(node) => node.tagName === "source",
		);
		const heroImages = heroDescendants.filter((node) => node.tagName === "img");
		const heroCaptions = heroDescendants.filter(
			(node) => node.tagName === "figcaption",
		);
		const expectedAlt = snapshot.imageAlt ?? "";
		const manifestHeroAssets = Array.isArray(article.assets)
			? article.assets.filter((asset) => asset?.role === "hero")
			: [];
		const manifestHero = manifestHeroAssets[0];
		if (manifestHeroAssets.length !== 1) {
			failures.push(
				`Medium ${slug}: manifest must contain exactly one hero asset`,
			);
		} else {
			const heroAssetPath = resolveManifestPath(
				repoRoot,
				manifestHero.path,
				`Medium ${slug} hero asset`,
				failures,
			);
			if (!heroAssetPath || !(await isFile(heroAssetPath))) {
				failures.push(`Medium ${slug}: approved hero asset is missing`);
			} else {
				const heroAssetBytes = await readFile(heroAssetPath);
				if (
					sha256(heroAssetBytes) !== exactSha256(manifestHero.sha256) ||
					heroAssetBytes.length !== manifestHero.byteSize
				) {
					failures.push(
						`Medium ${slug}: approved hero bytes differ from manifest evidence`,
					);
				}
			}
			for (const [field, actual, expected] of [
				[
					"path",
					typeof manifestHero.path === "string"
						? path.basename(manifestHero.path)
						: undefined,
					snapshot.hero?.outputFile,
				],
				["digest", manifestHero.sha256, snapshot.hero?.sha256],
				[
					"acquisition digest",
					manifestHero.acquisitionManifestSha256,
					snapshot.hero?.acquisitionManifestSha256,
				],
				[
					"capture digest",
					manifestHero.captureSha256,
					snapshot.hero?.captureSha256,
				],
				["pixel digest", manifestHero.pixelSha256, snapshot.hero?.pixelSha256],
				["MIME type", manifestHero.mimeType, snapshot.hero?.mimeType],
				["width", manifestHero.width, snapshot.hero?.width],
				["height", manifestHero.height, snapshot.hero?.height],
				["byte length", manifestHero.byteSize, snapshot.hero?.byteSize],
			]) {
				if (actual !== expected) {
					failures.push(
						`Medium ${slug}: hero ${field} differs between manifest and snapshot`,
					);
				}
			}
		}
		if (
			heroWrappers.length !== 1 ||
			attributeValue(heroWrappers[0], "data-source-width") !==
				String(snapshot.hero?.width) ||
			attributeValue(heroWrappers[0], "data-source-height") !==
				String(snapshot.hero?.height) ||
			heroPictures.length !== 1 ||
			heroSources.length !== 1 ||
			attributeValue(heroSources[0], "type") !== "image/avif" ||
			heroImages.length !== 1 ||
			attributeValue(heroImages[0], "alt") !== expectedAlt ||
			attributeValue(heroImages[0], "width") !== String(snapshot.hero?.width) ||
			attributeValue(heroImages[0], "height") !== String(snapshot.hero?.height)
		) {
			failures.push(
				`Medium ${slug}: rendered hero dimensions or alt text differ from its snapshot`,
			);
		}
		if (
			(snapshot.imageCaption === "" && heroCaptions.length !== 0) ||
			(snapshot.imageCaption !== "" &&
				(heroCaptions.length !== 1 ||
					!(attributeValue(heroCaptions[0], "class") ?? "")
						.split(/\s+/u)
						.includes("article-caption") ||
					trimSerializationBoundaryWhitespace(nodeText(heroCaptions[0])) !==
						snapshot.imageCaption))
		) {
			failures.push(
				`Medium ${slug}: rendered hero caption differs from its snapshot`,
			);
		}
		const heroImage = heroImages[0];
		const captionId = heroCaptions[0]
			? attributeValue(heroCaptions[0], "id")
			: undefined;
		const describedBy = heroImage
			? attributeValue(heroImage, "aria-describedby")
			: undefined;
		if (
			(snapshot.imageCaption === "" && describedBy !== undefined) ||
			(snapshot.imageCaption !== "" &&
				(!captionId || describedBy !== captionId))
		) {
			failures.push(
				`Medium ${slug}: rendered hero must reference its exact visible caption`,
			);
		}
		if (bodies.length !== 1) {
			failures.push(`Medium ${slug}: rendered authored body is ambiguous`);
			continue;
		}
		const articleShells = elementsWithAttribute(document, "id").filter(
			(node) => attributeValue(node, "id") === "post-container",
		);
		const directElements = (articleShells[0]?.childNodes ?? []).filter((node) =>
			Boolean(node.tagName),
		);
		const headerIndex = directElements.findIndex(
			(node) => node.tagName === "header",
		);
		const seriesIndex = directElements.indexOf(fieldByName.get("series-line"));
		const leads = elementsWithAttribute(document, "data-medium-lead");
		const leadIndex = directElements.indexOf(leads[0]);
		const heroIndex = directElements.indexOf(heroes[0]);
		const bodyIndex = directElements.indexOf(bodies[0]);
		const preBodyFigures = directElements
			.slice(0, bodyIndex < 0 ? directElements.length : bodyIndex)
			.filter((node) => node.tagName === "figure");
		if (
			articleShells.length !== 1 ||
			headerIndex !== 0 ||
			leads.length !== 1 ||
			leads[0].tagName !== "section" ||
			leadIndex !== headerIndex + 1 ||
			seriesIndex !== leadIndex + 1 ||
			heroIndex !== seriesIndex + 1 ||
			bodyIndex !== heroIndex + 1 ||
			preBodyFigures.length !== 1 ||
			preBodyFigures[0] !== heroes[0]
		) {
			failures.push(
				`Medium ${slug}: rendered order must be header, authored lead, series line, hero, then authored body`,
			);
		}
		const header = directElements[headerIndex];
		const headerElements = [];
		const visitHeader = (node) => {
			if (node.tagName) headerElements.push(node);
			for (const child of node.childNodes ?? []) visitHeader(child);
		};
		if (header) visitHeader(header);
		if (
			headerElements.indexOf(fieldByName.get("export-title")) < 0 ||
			headerElements.indexOf(fieldByName.get("summary")) <=
				headerElements.indexOf(fieldByName.get("export-title")) ||
			headerElements.indexOf(fieldByName.get("author")) <=
				headerElements.indexOf(fieldByName.get("summary"))
		) {
			failures.push(
				`Medium ${slug}: rendered header must preserve export title, summary, then author order`,
			);
		}
		const leadElements = [];
		const visitLead = (node) => {
			if (node.tagName) leadElements.push(node);
			for (const child of node.childNodes ?? []) visitLead(child);
		};
		if (leads[0]) visitLead(leads[0]);
		if (
			leadElements.length !== 3 ||
			leadElements[0] !== leads[0] ||
			leadElements[1] !== fieldByName.get("title") ||
			leadElements[2] !== fieldByName.get("subtitle")
		) {
			failures.push(
				`Medium ${slug}: authored lead must contain exactly its title then subtitle`,
			);
		}
		const documentOrder = [];
		const visitDocumentOrder = (node) => {
			documentOrder.push(node);
			for (const child of node.childNodes ?? []) visitDocumentOrder(child);
		};
		visitDocumentOrder(document);
		const presentationOrder = [...mediumFields, ...heroes, ...bodies]
			.toSorted(
				(left, right) =>
					documentOrder.indexOf(left) - documentOrder.indexOf(right),
			)
			.map((node) =>
				node === heroes[0]
					? "hero"
					: node === bodies[0]
						? "body"
						: attributeValue(node, "data-medium-field"),
			)
			.filter((field) => field !== "author");
		if (
			JSON.stringify(presentationOrder) !==
			JSON.stringify([
				"export-title",
				"summary",
				"title",
				"subtitle",
				"series-line",
				"hero",
				"body",
			])
		) {
			failures.push(
				`Medium ${slug}: public presentation order differs from the approved contract`,
			);
		}
		const expectedUrl = new URL(`posts/${slug}/`, site).toString();
		if (getCanonical(html, `Medium ${slug}`, failures) !== expectedUrl) {
			failures.push(`Medium ${slug}: canonical URL is not its local route`);
		}
		verifyPublicationTime(
			document,
			"data-post-published",
			snapshot.published,
			snapshot.published.slice(0, 10),
			`Medium ${slug} metadata`,
			failures,
		);
		for (const [selector, expected] of [
			["author", snapshot.author],
			["description", snapshot.description],
			["og:title", snapshot.exportTitle],
			["og:description", snapshot.description],
			["article:published_time", snapshot.published],
			["article:section", snapshot.category],
		]) {
			const values = metaContent(html, selector);
			if (values.length !== 1 || values[0] !== expected) {
				failures.push(
					`Medium ${slug}: ${selector} metadata differs from its snapshot`,
				);
			}
		}
		if (!sameStringArray(metaContent(html, "article:tag"), snapshot.tags)) {
			failures.push(
				`Medium ${slug}: article tag metadata differs from its snapshot`,
			);
		}
		const licenseBlocks = elementsWithAttribute(document, "data-license-name");
		if (
			licenseBlocks.length !== 1 ||
			attributeValue(licenseBlocks[0], "data-license-name") !==
				"All Rights Reserved"
		) {
			failures.push(
				`Medium ${slug}: visible license is not All Rights Reserved`,
			);
		}
		const jsonLd = extractJsonLd(html, `Medium ${slug}`, failures);
		if (jsonLd) {
			const expectedSocialImageUrl = new URL(
				`social/${slug}.jpg`,
				site,
			).toString();
			for (const [field, actual, expected] of [
				["type", jsonLd["@type"], "BlogPosting"],
				["headline", jsonLd.headline, snapshot.exportTitle],
				["alternativeHeadline", jsonLd.alternativeHeadline, snapshot.title],
				["description", jsonLd.description, snapshot.description],
				["author", jsonLd.author?.name, snapshot.author],
				[
					"author URL",
					jsonLd.author?.url,
					new URL("authors/tai-song/", site).toString(),
				],
				["datePublished", jsonLd.datePublished, snapshot.published],
				["dateModified", jsonLd.dateModified, undefined],
				["url", jsonLd.url, expectedUrl],
				["mainEntityOfPage", jsonLd.mainEntityOfPage?.["@id"], expectedUrl],
				["category", jsonLd.articleSection, snapshot.category],
				["license", jsonLd.copyrightNotice, "All Rights Reserved"],
				["caption", jsonLd.image?.caption, snapshot.imageCaption || undefined],
				["image type", jsonLd.image?.["@type"], "ImageObject"],
				[
					"image alt",
					jsonLd.image?.description,
					snapshot.imageAlt ?? undefined,
				],
				["image URL", jsonLd.image?.url, expectedSocialImageUrl],
				["image content URL", jsonLd.image?.contentUrl, expectedSocialImageUrl],
				["image MIME type", jsonLd.image?.encodingFormat, "image/jpeg"],
				["image width", jsonLd.image?.width, 1200],
				["image height", jsonLd.image?.height, 1200],
			]) {
				if (actual !== expected) {
					failures.push(
						`Medium ${slug}: JSON-LD ${field} differs from its snapshot`,
					);
				}
			}
			if (!sameStringArray(jsonLd.keywords, snapshot.tags)) {
				failures.push(`Medium ${slug}: JSON-LD tags differ from its snapshot`);
			}
			if (Object.hasOwn(jsonLd, "isBasedOn")) {
				failures.push(
					`Medium ${slug}: JSON-LD must not expose source provenance`,
				);
			}
			if (Object.hasOwn(jsonLd.image ?? {}, "sameAs")) {
				failures.push(
					`Medium ${slug}: JSON-LD image must not expose a source URL`,
				);
			}
			for (const [selector, expected] of [
				["og:image", expectedSocialImageUrl],
				["og:image:alt", expectedAlt],
				["og:image:type", "image/jpeg"],
				["og:image:width", "1200"],
				["og:image:height", "1200"],
			]) {
				const values = metaContent(html, selector);
				if (values.length !== 1 || values[0] !== expected) {
					failures.push(
						`Medium ${slug}: ${selector} differs from approved social image evidence`,
					);
				}
			}
		}
		const matchingRssItems = rssItems.filter(
			(item) => xmlElementText(item, "link") === expectedUrl,
		);
		if (matchingRssItems.length !== 1) {
			failures.push(`Medium ${slug}: RSS must contain exactly one local item`);
		} else {
			const item = matchingRssItems[0];
			for (const [field, actual, expected] of [
				["title", xmlElementText(item, "title"), snapshot.exportTitle],
				["GUID", xmlElementText(item, "guid"), expectedUrl],
				["summary", xmlElementText(item, "description"), snapshot.summary],
				["author", xmlElementText(item, "dc:creator"), snapshot.author],
				[
					"publication date",
					xmlElementText(item, "pubDate"),
					new Date(snapshot.published).toUTCString(),
				],
			]) {
				if (actual !== expected) {
					failures.push(
						`Medium ${slug}: RSS ${field} differs from its snapshot`,
					);
				}
			}
			for (const field of ["dc:source", "dc:relation", "dcterms:modified"]) {
				if (xmlElementText(item, field) !== undefined) {
					failures.push(
						`Medium ${slug}: RSS must not expose ${field} provenance or an inferred update`,
					);
				}
			}
			const mediaImages = tags(item, "media:content");
			if (
				mediaImages.length !== 1 ||
				mediaImages[0].attributes.url !== jsonLd?.image?.url ||
				mediaImages[0].attributes.medium !== "image" ||
				mediaImages[0].attributes.type !== "image/jpeg" ||
				mediaImages[0].attributes.width !== "1200" ||
				mediaImages[0].attributes.height !== "1200"
			) {
				failures.push(
					`Medium ${slug}: RSS social image differs from the local page`,
				);
			}
			const mediaDescription = xmlElementText(item, "media:description");
			if (
				(snapshot.imageCaption === "" && mediaDescription !== undefined) ||
				(snapshot.imageCaption !== "" &&
					mediaDescription !== snapshot.imageCaption)
			) {
				failures.push(
					`Medium ${slug}: RSS image caption differs from its snapshot`,
				);
			}
			const encodedContent = xmlElementText(item, "content:encoded") ?? "";
			const encodedFragment = parseFragment(encodedContent);
			const encodedNodes = (encodedFragment.childNodes ?? []).filter(
				(node) => node.nodeName !== "#text" || /\S/u.test(node.value ?? ""),
			);
			const encodedLead = encodedNodes[0];
			const encodedLeadElements = (encodedLead?.childNodes ?? []).filter(
				(node) => Boolean(node.tagName),
			);
			if (
				encodedLead?.tagName !== "section" ||
				encodedLeadElements.length !== 3 ||
				encodedLeadElements[0].tagName !== "h2" ||
				nodeText(encodedLeadElements[0]) !== snapshot.title ||
				encodedLeadElements[1].tagName !== "p" ||
				nodeText(encodedLeadElements[1]) !== snapshot.subtitle ||
				encodedLeadElements[2].tagName !== "p" ||
				nodeText(encodedLeadElements[2]) !== snapshot.seriesLine
			) {
				failures.push(
					`Medium ${slug}: RSS content lead differs from its approved title, subtitle, and Ledger Series sentence`,
				);
			}
			const encodedHero = encodedNodes[1];
			const encodedHeroDescendants = [];
			const visitEncodedHero = (node) => {
				if (node.tagName) encodedHeroDescendants.push(node);
				for (const child of node.childNodes ?? []) visitEncodedHero(child);
			};
			if (encodedHero) visitEncodedHero(encodedHero);
			const encodedHeroImages = encodedHeroDescendants.filter(
				(node) => node.tagName === "img",
			);
			const encodedHeroCaptions = encodedHeroDescendants.filter(
				(node) => node.tagName === "figcaption",
			);
			if (
				encodedHero?.tagName !== "figure" ||
				encodedHeroImages.length !== 1 ||
				attributeValue(encodedHeroImages[0], "src") !== jsonLd?.image?.url ||
				attributeValue(encodedHeroImages[0], "alt") !== expectedAlt ||
				attributeValue(encodedHeroImages[0], "width") !== "1200" ||
				attributeValue(encodedHeroImages[0], "height") !== "1200"
			) {
				failures.push(
					`Medium ${slug}: RSS content hero alt differs from its snapshot`,
				);
			}
			if (
				(snapshot.imageCaption === "" && encodedHeroCaptions.length !== 0) ||
				(snapshot.imageCaption !== "" &&
					(encodedHeroCaptions.length !== 1 ||
						nodeText(encodedHeroCaptions[0]) !== snapshot.imageCaption))
			) {
				failures.push(
					`Medium ${slug}: RSS content caption differs from its snapshot`,
				);
			}
			const categories = [
				...item.matchAll(
					/<category>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/gu,
				),
			].map((match) => decodeHtml(match[1]));
			if (!sameStringArray(categories, [...snapshot.tags, snapshot.category])) {
				failures.push(
					`Medium ${slug}: RSS category order differs from its snapshot`,
				);
			}
			const rssBody = archiveBodyStructureFromNodes(encodedNodes.slice(2));
			const snapshotBody = archiveBodyStructure(snapshot.bodyHtml);
			if (JSON.stringify(rssBody) !== JSON.stringify(snapshotBody)) {
				failures.push(
					`Medium ${slug}: RSS content body differs from its snapshot`,
				);
			}
		}
		const actual = archiveBodyStructureFromNodes(bodies[0].childNodes ?? []);
		const expected = archiveBodyStructure(snapshot.bodyHtml);
		if (JSON.stringify(actual) !== JSON.stringify(expected))
			failures.push(`Medium ${slug}: rendered body differs from its snapshot`);
	}
}

async function readManifestTitles(repoRoot, manifest, failures) {
	const result = new Map();
	for (const article of manifest.articles) {
		if (typeof article.title === "string") {
			result.set(article.slug, article.title);
			continue;
		}
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
	if (!nodeText(document).includes(AUTHOR_BIO)) {
		failures.push(
			"Tai Song author page does not display the approved biography",
		);
	}
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
	const publishedBySlug = await readManifestPublicationDates(
		repoRoot,
		manifest,
		failures,
	);
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
		const published = publishedBySlug.get(slug);
		if (published) {
			const expectedText = new Intl.DateTimeFormat("en-US", {
				year: "numeric",
				month: "long",
				day: "numeric",
				timeZone: "UTC",
			}).format(new Date(published));
			verifyPublicationTime(
				node,
				"data-author-published",
				published,
				expectedText,
				`Tai Song author work ${slug}`,
				failures,
			);
		}
	}

	const authorUrl = new URL("authors/tai-song/", site).toString();
	const jsonLd = extractJsonLd(html, "Tai Song author page", failures);
	if (jsonLd) {
		if (
			jsonLd["@type"] !== "ProfilePage" ||
			jsonLd.name !== "Tai Song — Shots of Rhapsody" ||
			jsonLd.url !== authorUrl ||
			jsonLd["@id"] !== `${authorUrl}#profile` ||
			jsonLd.description !== AUTHOR_BIO ||
			jsonLd.inLanguage !== "en" ||
			jsonLd.mainEntity?.["@type"] !== "Person" ||
			jsonLd.mainEntity?.name !== "Tai Song" ||
			jsonLd.mainEntity?.url !== authorUrl ||
			jsonLd.mainEntity?.["@id"] !== `${authorUrl}#person` ||
			jsonLd.mainEntity?.description !== AUTHOR_BIO ||
			jsonLd.mainEntity?.mainEntityOfPage?.["@id"] !== `${authorUrl}#profile`
		) {
			failures.push("Tai Song author JSON-LD identity is incorrect");
		}
		const works = Array.isArray(jsonLd.mainEntity?.workExample)
			? jsonLd.mainEntity.workExample
			: [];
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

async function verifyPagefind(
	repoRoot,
	distRoot,
	manifest,
	site,
	failures,
	podcastEpisodes = [],
) {
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
	const expectedPageCount =
		manifest.articles.length + podcastEpisodes.length * 2;
	if (
		languages.length !== 1 ||
		languages[0] !== "en" ||
		entry.languages?.en?.page_count !== expectedPageCount
	) {
		failures.push(
			`Pagefind must contain exactly ${expectedPageCount} approved English pages`,
		);
	}
	const fragmentFiles = pagefindFiles.filter((_, index) =>
		/^fragment\/.*\.pf_fragment$/u.test(relativeFiles[index]),
	);
	const records = [];
	let privateRecordCount = 0;
	for (const file of fragmentFiles) {
		try {
			const record = decodePagefindFragment(await readFile(file));
			records.push(record);
			if (hasPrivateProtonReference(record)) privateRecordCount += 1;
		} catch (error) {
			failures.push(
				`Pagefind fragment ${path.basename(file)} is invalid (${error.message})`,
			);
		}
	}
	if (privateRecordCount > 0) {
		failures.push(
			`Pagefind contains ${privateRecordCount} decoded record(s) with a private Proton or raw-source reference`,
		);
	}
	const titles = await readManifestTitles(repoRoot, manifest, failures);
	const actualRecords = records.map(
		(record) => `${pagefindResultUrl(record.url, site)}\n${record.meta?.title}`,
	);
	const expectedRecords = [
		...manifest.articles.map(
			(article) =>
				`${new URL(`posts/${article.slug}/`, site)}\n${titles.get(article.slug)}`,
		),
		...podcastEpisodes.flatMap((episode) => [
			`${new URL(`podcast/${episode.slug}/`, site)}\n${episode.title}`,
			`${new URL(`podcast/${episode.slug}/transcript/`, site)}\n${episode.title} — Transcript`,
		]),
	];
	compareExactValues(
		actualRecords,
		expectedRecords,
		"Pagefind records",
		failures,
	);
	if (records.length !== expectedPageCount) {
		failures.push(
			`Pagefind must emit exactly ${expectedPageCount} approved fragments`,
		);
	}
	return records.length;
}

export function artifactBufferHasPrivateReference(buffer) {
	if (!(buffer instanceof Uint8Array)) {
		throw new TypeError("built artifact must be provided as bytes");
	}
	// Latin-1 preserves every byte one-for-one, so arbitrary binary assets can be
	// searched for embedded ASCII references without lossy text decoding.
	return hasPrivateProtonReference(Buffer.from(buffer).toString("latin1"));
}

export async function verifyNoPrivateBuildReferences(files, failures) {
	for (const [index, file] of files.entries()) {
		try {
			if (artifactBufferHasPrivateReference(await readFile(file))) {
				failures.push(
					`built artifact ${index + 1} contains a private, raw-source, or local-runtime reference`,
				);
			}
		} catch {
			failures.push(
				`built artifact ${index + 1} could not be scanned for private references`,
			);
		}
	}
}

export function verifyPodcastArtifacts(
	files,
	distRoot,
	podcastEpisodes,
	failures,
) {
	const expected = new Set();
	if (podcastEpisodes.length > 0) {
		expected.add("podcast/index.html");
		expected.add(PODCAST_SHOW.artwork.publicPath.replace(/^\//u, ""));
		for (const episode of podcastEpisodes) {
			expected.add(`podcast/${episode.slug}/index.html`);
			expected.add(`podcast/${episode.slug}/transcript/index.html`);
			expected.add(episode.audio.publicPath.replace(/^\//u, ""));
			if (episode.transcript === null) {
				failures.push(
					`Approved podcast episode lacks a transcript: ${episode.slug}`,
				);
				continue;
			}
			if (
				episode.transcript.publicPath !== `/podcast/${episode.slug}/transcript/`
			) {
				failures.push(
					`Approved podcast transcript route differs from its slug: ${episode.slug}`,
				);
			}
			if (episode.transcript.vttPath) {
				expected.add(episode.transcript.vttPath.replace(/^\//u, ""));
			}
		}
	}
	const actual = [];
	for (const file of files) {
		const relative = normalizedPath(path.relative(distRoot, file));
		if (relative === "podcast/feed.xml")
			failures.push(
				"Podcast feed must remain private before the custom domain",
			);
		if (
			/^podcast\//u.test(relative) ||
			/^media\/podcast\//u.test(relative) ||
			AUDIO_ARTIFACT_PATTERN.test(relative)
		) {
			actual.push(relative);
		}
	}
	compareExactValues(
		actual,
		[...expected],
		"podcast build artifacts",
		failures,
	);
}

export async function verifyBuiltSite({
	dist = DEFAULT_DIST,
	site: siteValue = DEFAULT_SITE,
	repoRoot: repoRootValue = process.cwd(),
	requireSignoff = false,
	releaseTarget = "catalog",
} = {}) {
	const distRoot = path.resolve(dist);
	const repoRoot = path.resolve(repoRootValue);
	const site = new URL(siteValue);
	if (!RELEASE_TARGETS.has(releaseTarget))
		throw new Error(`Unsupported release target: ${releaseTarget}`);
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
	const archiveManifest = await verifyArchiveManifest(
		repoRoot,
		distRoot,
		site,
		failures,
		{
			requireSignoff,
			notices,
			validateReviewCommitBinding: true,
		},
	);
	let expectedPageUrls = [];
	let rssItems = 0;
	let pagefindRecords = 0;
	let archiveEntries = 0;
	let authorWorks = 0;
	let nonfictionEntries = 0;
	let publicationManifest = archiveManifest;
	const podcastEpisodes =
		releaseTarget === "catalog" ? getApprovedPodcastEpisodes() : [];
	if (archiveManifest) {
		publicationManifest = await loadPublicationManifest(
			repoRoot,
			archiveManifest,
			releaseTarget,
			failures,
		);
		const additionalRoutes = [];
		if (
			publicationManifest.articles.some(
				(article) => article.section === "nonfiction",
			)
		)
			additionalRoutes.push("nonfiction/");
		if (podcastEpisodes.length > 0) {
			additionalRoutes.push("podcast/");
			for (const episode of podcastEpisodes) {
				additionalRoutes.push(`podcast/${episode.slug}/`);
				additionalRoutes.push(`podcast/${episode.slug}/transcript/`);
			}
		}
		expectedPageUrls = await verifyLaunchRoutes(
			distRoot,
			htmlFiles,
			postPages,
			publicationManifest,
			site,
			failures,
			additionalRoutes,
		);
		rssItems = await verifyLaunchRss(
			distRoot,
			publicationManifest,
			site,
			failures,
		);
		await verifyHomePublicationDates(
			repoRoot,
			distRoot,
			publicationManifest,
			failures,
		);
		archiveEntries = await verifyArchiveIndex(
			distRoot,
			publicationManifest,
			site,
			failures,
		);
		nonfictionEntries = await verifyNonfictionIndex(
			distRoot,
			publicationManifest,
			failures,
		);
		await verifyMediumRenderedBodies(
			repoRoot,
			distRoot,
			publicationManifest,
			failures,
			site,
		);
		authorWorks = await verifyAuthorPage(
			repoRoot,
			distRoot,
			publicationManifest,
			site,
			failures,
		);
		pagefindRecords = await verifyPagefind(
			repoRoot,
			distRoot,
			publicationManifest,
			site,
			failures,
			podcastEpisodes,
		);
		await verifyDraftSources(repoRoot, publicationManifest, failures);
	}
	await verifyHomepageMetadata(
		distRoot,
		site,
		publicationManifest ?? { articles: [] },
		failures,
	);
	await verifyCustomNotFound(distRoot, site, failures);
	await verifySitemap(distRoot, site, expectedPageUrls, failures);
	for (const failure of validateNoProjectRobots(
		files.map((file) => normalizedPath(path.relative(distRoot, file))),
	)) {
		failures.push(failure);
	}
	await verifyNoPrivateBuildReferences(files, failures);
	verifyPodcastArtifacts(files, distRoot, podcastEpisodes, failures);
	const imageVerification = await inspectBuiltImages({
		dist: distRoot,
		repoRoot,
		files,
	});
	failures.push(...imageVerification.failures);

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
		nonfictionEntries,
		podcastEpisodes: podcastEpisodes.length,
		imageStats: imageVerification.stats,
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
