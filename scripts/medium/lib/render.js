import {
	ALL_RIGHTS_RESERVED,
	assertNonEmptyString,
	assertPlainObject,
	assertSlug,
	assertString,
	MediumContractError,
} from "./contract.js";
import { validateMediumDocument } from "./html.js";
import { sha256 } from "./integrity.js";

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderInline(token) {
	if (token.type === "break") return "<br />";
	let rendered = escapeHtml(token.text);
	if (token.marks.includes("code")) rendered = `<code>${rendered}</code>`;
	if (token.marks.includes("italic")) rendered = `<em>${rendered}</em>`;
	if (token.marks.includes("bold")) rendered = `<strong>${rendered}</strong>`;
	if (token.href) {
		rendered = `<a href="${escapeHtml(token.href)}">${rendered}</a>`;
	}
	return rendered;
}

function renderInlineList(children) {
	return children.map(renderInline).join("");
}

export const BODY_IMAGE_WIDTHS = [320, 480, 640, 960, 1280, 1600, 2048];
const BODY_IMAGE_SIZES = "(max-width: 767px) calc(100vw - 2rem), 66ch";

function assertPositiveInteger(value, label) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new MediumContractError(`${label} must be a positive safe integer`);
	}
	return value;
}

function validateBodyAsset(value, label) {
	const asset = assertPlainObject(value, label);
	const id = assertSlug(asset.id, `${label}.id`);
	if (asset.role !== "body") {
		throw new MediumContractError(`${label}.role must equal body`);
	}
	const sourceUrl = assertNonEmptyString(asset.sourceUrl, `${label}.sourceUrl`);
	const alt = asset.alt === null ? "" : assertString(asset.alt, `${label}.alt`);
	return {
		id,
		sourceUrl,
		alt,
		caption: assertString(asset.caption, `${label}.caption`),
		width: assertPositiveInteger(asset.width, `${label}.width`),
		height: assertPositiveInteger(asset.height, `${label}.height`),
	};
}

export function responsiveBodyImageWidths(sourceWidth) {
	const maximumOutputWidth = BODY_IMAGE_WIDTHS.at(-1);
	const boundedSourceWidth = Math.min(sourceWidth, maximumOutputWidth);
	return [
		...new Set([
			...BODY_IMAGE_WIDTHS.filter((width) => width <= boundedSourceWidth),
			boundedSourceWidth,
		]),
	].sort((left, right) => left - right);
}

export function bodyImageOutputPath(slug, assetId, width, format) {
	assertSlug(slug, "body image slug");
	assertSlug(assetId, "body image asset ID");
	if (!Number.isSafeInteger(width) || width <= 0)
		throw new MediumContractError("body image width must be positive");
	if (format !== "avif" && format !== "webp")
		throw new MediumContractError("body image format must be avif or webp");
	return `media/writing/${slug}/${assetId}-${width}.${format}`;
}

function bodyImageUrl(slug, assetId, width, format) {
	return `../../${bodyImageOutputPath(slug, assetId, width, format)}`;
}

function bodyImageSrcset(slug, assetId, widths, format) {
	return widths
		.map((width) => `${bodyImageUrl(slug, assetId, width, format)} ${width}w`)
		.join(", ");
}

function exactCaptionText(tokens, label) {
	let caption = "";
	for (const [index, token] of tokens.entries()) {
		if (
			token.type !== "text" ||
			token.marks.length !== 0 ||
			token.href !== undefined
		) {
			throw new MediumContractError(
				`${label}[${index}] must be exact unmarked caption text`,
			);
		}
		caption += token.text;
	}
	return caption;
}

function renderFigure(block, context) {
	const asset = context.assetsBySourceUrl.get(block.sourceUrl);
	if (!asset) {
		throw new MediumContractError(
			`No reviewed local asset maps Medium image ${block.sourceUrl}`,
		);
	}
	if (context.usedAssetIds.has(asset.id)) {
		throw new MediumContractError(
			`Reviewed body asset ${asset.id} is rendered more than once`,
		);
	}
	const captionText = exactCaptionText(
		block.caption,
		`body asset ${asset.id} caption`,
	);
	if (block.alt !== asset.alt || captionText !== asset.caption) {
		throw new MediumContractError(
			`Body image ${asset.id} alt text or caption differs from its reviewed asset`,
		);
	}
	context.usedAssetIds.add(asset.id);

	const widths = responsiveBodyImageWidths(asset.width);
	const fallbackWidth = widths.at(-1);
	const stableId = `${context.slug}/${asset.id}`;
	const captionId = `writing-asset-${context.slug}-${asset.id}-caption`;
	const caption = renderInlineList(block.caption);
	const describedBy =
		caption.length > 0 ? ` aria-describedby="${captionId}"` : "";
	return [
		`<figure data-writing-asset-id="${stableId}">`,
		"<picture>",
		`<source type="image/avif" srcset="${bodyImageSrcset(context.slug, asset.id, widths, "avif")}" sizes="${BODY_IMAGE_SIZES}" />`,
		`<source type="image/webp" srcset="${bodyImageSrcset(context.slug, asset.id, widths, "webp")}" sizes="${BODY_IMAGE_SIZES}" />`,
		`<img src="${bodyImageUrl(context.slug, asset.id, fallbackWidth, "webp")}" srcset="${bodyImageSrcset(context.slug, asset.id, widths, "webp")}" sizes="${BODY_IMAGE_SIZES}" width="${asset.width}" height="${asset.height}" alt="${escapeHtml(block.alt)}" loading="lazy" decoding="async"${describedBy} />`,
		"</picture>",
		...(caption.length > 0
			? [`<figcaption id="${captionId}">${caption}</figcaption>`]
			: []),
		"</figure>",
	].join("\n");
}

function renderBlock(block, context) {
	if (block.type === "paragraph") {
		return `<p>${renderInlineList(block.children)}</p>`;
	}
	if (block.type === "heading") {
		return `<h${block.level}>${renderInlineList(block.children)}</h${block.level}>`;
	}
	if (block.type === "blockquote") {
		return `<blockquote>\n${block.blocks
			.map((child) => renderBlock(child, context))
			.join("\n")}\n</blockquote>`;
	}
	if (block.type === "list") {
		const tag = block.ordered ? "ol" : "ul";
		const start =
			block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
		const items = block.items
			.map(
				(item) =>
					`<li>\n${item
						.map((child) => renderBlock(child, context))
						.join("\n")}\n</li>`,
			)
			.join("\n");
		return `<${tag}${start}>\n${items}\n</${tag}>`;
	}
	if (block.type === "thematicBreak") return "<hr />";
	if (block.type === "codeBlock") {
		return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
	}
	if (block.type === "figure") return renderFigure(block, context);
	throw new MediumContractError(`Unsupported rendered block ${block.type}`);
}

export function renderMediumBodyHtml(documentValue, assets, slugValue) {
	const document = validateMediumDocument(documentValue);
	const slug = assertSlug(slugValue, "article slug");
	if (!Array.isArray(assets)) {
		throw new MediumContractError("body assets must be an array");
	}
	const bodyAssets = assets.map((asset, index) =>
		validateBodyAsset(asset, `body assets[${index}]`),
	);
	const assetsBySourceUrl = new Map(
		bodyAssets.map((asset) => [asset.sourceUrl, asset]),
	);
	if (
		assetsBySourceUrl.size !== bodyAssets.length ||
		new Set(bodyAssets.map((asset) => asset.id)).size !== bodyAssets.length
	) {
		throw new MediumContractError(
			"Reviewed body assets must have unique IDs and source URLs",
		);
	}
	const context = { slug, assetsBySourceUrl, usedAssetIds: new Set() };
	const rendered = document.blocks
		.map((block) => renderBlock(block, context))
		.join("\n");
	if (context.usedAssetIds.size !== bodyAssets.length) {
		const unusedAssets = bodyAssets
			.filter((asset) => !context.usedAssetIds.has(asset.id))
			.map((asset) => asset.id);
		throw new MediumContractError(
			`Reviewed body assets are not rendered exactly once: ${unusedAssets.join(", ")}`,
		);
	}
	return rendered;
}

function collectTextStructure(block) {
	if (block.type === "paragraph" || block.type === "heading") {
		return [
			block.type,
			...(block.type === "heading" ? [block.level] : []),
			block.children.map((token) =>
				token.type === "break"
					? ["break"]
					: ["text", token.text, token.marks, token.href ?? null],
			),
		];
	}
	if (block.type === "blockquote") {
		return ["blockquote", block.blocks.map(collectTextStructure)];
	}
	if (block.type === "list") {
		return [
			"list",
			block.ordered,
			block.start,
			block.items.map((item) => item.map(collectTextStructure)),
		];
	}
	if (block.type === "thematicBreak") return ["thematicBreak"];
	if (block.type === "codeBlock") return ["codeBlock", block.text];
	return [
		"figure",
		block.sourceUrl,
		block.alt,
		block.caption.map((token) =>
			token.type === "break"
				? ["break"]
				: ["text", token.text, token.marks, token.href ?? null],
		),
	];
}

export function bodyTextSha256(documentValue) {
	const document = validateMediumDocument(documentValue);
	return sha256(
		Buffer.from(
			JSON.stringify(document.blocks.map(collectTextStructure)),
			"utf8",
		),
	);
}

function yamlString(value) {
	return JSON.stringify(value);
}

function appendString(lines, name, value) {
	lines.push(`${name}: ${yamlString(value)}`);
}

function yamlStringList(values) {
	return `[${values.map(yamlString).join(", ")}]`;
}

export function renderMediumIndexMarkdown(snapshotValue) {
	const snapshot = assertPlainObject(snapshotValue, "snapshot");
	const title = assertNonEmptyString(snapshot.title, "snapshot.title");
	const subtitle = assertString(snapshot.subtitle, "snapshot.subtitle");
	const seriesLine = assertNonEmptyString(
		snapshot.seriesLine,
		"snapshot.seriesLine",
	);
	const summary = assertNonEmptyString(snapshot.summary, "snapshot.summary");
	const description = assertNonEmptyString(
		snapshot.description,
		"snapshot.description",
	);
	const published = assertNonEmptyString(
		snapshot.published,
		"snapshot.published",
	);
	const hero = assertPlainObject(snapshot.hero, "snapshot.hero");
	const imageAlt = snapshot.imageAlt;
	if (imageAlt !== null && typeof imageAlt !== "string") {
		throw new MediumContractError("snapshot.imageAlt must be a string or null");
	}
	if (!Array.isArray(snapshot.tags)) {
		throw new MediumContractError("snapshot.tags must be an array");
	}
	const lines = ["---"];
	appendString(lines, "title", title);
	appendString(lines, "subtitle", subtitle);
	appendString(lines, "seriesLine", seriesLine);
	appendString(lines, "published", published);
	appendString(lines, "description", description);
	appendString(lines, "summary", summary);
	appendString(lines, "image", `./${hero.outputFile}`);
	lines.push(`imageAlt: ${imageAlt === null ? "null" : yamlString(imageAlt)}`);
	appendString(lines, "imageCaption", snapshot.imageCaption);
	appendString(lines, "author", snapshot.author);
	lines.push(`tags: ${yamlStringList(snapshot.tags)}`);
	appendString(lines, "category", snapshot.category);
	appendString(lines, "section", "nonfiction");
	lines.push("draft: false");
	appendString(lines, "lang", "en");
	lines.push("provenance:");
	appendString(lines, "  authority", "Medium account export");
	appendString(lines, "  captureFormat", "account-export-html");
	appendString(lines, "  capturedAt", snapshot.provenance.capturedAt);
	appendString(lines, "  bodyTextSha256", snapshot.bodyTextSha256);
	lines.push(`  bodyBlockCount: ${snapshot.bodyBlockCount}`);
	lines.push("license:");
	appendString(lines, "  name", ALL_RIGHTS_RESERVED);
	lines.push("---", "", snapshot.bodyHtml, "");
	return lines.join("\n");
}
