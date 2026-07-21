import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_DIST = "dist";
const DEFAULT_SITE = "https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/";

function parseArguments(argv) {
	const options = { dist: DEFAULT_DIST, site: DEFAULT_SITE };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
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
		.replace(/&#(\d+);/g, (_, codePoint) => String.fromCodePoint(Number(codePoint)))
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
			`<([a-z][a-z0-9]*)\\b[^>]*data-vocal-field=["']${escapedField}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
			"i",
		),
	);
	return match ? visibleText(match[2]) : undefined;
}

function xmlElementText(xml, name) {
	const escapedName = escapeRegExp(name);
	const match = xml.match(
		new RegExp(`<${escapedName}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${escapedName}>`),
	);
	return match ? decodeHtml(match[1]) : undefined;
}

function attributes(tag) {
	const result = {};
	const expression = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	for (const match of tag.matchAll(expression)) {
		result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
	}
	return result;
}

function tags(html, name) {
	return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map(
		(match) => ({ raw: match[0], attributes: attributes(match[0]) }),
	);
}

function expectedPageUrl(filePath, distRoot, site) {
	const relativePath = path.relative(distRoot, filePath).replace(/\\/g, "/");
	if (relativePath === "index.html") return site.toString();
	if (relativePath.endsWith("/index.html")) {
		return new URL(relativePath.slice(0, -"index.html".length), site).toString();
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

async function resolveBuiltUrl(rawValue, pageUrl, distRoot, site, label, failures) {
	if (!rawValue || /^(?:#|mailto:|tel:|data:|javascript:)/i.test(rawValue)) return;
	let target;
	try {
		target = new URL(decodeHtml(rawValue), pageUrl);
	} catch {
		failures.push(`${label}: invalid URL ${rawValue}`);
		return;
	}
	if (target.origin !== site.origin) return;

	const basePath = site.pathname.endsWith("/") ? site.pathname : `${site.pathname}/`;
	if (target.pathname !== basePath.slice(0, -1) && !target.pathname.startsWith(basePath)) {
		failures.push(`${label}: same-origin URL escapes the configured base path: ${target}`);
		return;
	}

	let relativePath = target.pathname === basePath.slice(0, -1)
		? ""
		: target.pathname.slice(basePath.length);
	try {
		relativePath = decodeURIComponent(relativePath);
	} catch {
		failures.push(`${label}: URL path is not valid percent-encoding: ${target}`);
		return;
	}
	const candidates = relativePath.endsWith("/") || relativePath === ""
		? [path.join(distRoot, relativePath, "index.html")]
		: [
				path.join(distRoot, relativePath),
				path.join(distRoot, relativePath, "index.html"),
			];
	if (!(await Promise.any(candidates.map(async (candidate) => {
		if (!(await isFile(candidate))) throw new Error("missing");
		return candidate;
	})).catch(() => undefined))) {
		failures.push(`${label}: built target is missing for ${target}`);
	}
}

function extractJsonLd(html, label, failures) {
	const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
		.filter((match) => attributes(match[1]).type === "application/ld+json");
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
		failures.push(`${relativePath}: canonical ${canonical ?? "<missing>"} does not equal ${pageUrl}`);
	}
	if (canonical?.startsWith("https://vocal.media/")) {
		failures.push(`${relativePath}: Vocal must not be the canonical URL`);
	}

	for (const selector of ["description", "author", "og:url", "og:title", "og:description"]) {
		const values = metaContent(html, selector);
		if (values.length !== 1 || !values[0]) {
			failures.push(`${relativePath}: expected one nonempty ${selector} meta value`);
		}
	}
	for (const selector of ["og:url", "twitter:url"]) {
		const values = metaContent(html, selector);
		if (values.length !== 1 || values[0] !== canonical) {
			failures.push(`${relativePath}: ${selector} must equal the canonical URL`);
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
					urlAttributes.push([tag.attributes[attributeName], `${relativePath} ${tagName}[${attributeName}]`]);
				}
			}
			if (tag.attributes.srcset) {
				for (const candidate of tag.attributes.srcset.split(",")) {
					const candidateUrl = candidate.trim().split(/\s+/)[0];
					if (candidateUrl) urlAttributes.push([candidateUrl, `${relativePath} ${tagName}[srcset]`]);
				}
			}
		}
	}
	for (const [target, label] of urlAttributes) {
		await resolveBuiltUrl(target, pageUrl, distRoot, site, label, failures);
	}

	if (relativePath.startsWith("posts/") && relativePath.endsWith("/index.html")) {
		postPages.push(pageUrl);
		const jsonLd = extractJsonLd(html, relativePath, failures);
		if (!jsonLd) return;
		if (jsonLd["@type"] !== "BlogPosting") failures.push(`${relativePath}: JSON-LD type is not BlogPosting`);
		if (!jsonLd.headline || !jsonLd.author?.name || !jsonLd.datePublished) {
			failures.push(`${relativePath}: JSON-LD lacks headline, author, or publication date`);
		}
		if (jsonLd.url !== canonical || jsonLd.mainEntityOfPage?.["@id"] !== canonical) {
			failures.push(`${relativePath}: JSON-LD page URLs do not equal the canonical URL`);
		}
		if (jsonLd.image) {
			for (const key of ["url", "contentUrl"]) {
				if (!jsonLd.image[key]) failures.push(`${relativePath}: JSON-LD image.${key} is missing`);
				else await resolveBuiltUrl(jsonLd.image[key], pageUrl, distRoot, site, `${relativePath} JSON-LD image.${key}`, failures);
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
	if (!/<rss\b/.test(xml) || !/<channel>/.test(xml)) failures.push("rss.xml is not an RSS channel");
	const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1]);
	if (itemBlocks.length !== postPages.length) {
		failures.push(`rss.xml has ${itemBlocks.length} items but ${postPages.length} post pages were built`);
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
			failures.push(`rss.xml item ${index + 1} GUID does not equal its local link`);
		}
		await resolveBuiltUrl(absolute.toString(), site, distRoot, site, `rss.xml item ${index + 1}`, failures);
	}
	for (const postPage of postPages) {
		if (!rssLinks.includes(postPage)) failures.push(`rss.xml is missing post ${postPage}`);
	}
	for (const match of xml.matchAll(/<media:content\b[^>]*\burl="([^"]+)"/g)) {
		const imageUrl = decodeHtml(match[1]);
		if (!/^https?:\/\//.test(imageUrl)) failures.push(`rss.xml image URL is not absolute: ${imageUrl}`);
		else await resolveBuiltUrl(imageUrl, site, distRoot, site, "rss.xml media image", failures);
	}
}

async function verifySitemap(distRoot, site, failures) {
	const indexPath = path.join(distRoot, "sitemap-index.xml");
	if (!(await isFile(indexPath))) {
		failures.push("sitemap-index.xml is missing");
		return;
	}
	const indexXml = await readFile(indexPath, "utf8");
	for (const match of indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
		await resolveBuiltUrl(decodeHtml(match[1]), site, distRoot, site, "sitemap index", failures);
	}
	const sitemapFiles = (await walk(distRoot)).filter((file) => /sitemap-\d+\.xml$/.test(file));
	if (sitemapFiles.length === 0) failures.push("no sitemap content file was built");
	for (const file of sitemapFiles) {
		const xml = await readFile(file, "utf8");
		for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
			await resolveBuiltUrl(decodeHtml(match[1]), site, distRoot, site, path.basename(file), failures);
		}
	}
}

function sameStringArray(left, right) {
	return (
		Array.isArray(left) &&
		Array.isArray(right) &&
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

async function verifyVocalManifest(repoRoot, distRoot, site, failures) {
	const manifestPath = path.join(repoRoot, "provenance", "vocal", "manifest.json");
	if (!(await isFile(manifestPath))) return;

	let manifest;
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch (error) {
		failures.push(`Vocal manifest is invalid JSON (${error.message})`);
		return;
	}
	if (!Array.isArray(manifest.articles)) {
		failures.push("Vocal manifest has no articles array");
		return;
	}

	const rssPath = path.join(distRoot, "rss.xml");
	const rssXml = (await isFile(rssPath)) ? await readFile(rssPath, "utf8") : "";
	const rssItems = [...rssXml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(
		(match) => match[1],
	);

	for (const entry of manifest.articles) {
		const label = `Vocal ${entry.slug}`;
		const snapshotPath = path.join(repoRoot, ...String(entry.paths?.snapshot ?? "").split("/"));
		const sourceImagePath = path.join(repoRoot, ...String(entry.paths?.image ?? "").split("/"));
		if (!(await isFile(snapshotPath))) {
			failures.push(`${label}: snapshot is missing`);
			continue;
		}
		let post;
		try {
			post = JSON.parse(await readFile(snapshotPath, "utf8"));
		} catch (error) {
			failures.push(`${label}: snapshot is invalid JSON (${error.message})`);
			continue;
		}

		if (await isFile(sourceImagePath)) {
			const imageBytes = await readFile(sourceImagePath);
			const digest = `sha256:${createHash("sha256").update(imageBytes).digest("hex")}`;
			if (digest !== entry.hashes?.image) failures.push(`${label}: repository PNG hash differs from manifest`);
		} else {
			failures.push(`${label}: repository PNG is missing`);
		}

		const pagePath = path.join(distRoot, "posts", entry.slug, "index.html");
		if (!(await isFile(pagePath))) {
			failures.push(`${label}: built article route is missing`);
			continue;
		}
		const html = await readFile(pagePath, "utf8");
		const expectedUrl = new URL(`posts/${entry.slug}/`, site).toString();
		const canonical = getCanonical(html, label, failures);
		if (canonical !== expectedUrl) failures.push(`${label}: canonical URL is not the expected local route`);

		for (const [field, expected] of [
			["title", post.name],
			["subtitle", post.subtitle],
			["author", `By ${manifest.author?.name}`],
			["image-caption", post.heroImageCaption],
		]) {
			if (markedField(html, field) !== expected) failures.push(`${label}: visible ${field} differs from snapshot`);
		}
		const sourceLinks = tags(html, "a").filter((tag) =>
			Object.hasOwn(tag.attributes, "data-vocal-source-url"),
		);
		if (sourceLinks.length !== 1 || sourceLinks[0].attributes.href !== entry.sourceUrl) {
			failures.push(`${label}: expected one exact visible Vocal provenance link`);
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

		const jsonLd = extractJsonLd(html, label, failures);
		const expectedModified =
			post.contentUpdatedAt !== null &&
			new Date(post.contentUpdatedAt).valueOf() > new Date(post.publishedAt).valueOf()
				? post.contentUpdatedAt
				: undefined;
		const expectedTags = post.tags.map((tag) => tag.name);
		if (jsonLd) {
			const expectedValues = [
				["headline", jsonLd.headline, post.name],
				["alternativeHeadline", jsonLd.alternativeHeadline, post.subtitle],
				["description", jsonLd.description, post.subtitle],
				["author", jsonLd.author?.name, manifest.author?.name],
				["datePublished", jsonLd.datePublished, post.publishedAt],
				["dateModified", jsonLd.dateModified, expectedModified],
				["url", jsonLd.url, expectedUrl],
				["mainEntityOfPage", jsonLd.mainEntityOfPage?.["@id"], expectedUrl],
				["source", jsonLd.isBasedOn, entry.sourceUrl],
				["category", jsonLd.articleSection, post.vocalSite.name],
				["wordCount", jsonLd.wordCount, post.wordCount],
				["license", jsonLd.copyrightNotice, "All Rights Reserved"],
				["caption", jsonLd.image?.caption, post.heroImageCaption || undefined],
				["image source", jsonLd.image?.sameAs, post.heroImage.id],
			];
			for (const [field, actual, expected] of expectedValues) {
				if (actual !== expected) failures.push(`${label}: JSON-LD ${field} differs from snapshot`);
			}
			if (!sameStringArray(jsonLd.keywords, expectedTags)) failures.push(`${label}: JSON-LD tag order differs from snapshot`);
			const expectedAlt = post.heroImageAltText ?? `Cover image for “${post.name}”`;
			if (jsonLd.image?.description !== expectedAlt) failures.push(`${label}: JSON-LD image alt fallback differs`);
			if (jsonLd.image?.url !== jsonLd.image?.contentUrl) failures.push(`${label}: JSON-LD image must use one local emitted URL`);
			for (const selector of ["og:image", "twitter:image"]) {
				const values = metaContent(html, selector);
				if (values.length !== 1 || values[0] !== jsonLd.image?.url) failures.push(`${label}: ${selector} does not match JSON-LD image`);
			}
			for (const selector of ["og:image:alt", "twitter:image:alt"]) {
				const values = metaContent(html, selector);
				if (values.length !== 1 || values[0] !== expectedAlt) failures.push(`${label}: ${selector} differs from the alt contract`);
			}
		}

		const heroMatch = html.match(/<figure\b[^>]*data-vocal-hero[^>]*>([\s\S]*?)<\/figure>/i);
		const heroImages = heroMatch ? tags(heroMatch[1], "img") : [];
		const expectedAlt = post.heroImageAltText ?? `Cover image for “${post.name}”`;
		if (heroImages.length !== 1 || heroImages[0].attributes.alt !== expectedAlt) {
			failures.push(`${label}: visible hero or its alt text differs`);
		}

		const matchingRssItems = rssItems.filter(
			(item) => xmlElementText(item, "link") === expectedUrl,
		);
		if (matchingRssItems.length !== 1) {
			failures.push(`${label}: RSS must contain exactly one local item`);
		} else {
			const item = matchingRssItems[0];
			if (xmlElementText(item, "guid") !== expectedUrl) failures.push(`${label}: RSS GUID differs from local URL`);
			if (xmlElementText(item, "description") !== post.summary) failures.push(`${label}: RSS summary differs from snapshot`);
			if (xmlElementText(item, "dc:creator") !== manifest.author?.name) failures.push(`${label}: RSS author differs from snapshot`);
			if (xmlElementText(item, "dc:source") !== entry.sourceUrl) failures.push(`${label}: RSS source differs from manifest`);
			const categories = [...item.matchAll(/<category>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/g)].map((match) => decodeHtml(match[1]));
			const expectedCategories = [...expectedTags, post.vocalSite.name];
			if (!sameStringArray(categories, expectedCategories)) failures.push(`${label}: RSS category order differs from snapshot`);
		}
	}
}

export async function verifyBuiltSite({ dist = DEFAULT_DIST, site: siteValue = DEFAULT_SITE, repoRoot: repoRootValue = process.cwd() } = {}) {
	const distRoot = path.resolve(dist);
	const repoRoot = path.resolve(repoRootValue);
	const site = new URL(siteValue);
	if (!site.pathname.endsWith("/")) site.pathname += "/";
	const files = await walk(distRoot);
	const htmlFiles = files.filter((file) => file.endsWith(".html"));
	if (htmlFiles.length === 0) throw new Error(`No built HTML files found under ${distRoot}`);

	const failures = [];
	const postPages = [];
	for (const file of htmlFiles) await verifyHtml(file, distRoot, site, failures, postPages);
	await verifyRss(distRoot, site, failures, postPages);
	await verifySitemap(distRoot, site, failures);
	await verifyVocalManifest(repoRoot, distRoot, site, failures);

	if (failures.length > 0) {
		throw new Error(`Built-site verification failed:\n- ${failures.join("\n- ")}`);
	}
	return { htmlPages: htmlFiles.length, postPages: postPages.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		const result = await verifyBuiltSite(parseArguments(process.argv.slice(2)));
		console.log(`Built-site verification passed: ${result.htmlPages} HTML pages, ${result.postPages} posts`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
