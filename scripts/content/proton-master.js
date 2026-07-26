import { randomUUID } from "node:crypto";
import {
	link,
	lstat,
	mkdir,
	realpath,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parse } from "parse5";
import sharp from "sharp";
import {
	assertSlug,
	DEFAULT_REPO_ROOT,
	getMediumPaths,
	MediumContractError,
	resolveInside,
	serializeJson,
} from "../medium/lib/contract.js";
import { readBoundedRegularFileInside } from "../medium/lib/fs-safety.js";
import { decodeUtf8, validateMediumDocument } from "../medium/lib/html.js";
import { inspectImage, sha256 } from "../medium/lib/integrity.js";
import {
	validateMediumInventory,
	validateMediumManifest,
	validateMediumSnapshot,
} from "../medium/lib/model.js";
import { renderMediumIndexMarkdown } from "../medium/lib/render.js";

const MASTER_SCHEMA_VERSION = 1;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_HTML_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const CANONICAL_MARK_ORDER = ["bold", "italic", "code"];
const WRAPPER_TAGS = new Set(["article", "div", "header", "main", "section"]);
const BLOCK_TAGS = new Set([
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"ul",
	"ol",
	"hr",
	"figure",
	"img",
	"pre",
]);
const INLINE_TAGS = new Set([
	"span",
	"font",
	"strong",
	"b",
	"em",
	"i",
	"code",
	"a",
	"br",
]);
const PASSIVE_ATTRIBUTES = new Set([
	"alt",
	"charset",
	"class",
	"content",
	"data-shots-asset",
	"data-shots-role",
	"data-shots-slug",
	"dir",
	"height",
	"href",
	"http-equiv",
	"lang",
	"name",
	"rel",
	"src",
	"start",
	"style",
	"target",
	"width",
]);

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function assertNoProtonUrl(value, label) {
	let url;
	try {
		url = new URL(value);
	} catch {
		return;
	}
	const hostname = url.hostname.toLowerCase();
	if (
		hostname === "proton.me" ||
		hostname.endsWith(".proton.me") ||
		hostname === "protonmail.com" ||
		hostname.endsWith(".protonmail.com") ||
		hostname === "protonusercontent.com" ||
		hostname.endsWith(".protonusercontent.com")
	) {
		throw new MediumContractError(`${label} must not contain a Proton URL`);
	}
}

function htmlAttributes(node, label) {
	const result = {};
	for (const attribute of node.attrs ?? []) {
		if (Object.hasOwn(result, attribute.name)) {
			throw new MediumContractError(
				`${label} repeats attribute ${attribute.name}`,
			);
		}
		if (
			attribute.name.startsWith("on") ||
			attribute.name.includes("proton") ||
			attribute.name === "id" ||
			attribute.name === "data-doc-id" ||
			!PASSIVE_ATTRIBUTES.has(attribute.name)
		) {
			throw new MediumContractError(
				`${label} contains unsupported or identifying attribute ${attribute.name}`,
			);
		}
		if (/url\s*\(/iu.test(attribute.value)) {
			throw new MediumContractError(`${label}.${attribute.name} loads a URL`);
		}
		assertNoProtonUrl(attribute.value, `${label}.${attribute.name}`);
		result[attribute.name] = attribute.value;
	}
	return result;
}

function walkElements(node, callback) {
	if (node.tagName) callback(node);
	for (const child of node.childNodes ?? []) walkElements(child, callback);
}

function parseHtmlDocument(html, label) {
	const errors = [];
	const document = parse(html, {
		onParseError: (error) => errors.push(error),
	});
	const structuralError = errors.find(
		(error) => error.code !== "missing-doctype",
	);
	if (structuralError) {
		throw new MediumContractError(
			`${label} contains malformed HTML (${structuralError.code})`,
		);
	}
	const bodies = [];
	walkElements(document, (node) => {
		if (node.tagName === "body") bodies.push(node);
		if (
			new Set([
				"script",
				"iframe",
				"object",
				"embed",
				"form",
				"base",
				"link",
			]).has(node.tagName)
		) {
			throw new MediumContractError(
				`${label} contains active <${node.tagName}> markup`,
			);
		}
		const attributes = htmlAttributes(node, `${label} <${node.tagName}>`);
		if (node.tagName === "style") {
			const css = (node.childNodes ?? [])
				.map((child) => (child.nodeName === "#text" ? child.value : ""))
				.join("");
			if (/@import\b|url\s*\(/iu.test(css)) {
				throw new MediumContractError(
					`${label} contains a stylesheet network reference`,
				);
			}
		}
		for (const resourceName of ["src", "poster", "srcset"]) {
			const resource = attributes[resourceName];
			if (
				resource &&
				!resource.startsWith("data:") &&
				/^[a-z][a-z0-9+.-]*:/iu.test(resource)
			) {
				throw new MediumContractError(
					`${label} contains a network or non-file ${resourceName}`,
				);
			}
		}
	});
	if (bodies.length !== 1) {
		throw new MediumContractError(`${label} must contain exactly one body`);
	}
	return bodies[0];
}

function significantChildren(node, label) {
	const result = [];
	for (const [index, child] of (node.childNodes ?? []).entries()) {
		if (child.nodeName === "#text" && /^\s*$/u.test(child.value)) continue;
		if (child.nodeName === "#comment") {
			throw new MediumContractError(`${label} contains an HTML comment`);
		}
		result.push(child);
		if (!child.tagName && child.nodeName !== "#text") {
			throw new MediumContractError(
				`${label}.childNodes[${index}] is unsupported`,
			);
		}
	}
	return result;
}

function flattenBlockNodes(node, label, output = []) {
	for (const [index, child] of significantChildren(node, label).entries()) {
		const childLabel = `${label}.childNodes[${index}]`;
		if (child.nodeName === "#text") {
			throw new MediumContractError(
				`${childLabel} contains text outside a semantic block`,
			);
		}
		if (WRAPPER_TAGS.has(child.tagName)) {
			htmlAttributes(child, childLabel);
			flattenBlockNodes(child, childLabel, output);
			continue;
		}
		if (!BLOCK_TAGS.has(child.tagName)) {
			throw new MediumContractError(
				`${childLabel} uses unsupported block <${child.tagName}>`,
			);
		}
		output.push(child);
	}
	return output;
}

function sameTokenShape(left, right) {
	return (
		left.type === "text" &&
		right.type === "text" &&
		left.href === right.href &&
		left.marks.length === right.marks.length &&
		left.marks.every((mark, index) => mark === right.marks[index])
	);
}

function normalizeInlineTokens(tokens) {
	const result = [];
	for (const token of tokens) {
		if (token.type === "text" && token.text.length === 0) continue;
		const previous = result.at(-1);
		if (previous && sameTokenShape(previous, token)) {
			previous.text += token.text;
		} else {
			result.push(token);
		}
	}
	return result;
}

function extractInline(nodes, label, marks = new Set(), href = null) {
	const tokens = [];
	for (const [index, node] of nodes.entries()) {
		const childLabel = `${label}.childNodes[${index}]`;
		if (node.nodeName === "#text") {
			tokens.push({
				type: "text",
				text: node.value,
				marks: CANONICAL_MARK_ORDER.filter((mark) => marks.has(mark)),
				...(href === null ? {} : { href }),
			});
			continue;
		}
		if (node.nodeName === "#comment") {
			throw new MediumContractError(`${childLabel} contains a comment`);
		}
		if (!node.tagName || !INLINE_TAGS.has(node.tagName)) {
			throw new MediumContractError(
				`${childLabel} uses unsupported inline <${node.tagName ?? node.nodeName}>`,
			);
		}
		const attributes = htmlAttributes(node, childLabel);
		if (node.tagName === "br") {
			if ((node.childNodes ?? []).length !== 0) {
				throw new MediumContractError(`${childLabel} br must be empty`);
			}
			tokens.push({ type: "break" });
			continue;
		}
		const nextMarks = new Set(marks);
		if (node.tagName === "strong" || node.tagName === "b") {
			nextMarks.add("bold");
		}
		if (node.tagName === "em" || node.tagName === "i") {
			nextMarks.add("italic");
		}
		if (node.tagName === "code") nextMarks.add("code");
		let nextHref = href;
		if (node.tagName === "a") {
			if (href !== null) {
				throw new MediumContractError(`${childLabel} nests a link`);
			}
			if (!attributes.href) {
				throw new MediumContractError(`${childLabel} link has no href`);
			}
			let url;
			try {
				url = new URL(attributes.href);
			} catch (error) {
				throw new MediumContractError(
					`${childLabel} link must be an absolute URL`,
					{ cause: error },
				);
			}
			if (url.protocol !== "https:") {
				throw new MediumContractError(`${childLabel} link must use HTTPS`);
			}
			assertNoProtonUrl(url.toString(), `${childLabel}.href`);
			nextHref = attributes.href;
		}
		tokens.push(
			...extractInline(node.childNodes ?? [], childLabel, nextMarks, nextHref),
		);
	}
	return normalizeInlineTokens(tokens);
}

function renderInlineToken(token) {
	if (token.type === "break") return "<br />";
	let result = escapeHtml(token.text);
	if (token.marks.includes("code")) result = `<code>${result}</code>`;
	if (token.marks.includes("italic")) result = `<em>${result}</em>`;
	if (token.marks.includes("bold")) result = `<strong>${result}</strong>`;
	if (token.href) result = `<a href="${escapeHtml(token.href)}">${result}</a>`;
	return result;
}

function renderInline(tokens) {
	return tokens.map(renderInlineToken).join("");
}

async function decodedImage(buffer, label) {
	const inspection = inspectImage(buffer, label);
	let pixels;
	try {
		pixels = await sharp(buffer, {
			animated: true,
			failOn: "warning",
			limitInputPixels: 100_000_000,
			sequentialRead: true,
		})
			.toColourspace("srgb")
			.ensureAlpha()
			.raw({ depth: "uchar" })
			.toBuffer({ resolveWithObject: true });
	} catch (error) {
		throw new MediumContractError(`${label} pixel decoding failed`, {
			cause: error,
		});
	}
	if (
		pixels.info.width !== inspection.width ||
		pixels.info.height !== inspection.height
	) {
		throw new MediumContractError(
			`${label} decoded dimensions are inconsistent`,
		);
	}
	return {
		...inspection,
		pixelSha256: sha256(pixels.data),
	};
}

function assertSanitizedHeroContainer(buffer, label) {
	if (
		buffer.byteLength < 21 ||
		buffer.toString("ascii", 0, 4) !== "RIFF" ||
		buffer.toString("ascii", 8, 12) !== "WEBP" ||
		buffer.readUInt32LE(4) !== buffer.byteLength - 8
	) {
		throw new MediumContractError(`${label} is not a complete WebP container`);
	}
	let offset = 12;
	const chunks = [];
	while (offset < buffer.byteLength) {
		if (offset > buffer.byteLength - 8) {
			throw new MediumContractError(`${label} has a truncated WebP chunk`);
		}
		const type = buffer.toString("ascii", offset, offset + 4);
		const byteLength = buffer.readUInt32LE(offset + 4);
		const dataEnd = offset + 8 + byteLength;
		const paddedEnd = dataEnd + (byteLength % 2);
		if (dataEnd < offset || paddedEnd > buffer.byteLength) {
			throw new MediumContractError(`${label} has an invalid WebP chunk`);
		}
		chunks.push(type);
		offset = paddedEnd;
	}
	if (
		offset !== buffer.byteLength ||
		chunks.length !== 1 ||
		chunks[0] !== "VP8L"
	) {
		throw new MediumContractError(
			`${label} must be the metadata-free lossless sanitized hero`,
		);
	}
}

function dataUrl(mimeType, buffer) {
	return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function renderFigure(block, assetsBySourceUrl) {
	const asset = assetsBySourceUrl.get(block.sourceUrl);
	if (!asset) {
		throw new MediumContractError(
			`No approved local image maps body figure ${block.sourceUrl}`,
		);
	}
	const caption = renderInline(block.caption);
	return [
		`<figure data-shots-asset="${escapeHtml(asset.id)}">`,
		`<img src="${dataUrl(asset.mimeType, asset.buffer)}" alt="${escapeHtml(block.alt)}" width="${asset.width}" height="${asset.height}" />`,
		...(caption.length > 0 ? [`<figcaption>${caption}</figcaption>`] : []),
		"</figure>",
	].join("\n");
}

function renderBlock(block, assetsBySourceUrl) {
	if (block.type === "paragraph") {
		return `<p>${renderInline(block.children)}</p>`;
	}
	if (block.type === "heading") {
		return `<h${block.level}>${renderInline(block.children)}</h${block.level}>`;
	}
	if (block.type === "blockquote") {
		return `<blockquote>\n${block.blocks
			.map((child) => renderBlock(child, assetsBySourceUrl))
			.join("\n")}\n</blockquote>`;
	}
	if (block.type === "list") {
		const tag = block.ordered ? "ol" : "ul";
		const start =
			block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
		return `<${tag}${start}>\n${block.items
			.map(
				(item) =>
					`<li>\n${item
						.map((child) => renderBlock(child, assetsBySourceUrl))
						.join("\n")}\n</li>`,
			)
			.join("\n")}\n</${tag}>`;
	}
	if (block.type === "thematicBreak") return "<hr />";
	if (block.type === "codeBlock") {
		return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
	}
	if (block.type === "figure") return renderFigure(block, assetsBySourceUrl);
	throw new MediumContractError(
		`Unsupported Proton master block ${block.type}`,
	);
}

function canonicalInline(tokens) {
	return normalizeInlineTokens(
		tokens.map((token) =>
			token.type === "break"
				? { type: "break" }
				: {
						type: "text",
						text: token.text,
						marks: [...token.marks],
						...(token.href === undefined ? {} : { href: token.href }),
					},
		),
	);
}

function canonicalExpectedBlock(block, assetsBySourceUrl) {
	if (block.type === "paragraph" || block.type === "heading") {
		return {
			type: block.type,
			...(block.type === "heading" ? { level: block.level } : {}),
			children: canonicalInline(block.children),
		};
	}
	if (block.type === "blockquote") {
		return {
			type: "blockquote",
			blocks: block.blocks.map((child) =>
				canonicalExpectedBlock(child, assetsBySourceUrl),
			),
		};
	}
	if (block.type === "list") {
		return {
			type: "list",
			ordered: block.ordered,
			start: block.start,
			items: block.items.map((item) =>
				item.map((child) => canonicalExpectedBlock(child, assetsBySourceUrl)),
			),
		};
	}
	if (block.type === "thematicBreak" || block.type === "codeBlock") {
		return { ...block };
	}
	const asset = assetsBySourceUrl.get(block.sourceUrl);
	if (!asset) {
		throw new MediumContractError(
			`No approved local image maps body figure ${block.sourceUrl}`,
		);
	}
	return {
		type: "figure",
		alt: block.alt,
		caption: canonicalInline(block.caption),
		image: {
			width: asset.width,
			height: asset.height,
			pixelSha256: asset.pixelSha256,
		},
	};
}

async function readJsonFile(repoRoot, repositoryPath, label) {
	const buffer = await readBoundedRegularFileInside({
		root: repoRoot,
		filePath: resolveInside(repoRoot, repositoryPath, label),
		label,
		maxBytes: MAX_JSON_BYTES,
	});
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
	return { buffer, value };
}

async function loadApprovedAsset(repoRoot, inventoryAsset, manifestAsset) {
	if (
		!manifestAsset ||
		manifestAsset.id !== inventoryAsset.id ||
		manifestAsset.role !== inventoryAsset.role ||
		manifestAsset.sha256 !== inventoryAsset.sha256 ||
		manifestAsset.mimeType !== inventoryAsset.mimeType ||
		manifestAsset.width !== inventoryAsset.width ||
		manifestAsset.height !== inventoryAsset.height ||
		manifestAsset.byteSize !== inventoryAsset.byteSize
	) {
		throw new MediumContractError(
			`Medium manifest asset differs for ${inventoryAsset.id}`,
		);
	}
	const buffer = await readBoundedRegularFileInside({
		root: repoRoot,
		filePath: resolveInside(
			repoRoot,
			manifestAsset.path,
			`Asset ${inventoryAsset.id}`,
		),
		label: `Asset ${inventoryAsset.id}`,
		maxBytes: MAX_IMAGE_BYTES,
		expectedBytes: inventoryAsset.byteSize,
	});
	const decoded = await decodedImage(buffer, `Asset ${inventoryAsset.id}`);
	if (inventoryAsset.role === "hero") {
		assertSanitizedHeroContainer(buffer, `Asset ${inventoryAsset.id}`);
	}
	if (
		sha256(buffer) !== inventoryAsset.sha256 ||
		decoded.mimeType !== inventoryAsset.mimeType ||
		decoded.width !== inventoryAsset.width ||
		decoded.height !== inventoryAsset.height ||
		(inventoryAsset.role === "hero" &&
			decoded.pixelSha256 !== inventoryAsset.pixelSha256)
	) {
		throw new MediumContractError(
			`Approved asset bytes or pixels differ for ${inventoryAsset.id}`,
		);
	}
	return {
		...inventoryAsset,
		buffer,
		pixelSha256: decoded.pixelSha256,
	};
}

export async function loadMediumMasterEvidence({
	repoRoot = DEFAULT_REPO_ROOT,
	slug: slugValue,
} = {}) {
	const slug = assertSlug(slugValue, "Medium master slug");
	const inventoryFile = await readJsonFile(
		repoRoot,
		"provenance/medium/inventory.json",
		"Medium inventory",
	);
	const inventory = validateMediumInventory(inventoryFile.value);
	if (inventory.state !== "reviewed") {
		throw new MediumContractError(
			"Medium master packages require a reviewed official-export inventory",
		);
	}
	const manifestFile = await readJsonFile(
		repoRoot,
		"provenance/medium/manifest.json",
		"Medium manifest",
	);
	const manifest = validateMediumManifest(manifestFile.value);
	if (
		manifest.state !== "active" ||
		manifest.inventorySha256 !== sha256(inventoryFile.buffer) ||
		manifest.presentationSetVersion !== inventory.presentationSetVersion ||
		manifest.presentationSetSha256 !== inventory.presentationSetSha256
	) {
		throw new MediumContractError(
			"Medium master packages require an active manifest bound to the reviewed inventory",
		);
	}
	const article = inventory.bySlug.get(slug);
	const manifestArticle = manifest.bySlug.get(slug);
	if (!article || !manifestArticle) {
		throw new MediumContractError(
			`Medium slug ${slug} is not a reviewed, imported article`,
		);
	}
	if (
		manifestArticle.canonicalUrl !== article.canonicalUrl ||
		manifestArticle.hashes.rawExport !== inventory.export.sha256 ||
		manifestArticle.hashes.rawSource !== article.sourceSha256 ||
		manifestArticle.content.title !== article.title ||
		manifestArticle.content.subtitle !== article.subtitle ||
		manifestArticle.content.seriesLine !== article.seriesLine
	) {
		throw new MediumContractError(
			`Medium manifest content evidence differs for ${slug}`,
		);
	}
	const snapshotFile = await readJsonFile(
		repoRoot,
		manifestArticle.paths.snapshot,
		`Medium snapshot for ${slug}`,
	);
	if (sha256(snapshotFile.buffer) !== manifestArticle.hashes.snapshot) {
		throw new MediumContractError(`Medium snapshot hash differs for ${slug}`);
	}
	const snapshot = validateMediumSnapshot(
		snapshotFile.value,
		article,
		inventory,
	);
	if (
		manifestArticle.hashes.bodyText !== snapshot.bodyTextSha256 ||
		manifestArticle.content.bodyBlockCount !== snapshot.bodyBlockCount
	) {
		throw new MediumContractError(
			`Medium manifest body evidence differs for ${slug}`,
		);
	}
	const markdown = await readBoundedRegularFileInside({
		root: repoRoot,
		filePath: resolveInside(
			repoRoot,
			manifestArticle.paths.markdown,
			`Medium Markdown for ${slug}`,
		),
		label: `Medium Markdown for ${slug}`,
		maxBytes: MAX_HTML_BYTES,
	});
	if (
		sha256(markdown) !== manifestArticle.hashes.markdown ||
		!markdown.equals(Buffer.from(renderMediumIndexMarkdown(snapshot), "utf8"))
	) {
		throw new MediumContractError(
			`Medium generated Markdown differs for ${slug}`,
		);
	}
	const assets = [];
	for (const inventoryAsset of article.assets) {
		const manifestAsset = manifestArticle.assets.find(
			(asset) => asset.id === inventoryAsset.id,
		);
		assets.push(
			await loadApprovedAsset(repoRoot, inventoryAsset, manifestAsset),
		);
	}
	if (assets.length !== manifestArticle.assets.length) {
		throw new MediumContractError(`Medium manifest repeats assets for ${slug}`);
	}
	const hero = assets.find((asset) => asset.role === "hero");
	const bodyAssetsBySourceUrl = new Map(
		assets
			.filter((asset) => asset.role === "body")
			.map((asset) => [asset.sourceUrl, asset]),
	);
	return {
		slug,
		article,
		manifestArticle,
		snapshot,
		hero,
		bodyAssetsBySourceUrl,
	};
}

export function renderProtonMasterHtml(evidence) {
	const { slug, snapshot, hero, bodyAssetsBySourceUrl } = evidence;
	assertSlug(slug, "Medium master slug");
	if (!hero?.buffer || hero.role !== "hero") {
		throw new MediumContractError("Medium master evidence has no hero bytes");
	}
	const bodyDocument = validateMediumDocument(snapshot.bodyDocument);
	const bodyHtml = bodyDocument.blocks
		.map((block) => renderBlock(block, bodyAssetsBySourceUrl))
		.join("\n");
	const heroCaption = snapshot.imageCaption
		? `<figcaption>${escapeHtml(snapshot.imageCaption)}</figcaption>`
		: "";
	const html = [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8" />',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
		`<meta name="shots-of-rhapsody-master-version" content="${MASTER_SCHEMA_VERSION}" />`,
		`<title>${escapeHtml(snapshot.exportTitle)}</title>`,
		"<style>",
		"body{margin:2rem auto;max-width:72ch;padding:0 1rem;font-family:serif;line-height:1.65;color:#1f211d;background:#fbf6e8}img{display:block;max-width:100%;height:auto;margin:1.5rem auto}figcaption{font-size:.9em;text-align:center}blockquote{margin-inline:1.5rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}",
		"</style>",
		"</head>",
		"<body>",
		`<article data-shots-slug="${slug}">`,
		'<header data-shots-role="presentation">',
		`<h1 data-shots-role="export-title">${escapeHtml(snapshot.exportTitle)}</h1>`,
		`<p data-shots-role="export-summary">${escapeHtml(snapshot.summary)}</p>`,
		`<h2 data-shots-role="authored-title">${escapeHtml(snapshot.title)}</h2>`,
		`<p data-shots-role="authored-subtitle">${escapeHtml(snapshot.subtitle)}</p>`,
		`<p data-shots-role="series-line">${escapeHtml(snapshot.seriesLine)}</p>`,
		'<figure data-shots-role="hero">',
		`<img src="${dataUrl(hero.mimeType, hero.buffer)}" alt="${escapeHtml(snapshot.imageAlt ?? "")}" width="${hero.width}" height="${hero.height}" />`,
		...(heroCaption ? [heroCaption] : []),
		"</figure>",
		"</header>",
		'<section data-shots-role="body">',
		bodyHtml,
		"</section>",
		"</article>",
		"</body>",
		"</html>",
		"",
	].join("\n");
	if (/https?:\/\/[^\s"']*proton/iu.test(html)) {
		throw new MediumContractError(
			"Generated Medium master unexpectedly contains a Proton URL",
		);
	}
	return Buffer.from(html, "utf8");
}

async function ensurePhysicalOutputDirectory(repoRoot, slug) {
	const importRoot = getMediumPaths(repoRoot).importRoot;
	const importStats = await lstat(importRoot).catch((error) => {
		if (error?.code === "ENOENT") {
			throw new MediumContractError(
				`Ignored Medium evidence root is missing: ${importRoot}`,
			);
		}
		throw error;
	});
	if (!importStats.isDirectory() || importStats.isSymbolicLink()) {
		throw new MediumContractError(
			"Ignored Medium evidence root must be a physical directory",
		);
	}
	let cursor = importRoot;
	for (const segment of ["proton-masters", slug]) {
		cursor = path.join(cursor, segment);
		try {
			await mkdir(cursor);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
		const stats = await lstat(cursor);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new MediumContractError(
				`Proton master output component ${segment} must be a physical directory`,
			);
		}
	}
	return cursor;
}

async function installNewFile(filePath, buffer) {
	const temporaryPath = path.join(
		path.dirname(filePath),
		`.master-${randomUUID()}.tmp`,
	);
	try {
		await writeFile(temporaryPath, buffer, { flag: "wx" });
		await link(temporaryPath, filePath);
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new MediumContractError(
				`Proton master already exists; remove it explicitly before regenerating: ${filePath}`,
			);
		}
		throw error;
	} finally {
		await unlink(temporaryPath).catch(() => {});
	}
}

export async function createProtonMasterPackage({
	repoRoot = DEFAULT_REPO_ROOT,
	slug: slugValue,
	write = false,
} = {}) {
	const slug = assertSlug(slugValue, "Medium master slug");
	const evidence = await loadMediumMasterEvidence({ repoRoot, slug });
	const buffer = renderProtonMasterHtml(evidence);
	const relativePath = `.medium-import/proton-masters/${slug}/master.html`;
	const outputPath = path.join(
		getMediumPaths(repoRoot).importRoot,
		"proton-masters",
		slug,
		"master.html",
	);
	if (write) {
		const directory = await ensurePhysicalOutputDirectory(repoRoot, slug);
		const resolvedDirectory = await realpath(directory);
		const resolvedRoot = await realpath(getMediumPaths(repoRoot).importRoot);
		const relative = path.relative(resolvedRoot, resolvedDirectory);
		if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new MediumContractError(
				"Proton master output escapes its ignored root",
			);
		}
		await installNewFile(outputPath, buffer);
	}
	return {
		mode: write ? "write" : "dry-run",
		slug,
		documentTitle: evidence.snapshot.exportTitle,
		destination: "Blogging/Non-Fiction",
		outputPath: relativePath,
		byteLength: buffer.byteLength,
		sha256: sha256(buffer),
	};
}

function plainExactText(node, label) {
	const tokens = extractInline(node.childNodes ?? [], label);
	if (
		tokens.some(
			(token) =>
				token.type !== "text" ||
				token.marks.length !== 0 ||
				token.href !== undefined,
		)
	) {
		throw new MediumContractError(`${label} must contain plain exact text`);
	}
	return tokens.map((token) => token.text).join("");
}

async function readExportImage(source, exportPath, ignoredRoot, label) {
	if (source.startsWith("data:")) {
		const match =
			/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(
				source,
			);
		if (!match) {
			throw new MediumContractError(`${label} has a malformed image data URL`);
		}
		const buffer = Buffer.from(match[2], "base64");
		if (
			buffer.byteLength === 0 ||
			buffer.byteLength > MAX_IMAGE_BYTES ||
			buffer.toString("base64") !== match[2]
		) {
			throw new MediumContractError(`${label} has invalid base64 image bytes`);
		}
		const decoded = await decodedImage(buffer, label);
		if (decoded.mimeType !== match[1]) {
			throw new MediumContractError(
				`${label} MIME type differs from its bytes`,
			);
		}
		return decoded;
	}
	if (
		source.includes("\\") ||
		source.startsWith("/") ||
		/^[A-Za-z]:/u.test(source) ||
		source.includes("?") ||
		source.includes("#") ||
		/^[a-z][a-z0-9+.-]*:/iu.test(source) ||
		source
			.split("/")
			.some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new MediumContractError(
			`${label} must use embedded bytes or a safe sibling file`,
		);
	}
	const filePath = path.resolve(path.dirname(exportPath), ...source.split("/"));
	const buffer = await readBoundedRegularFileInside({
		root: ignoredRoot,
		filePath,
		label,
		maxBytes: MAX_IMAGE_BYTES,
	});
	return decodedImage(buffer, label);
}

async function extractExportFigure(node, context, label) {
	htmlAttributes(node, label);
	let imageNode = node.tagName === "img" ? node : null;
	let captionNode = null;
	if (node.tagName === "figure") {
		const children = significantChildren(node, label);
		const images = children.filter((child) => child.tagName === "img");
		const captions = children.filter((child) => child.tagName === "figcaption");
		if (
			images.length !== 1 ||
			captions.length > 1 ||
			children.length !== images.length + captions.length
		) {
			throw new MediumContractError(
				`${label} must contain one image and at most one caption`,
			);
		}
		imageNode = images[0];
		captionNode = captions[0] ?? null;
	}
	if (!imageNode) {
		throw new MediumContractError(`${label} has no image`);
	}
	const imageAttributes = htmlAttributes(imageNode, `${label}.img`);
	if (!imageAttributes.src) {
		throw new MediumContractError(`${label}.img has no src`);
	}
	const image = await readExportImage(
		imageAttributes.src,
		context.exportPath,
		context.ignoredRoot,
		`${label}.img`,
	);
	const caption = captionNode
		? extractInline(captionNode.childNodes ?? [], `${label}.figcaption`)
		: [];
	return {
		type: "figure",
		alt: imageAttributes.alt ?? "",
		caption,
		image: {
			width: image.width,
			height: image.height,
			pixelSha256: image.pixelSha256,
		},
	};
}

async function extractExportBlock(
	node,
	context,
	label,
	{ allowLists = true } = {},
) {
	const attributes = htmlAttributes(node, label);
	if (node.tagName === "p") {
		return {
			type: "paragraph",
			children: extractInline(node.childNodes ?? [], label),
		};
	}
	if (/^h[2-6]$/u.test(node.tagName)) {
		return {
			type: "heading",
			level: Number(node.tagName.slice(1)),
			children: extractInline(node.childNodes ?? [], label),
		};
	}
	if (node.tagName === "blockquote") {
		let children = significantChildren(node, label);
		if (children.every((child) => !BLOCK_TAGS.has(child.tagName))) {
			return {
				type: "blockquote",
				blocks: [
					{
						type: "paragraph",
						children: extractInline(node.childNodes ?? [], label),
					},
				],
			};
		}
		children = flattenBlockNodes(node, label);
		return {
			type: "blockquote",
			blocks: await Promise.all(
				children.map((child, index) =>
					extractExportBlock(child, context, `${label}.blocks[${index}]`),
				),
			),
		};
	}
	if (node.tagName === "ul" || node.tagName === "ol") {
		if (!allowLists) {
			throw new MediumContractError(`${label} contains a nested list`);
		}
		const items = significantChildren(node, label);
		if (items.length === 0 || items.some((item) => item.tagName !== "li")) {
			throw new MediumContractError(`${label} must contain direct list items`);
		}
		let start = 1;
		if (node.tagName === "ol" && attributes.start !== undefined) {
			if (!/^[1-9][0-9]*$/u.test(attributes.start)) {
				throw new MediumContractError(`${label}.start must be positive`);
			}
			start = Number(attributes.start);
			if (!Number.isSafeInteger(start)) {
				throw new MediumContractError(`${label}.start is too large`);
			}
		}
		const parsedItems = [];
		for (const [index, item] of items.entries()) {
			htmlAttributes(item, `${label}.items[${index}]`);
			const itemChildren = significantChildren(
				item,
				`${label}.items[${index}]`,
			);
			if (itemChildren.length === 0) {
				throw new MediumContractError(`${label}.items[${index}] is empty`);
			}
			if (itemChildren.every((child) => !BLOCK_TAGS.has(child.tagName))) {
				parsedItems.push([
					{
						type: "paragraph",
						children: extractInline(
							item.childNodes ?? [],
							`${label}.items[${index}]`,
						),
					},
				]);
				continue;
			}
			const blockChildren = flattenBlockNodes(item, `${label}.items[${index}]`);
			parsedItems.push(
				await Promise.all(
					blockChildren.map((child, blockIndex) =>
						extractExportBlock(
							child,
							context,
							`${label}.items[${index}][${blockIndex}]`,
							{ allowLists: false },
						),
					),
				),
			);
		}
		return {
			type: "list",
			ordered: node.tagName === "ol",
			start,
			items: parsedItems,
		};
	}
	if (node.tagName === "hr") {
		if ((node.childNodes ?? []).length !== 0) {
			throw new MediumContractError(`${label} hr must be empty`);
		}
		return { type: "thematicBreak" };
	}
	if (node.tagName === "figure" || node.tagName === "img") {
		return extractExportFigure(node, context, label);
	}
	if (node.tagName === "pre") {
		const children = significantChildren(node, label);
		if (children.length !== 1 || children[0].tagName !== "code") {
			throw new MediumContractError(`${label} must contain one code element`);
		}
		htmlAttributes(children[0], `${label}.code`);
		const codeChildren = children[0].childNodes ?? [];
		if (codeChildren.some((child) => child.nodeName !== "#text")) {
			throw new MediumContractError(`${label}.code must contain text only`);
		}
		return {
			type: "codeBlock",
			text: codeChildren.map((child) => child.value).join(""),
		};
	}
	throw new MediumContractError(
		`${label} uses unsupported block <${node.tagName}>`,
	);
}

async function ignoredExportFile(repoRoot, exportPathValue) {
	if (typeof exportPathValue !== "string" || exportPathValue.includes("\0")) {
		throw new MediumContractError("Proton export path must be a string");
	}
	const importRoot = getMediumPaths(repoRoot).importRoot;
	const exportPath = path.resolve(repoRoot, exportPathValue);
	const relative = path.relative(path.resolve(importRoot), exportPath);
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new MediumContractError(
			"Proton export must be saved beneath the ignored .medium-import directory",
		);
	}
	let stats;
	try {
		stats = await lstat(exportPath);
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new MediumContractError(`Proton export is missing: ${exportPath}`);
		}
		throw error;
	}
	if (
		stats.size === 0 &&
		path.extname(exportPath).toLowerCase() === ".protondoc"
	) {
		throw new MediumContractError(
			"Zero-byte .protondoc sync placeholders are not export evidence",
		);
	}
	if (path.extname(exportPath).toLowerCase() === ".protondoc") {
		throw new MediumContractError(
			".protondoc sync placeholders are not readable export evidence; export HTML instead",
		);
	}
	if (!new Set([".html", ".htm"]).has(path.extname(exportPath).toLowerCase())) {
		throw new MediumContractError(
			"Proton verification requires an HTML export",
		);
	}
	const buffer = await readBoundedRegularFileInside({
		root: importRoot,
		filePath: exportPath,
		label: "Proton HTML export",
		maxBytes: MAX_HTML_BYTES,
	});
	return { importRoot, exportPath, buffer };
}

export async function verifyProtonMasterExport({
	repoRoot = DEFAULT_REPO_ROOT,
	slug: slugValue,
	exportPath: exportPathValue,
} = {}) {
	const slug = assertSlug(slugValue, "Medium master slug");
	const evidence = await loadMediumMasterEvidence({ repoRoot, slug });
	const exportFile = await ignoredExportFile(repoRoot, exportPathValue);
	const html = decodeUtf8(exportFile.buffer, "Proton HTML export");
	const body = parseHtmlDocument(html, "Proton HTML export");
	const nodes = flattenBlockNodes(body, "Proton HTML export body");
	if (nodes.length < 7) {
		throw new MediumContractError(
			"Proton HTML export is missing the presentation sequence or article body",
		);
	}
	const expectedPrefix = [
		["h1", evidence.snapshot.exportTitle, "export headline"],
		["p", evidence.snapshot.summary, "export summary"],
		["h2", evidence.snapshot.title, "authored title"],
		["p", evidence.snapshot.subtitle, "authored subtitle"],
		["p", evidence.snapshot.seriesLine, "Ledger Series sentence"],
	];
	for (const [index, [tagName, expected, role]] of expectedPrefix.entries()) {
		if (nodes[index]?.tagName !== tagName) {
			throw new MediumContractError(
				`Proton HTML export ${role} must be the ${index + 1} semantic block <${tagName}>`,
			);
		}
		htmlAttributes(nodes[index], `Proton HTML export ${role}`);
		if (
			plainExactText(nodes[index], `Proton HTML export ${role}`) !== expected
		) {
			throw new MediumContractError(
				`Proton HTML export ${role} differs from approved Medium evidence`,
			);
		}
	}
	if (nodes[5]?.tagName !== "figure") {
		throw new MediumContractError(
			"Proton HTML export Ledger Series sentence must be followed by its hero figure",
		);
	}
	const context = {
		exportPath: exportFile.exportPath,
		ignoredRoot: exportFile.importRoot,
	};
	const exportedHero = await extractExportFigure(
		nodes[5],
		context,
		"Proton HTML export hero",
	);
	const expectedHero = {
		type: "figure",
		alt: evidence.snapshot.imageAlt ?? "",
		caption: evidence.snapshot.imageCaption
			? [
					{
						type: "text",
						text: evidence.snapshot.imageCaption,
						marks: [],
					},
				]
			: [],
		image: {
			width: evidence.hero.width,
			height: evidence.hero.height,
			pixelSha256: evidence.hero.pixelSha256,
		},
	};
	if (JSON.stringify(exportedHero) !== JSON.stringify(expectedHero)) {
		throw new MediumContractError(
			"Proton HTML export hero alt, caption, dimensions, or decoded pixels differ",
		);
	}
	const exportedBody = [];
	for (const [index, node] of nodes.slice(6).entries()) {
		if (node.tagName === "h1") {
			throw new MediumContractError("Proton article body contains an extra h1");
		}
		exportedBody.push(
			await extractExportBlock(
				node,
				context,
				`Proton HTML export body.blocks[${index}]`,
			),
		);
	}
	const expectedBody = evidence.snapshot.bodyDocument.blocks.map((block) =>
		canonicalExpectedBlock(block, evidence.bodyAssetsBySourceUrl),
	);
	if (JSON.stringify(exportedBody) !== JSON.stringify(expectedBody)) {
		throw new MediumContractError(
			"Proton HTML export body structure, order, text, marks, links, lists, line breaks, or Unicode differs",
		);
	}
	return {
		slug,
		documentTitle: evidence.snapshot.exportTitle,
		destination: "Blogging/Non-Fiction",
		exportPath: path
			.relative(repoRoot, exportFile.exportPath)
			.split(path.sep)
			.join("/"),
		exportSha256: sha256(exportFile.buffer),
		bodyBlockCount: exportedBody.length,
		heroPixelSha256: exportedHero.image.pixelSha256,
		verified: true,
	};
}

export const PROTON_ARCHIVE_CONTRACT = Object.freeze({
	parent: "Blogging",
	fiction: "Fiction",
	nonfiction: "Non-Fiction",
	fictionPolicy: "unchanged",
	nonfictionLayout: "flat",
});
