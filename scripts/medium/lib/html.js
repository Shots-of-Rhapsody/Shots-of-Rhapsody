import { parse } from "parse5";
import {
	assertHttpsUrl,
	assertNonEmptyString,
	assertOnlyKeys,
	assertPlainObject,
	assertString,
	MediumContractError,
} from "./contract.js";

const BLOCK_TAGS = new Set([
	"p",
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
	"strong",
	"b",
	"em",
	"i",
	"code",
	"a",
	"br",
]);
const ALLOWED_ATTRIBUTES = new Map([
	["body", new Set()],
	["article", new Set()],
	["h1", new Set()],
	["h2", new Set()],
	["h3", new Set()],
	["h4", new Set()],
	["h5", new Set()],
	["h6", new Set()],
	["p", new Set()],
	["blockquote", new Set()],
	["ul", new Set()],
	["ol", new Set(["start"])],
	["li", new Set()],
	["hr", new Set()],
	["figure", new Set()],
	["figcaption", new Set()],
	["img", new Set(["src", "alt"])],
	["pre", new Set()],
	["span", new Set()],
	["strong", new Set()],
	["b", new Set()],
	["em", new Set()],
	["i", new Set()],
	["code", new Set()],
	["a", new Set(["href"])],
	["br", new Set()],
]);
const CANONICAL_MARK_ORDER = ["bold", "italic", "code"];

function attributes(node, label) {
	const values = {};
	for (const attribute of node.attrs ?? []) {
		if (Object.hasOwn(values, attribute.name)) {
			throw new MediumContractError(
				`${label} repeats attribute ${attribute.name}`,
			);
		}
		values[attribute.name] = attribute.value;
	}
	const allowed = ALLOWED_ATTRIBUTES.get(node.tagName);
	if (!allowed) {
		throw new MediumContractError(
			`${label} uses unsupported <${node.tagName}>`,
		);
	}
	assertOnlyKeys(values, allowed, label);
	return values;
}

function walkElements(node, callback) {
	if (node.tagName) callback(node);
	for (const child of node.childNodes ?? []) walkElements(child, callback);
}

function textContent(node) {
	if (node.nodeName === "#text") return node.value;
	return (node.childNodes ?? []).map(textContent).join("");
}

function uniqueNonEmpty(values, label) {
	const unique = [
		...new Set(values.map((value) => value.trim()).filter(Boolean)),
	];
	if (unique.length > 1) {
		throw new MediumContractError(`${label} contains conflicting values`);
	}
	return unique[0] ?? null;
}

function parseDocument(html, label) {
	if (typeof html !== "string") {
		throw new MediumContractError(`${label} must decode as UTF-8 text`);
	}
	const parseErrors = [];
	const document = parse(html, {
		onParseError: (error) => parseErrors.push(error),
	});
	const structuralErrors = parseErrors.filter(
		(error) => error.code !== "missing-doctype",
	);
	if (structuralErrors.length > 0) {
		throw new MediumContractError(
			`${label} contains malformed HTML (${structuralErrors[0].code})`,
		);
	}
	return document;
}

function getSingleElement(document, tagName, label) {
	const matches = [];
	walkElements(document, (node) => {
		if (node.tagName === tagName) matches.push(node);
	});
	if (matches.length !== 1) {
		throw new MediumContractError(
			`${label} must contain exactly one <${tagName}> element`,
		);
	}
	return matches[0];
}

function attributeValue(node, name) {
	return node.attrs?.find((attribute) => attribute.name === name)?.value;
}

function suggestedSlug(title) {
	const normalized = title
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/gu, "")
		.toLowerCase()
		.replace(/['’]/gu, "")
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	if (!normalized) {
		throw new MediumContractError(
			"A candidate title could not produce an ASCII slug; assign one during review",
		);
	}
	return normalized;
}

export function extractCandidateMetadata(html, sourcePath) {
	const document = parseDocument(html, sourcePath);
	const titles = [];
	const headings = [];
	const descriptions = [];
	const canonicalUrls = [];
	const publishedDates = [];
	walkElements(document, (node) => {
		if (node.tagName === "title") titles.push(textContent(node));
		if (node.tagName === "h1") headings.push(textContent(node));
		if (node.tagName === "meta") {
			const name = attributeValue(node, "name")?.toLowerCase();
			const property = attributeValue(node, "property")?.toLowerCase();
			const content = attributeValue(node, "content");
			if (name === "description" && content !== undefined) {
				descriptions.push(content);
			}
			if (property === "article:published_time" && content !== undefined) {
				publishedDates.push(content);
			}
		}
		if (node.tagName === "link") {
			const rel = attributeValue(node, "rel")?.toLowerCase().split(/\s+/u);
			const href = attributeValue(node, "href");
			if (rel?.includes("canonical") && href !== undefined) {
				canonicalUrls.push(href);
			}
		}
		if (node.tagName === "time") {
			const datetime = attributeValue(node, "datetime");
			if (datetime !== undefined) publishedDates.push(datetime);
		}
	});
	const titleFromTitle = uniqueNonEmpty(titles, `${sourcePath} <title>`);
	const titleFromHeading = uniqueNonEmpty(headings, `${sourcePath} <h1>`);
	if (
		titleFromTitle !== null &&
		titleFromHeading !== null &&
		titleFromTitle !== titleFromHeading
	) {
		throw new MediumContractError(
			`${sourcePath} title metadata conflicts with its <h1>`,
		);
	}
	const title = titleFromHeading ?? titleFromTitle;
	if (title === null) {
		throw new MediumContractError(`${sourcePath} has no unambiguous title`);
	}
	const canonicalUrl = uniqueNonEmpty(
		canonicalUrls,
		`${sourcePath} canonical URL`,
	);
	if (canonicalUrl !== null) {
		assertHttpsUrl(canonicalUrl, `${sourcePath} canonical URL`);
	}
	const publishedAt = uniqueNonEmpty(
		publishedDates,
		`${sourcePath} publication date`,
	);
	if (publishedAt !== null && Number.isNaN(new Date(publishedAt).valueOf())) {
		throw new MediumContractError(
			`${sourcePath} contains an invalid publication date`,
		);
	}
	return {
		suggestedSlug: suggestedSlug(title),
		title,
		descriptionCandidate: uniqueNonEmpty(
			descriptions,
			`${sourcePath} description`,
		),
		publishedAtCandidate: publishedAt,
		canonicalUrlCandidate: canonicalUrl,
	};
}

function canonicalMarks(marks) {
	return CANONICAL_MARK_ORDER.filter((mark) => marks.has(mark));
}

function extractInline(nodes, label, marks = new Set(), href = null) {
	const tokens = [];
	for (const [index, node] of nodes.entries()) {
		const nodeLabel = `${label}.childNodes[${index}]`;
		if (node.nodeName === "#text") {
			tokens.push({
				type: "text",
				text: assertString(node.value, `${nodeLabel}.value`),
				marks: canonicalMarks(marks),
				...(href === null ? {} : { href }),
			});
			continue;
		}
		if (node.nodeName === "#comment") {
			throw new MediumContractError(`${nodeLabel} contains a comment`);
		}
		if (!node.tagName || !INLINE_TAGS.has(node.tagName)) {
			throw new MediumContractError(
				`${nodeLabel} uses unsupported inline <${node.tagName ?? node.nodeName}>`,
			);
		}
		const attrs = attributes(node, nodeLabel);
		if (node.tagName === "br") {
			if ((node.childNodes ?? []).length !== 0) {
				throw new MediumContractError(`${nodeLabel} <br> must be empty`);
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
				throw new MediumContractError(`${nodeLabel} nests an anchor`);
			}
			nextHref = attrs.href;
			assertHttpsUrl(nextHref, `${nodeLabel}.href`);
		}
		tokens.push(
			...extractInline(node.childNodes ?? [], nodeLabel, nextMarks, nextHref),
		);
	}
	return tokens;
}

function significantChildren(node, label) {
	const children = [];
	for (const [index, child] of (node.childNodes ?? []).entries()) {
		if (child.nodeName === "#text" && /^\s*$/u.test(child.value)) continue;
		if (child.nodeName === "#comment") {
			throw new MediumContractError(
				`${label}.childNodes[${index}] is a comment`,
			);
		}
		children.push(child);
	}
	return children;
}

function extractFigure(node, label) {
	attributes(node, label);
	const children = significantChildren(node, label);
	const imageNodes = children.filter((child) => child.tagName === "img");
	const captionNodes = children.filter(
		(child) => child.tagName === "figcaption",
	);
	if (
		imageNodes.length !== 1 ||
		captionNodes.length > 1 ||
		children.length !== imageNodes.length + captionNodes.length
	) {
		throw new MediumContractError(
			`${label} must contain one image and at most one caption`,
		);
	}
	const imageAttributes = attributes(imageNodes[0], `${label}.img`);
	assertHttpsUrl(imageAttributes.src, `${label}.img.src`);
	const caption = captionNodes[0];
	if (caption) attributes(caption, `${label}.figcaption`);
	return {
		type: "figure",
		sourceUrl: imageAttributes.src,
		alt: imageAttributes.alt ?? "",
		caption: caption
			? extractInline(caption.childNodes ?? [], `${label}.figcaption`)
			: [],
	};
}

function extractListItem(node, label) {
	attributes(node, label);
	const children = significantChildren(node, label);
	if (children.length === 0) {
		throw new MediumContractError(`${label} must not be empty`);
	}
	if (children.every((child) => child.nodeName === "#text" || child.tagName)) {
		const hasBlockChild = children.some((child) =>
			BLOCK_TAGS.has(child.tagName),
		);
		if (!hasBlockChild) {
			return [
				{
					type: "paragraph",
					children: extractInline(node.childNodes ?? [], label),
				},
			];
		}
	}
	return extractBlocks(children, label, { allowLists: false });
}

function extractBlock(node, label, { allowLists = true } = {}) {
	if (!node.tagName || !BLOCK_TAGS.has(node.tagName)) {
		throw new MediumContractError(
			`${label} uses unsupported block <${node.tagName ?? node.nodeName}>`,
		);
	}
	const attrs = attributes(node, label);
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
		return {
			type: "blockquote",
			blocks: extractBlocks(significantChildren(node, label), label),
		};
	}
	if (node.tagName === "ul" || node.tagName === "ol") {
		if (!allowLists) {
			throw new MediumContractError(`${label} contains a nested list`);
		}
		const items = significantChildren(node, label);
		if (items.length === 0 || items.some((item) => item.tagName !== "li")) {
			throw new MediumContractError(
				`${label} must contain one or more direct <li> children`,
			);
		}
		let start = 1;
		if (node.tagName === "ol" && attrs.start !== undefined) {
			if (!/^[1-9][0-9]*$/u.test(attrs.start)) {
				throw new MediumContractError(`${label}.start must be positive`);
			}
			start = Number(attrs.start);
			if (!Number.isSafeInteger(start)) {
				throw new MediumContractError(`${label}.start is too large`);
			}
		}
		return {
			type: "list",
			ordered: node.tagName === "ol",
			start,
			items: items.map((item, index) =>
				extractListItem(item, `${label}.items[${index}]`),
			),
		};
	}
	if (node.tagName === "hr") {
		if ((node.childNodes ?? []).length !== 0) {
			throw new MediumContractError(`${label} <hr> must be empty`);
		}
		return { type: "thematicBreak" };
	}
	if (node.tagName === "figure") return extractFigure(node, label);
	if (node.tagName === "img") {
		const imageAttributes = attrs;
		assertHttpsUrl(imageAttributes.src, `${label}.src`);
		return {
			type: "figure",
			sourceUrl: imageAttributes.src,
			alt: imageAttributes.alt ?? "",
			caption: [],
		};
	}
	if (node.tagName === "pre") {
		const children = significantChildren(node, label);
		if (children.length !== 1 || children[0].tagName !== "code") {
			throw new MediumContractError(
				`${label} must contain exactly one <code> element`,
			);
		}
		attributes(children[0], `${label}.code`);
		return { type: "codeBlock", text: textContent(children[0]) };
	}
	throw new MediumContractError(`${label} could not be converted`);
}

function extractBlocks(nodes, label, options) {
	if (nodes.length === 0) {
		throw new MediumContractError(`${label} contains no story blocks`);
	}
	return nodes.map((node, index) =>
		extractBlock(node, `${label}.blocks[${index}]`, options),
	);
}

export function extractMediumStoryHtml(html, expected) {
	const document = parseDocument(html, "Medium story export");
	const body = getSingleElement(document, "body", "Medium story export");
	attributes(body, "document.body");
	let roots = significantChildren(body, "document.body");
	if (roots.length === 1 && roots[0].tagName === "article") {
		attributes(roots[0], "document.body.article");
		roots = significantChildren(roots[0], "document.body.article");
	}
	if (roots.length === 0 || roots[0].tagName !== "h1") {
		throw new MediumContractError(
			"Medium story export must begin with exactly one visible <h1> title",
		);
	}
	attributes(roots[0], "story.title");
	const title = textContent(roots[0]).trim();
	if (title !== expected.title) {
		throw new MediumContractError(
			`Exported title does not exactly match reviewed inventory title for ${expected.slug}`,
		);
	}
	roots = roots.slice(1);
	if (expected.subtitle.length > 0) {
		if (roots[0]?.tagName !== "h2") {
			throw new MediumContractError(
				`Exported story ${expected.slug} is missing its reviewed subtitle`,
			);
		}
		attributes(roots[0], "story.subtitle");
		if (textContent(roots[0]).trim() !== expected.subtitle) {
			throw new MediumContractError(
				`Exported subtitle does not exactly match reviewed inventory subtitle for ${expected.slug}`,
			);
		}
		roots = roots.slice(1);
	}
	const documentModel = { blocks: extractBlocks(roots, "story") };
	return validateMediumDocument(documentModel);
}

function validateInline(value, label) {
	if (!Array.isArray(value)) {
		throw new MediumContractError(`${label} must be an array`);
	}
	return value.map((tokenValue, index) => {
		const tokenLabel = `${label}[${index}]`;
		const token = assertPlainObject(tokenValue, tokenLabel);
		if (token.type === "break") {
			assertOnlyKeys(token, new Set(["type"]), tokenLabel);
			return { type: "break" };
		}
		assertOnlyKeys(
			token,
			new Set(["type", "text", "marks", "href"]),
			tokenLabel,
		);
		if (token.type !== "text") {
			throw new MediumContractError(`${tokenLabel}.type must be text or break`);
		}
		const text = assertString(token.text, `${tokenLabel}.text`);
		if (
			!Array.isArray(token.marks) ||
			token.marks.some((mark) => !CANONICAL_MARK_ORDER.includes(mark)) ||
			new Set(token.marks).size !== token.marks.length ||
			token.marks.join(",") !==
				CANONICAL_MARK_ORDER.filter((mark) => token.marks.includes(mark)).join(
					",",
				)
		) {
			throw new MediumContractError(
				`${tokenLabel}.marks must be unique and in canonical order`,
			);
		}
		let href;
		if (token.href !== undefined) {
			href = assertString(token.href, `${tokenLabel}.href`);
			assertHttpsUrl(href, `${tokenLabel}.href`);
		}
		return {
			type: "text",
			text,
			marks: [...token.marks],
			...(href ? { href } : {}),
		};
	});
}

function validateBlock(value, label) {
	const block = assertPlainObject(value, label);
	if (block.type === "paragraph") {
		assertOnlyKeys(block, new Set(["type", "children"]), label);
		return {
			type: "paragraph",
			children: validateInline(block.children, `${label}.children`),
		};
	}
	if (block.type === "heading") {
		assertOnlyKeys(block, new Set(["type", "level", "children"]), label);
		if (!Number.isInteger(block.level) || block.level < 2 || block.level > 6) {
			throw new MediumContractError(`${label}.level must be between 2 and 6`);
		}
		return {
			type: "heading",
			level: block.level,
			children: validateInline(block.children, `${label}.children`),
		};
	}
	if (block.type === "blockquote") {
		assertOnlyKeys(block, new Set(["type", "blocks"]), label);
		if (!Array.isArray(block.blocks) || block.blocks.length === 0) {
			throw new MediumContractError(`${label}.blocks must not be empty`);
		}
		return {
			type: "blockquote",
			blocks: block.blocks.map((child, index) =>
				validateBlock(child, `${label}.blocks[${index}]`),
			),
		};
	}
	if (block.type === "list") {
		assertOnlyKeys(
			block,
			new Set(["type", "ordered", "start", "items"]),
			label,
		);
		if (typeof block.ordered !== "boolean") {
			throw new MediumContractError(`${label}.ordered must be a boolean`);
		}
		if (!Number.isSafeInteger(block.start) || block.start < 1) {
			throw new MediumContractError(`${label}.start must be positive`);
		}
		if (!Array.isArray(block.items) || block.items.length === 0) {
			throw new MediumContractError(`${label}.items must not be empty`);
		}
		return {
			type: "list",
			ordered: block.ordered,
			start: block.start,
			items: block.items.map((item, itemIndex) => {
				if (!Array.isArray(item) || item.length === 0) {
					throw new MediumContractError(
						`${label}.items[${itemIndex}] must not be empty`,
					);
				}
				return item.map((child, blockIndex) =>
					validateBlock(child, `${label}.items[${itemIndex}][${blockIndex}]`),
				);
			}),
		};
	}
	if (block.type === "thematicBreak") {
		assertOnlyKeys(block, new Set(["type"]), label);
		return { type: "thematicBreak" };
	}
	if (block.type === "figure") {
		assertOnlyKeys(
			block,
			new Set(["type", "sourceUrl", "alt", "caption"]),
			label,
		);
		const sourceUrl = assertNonEmptyString(
			block.sourceUrl,
			`${label}.sourceUrl`,
		);
		assertHttpsUrl(sourceUrl, `${label}.sourceUrl`);
		return {
			type: "figure",
			sourceUrl,
			alt: assertString(block.alt, `${label}.alt`),
			caption: validateInline(block.caption, `${label}.caption`),
		};
	}
	if (block.type === "codeBlock") {
		assertOnlyKeys(block, new Set(["type", "text"]), label);
		return {
			type: "codeBlock",
			text: assertString(block.text, `${label}.text`),
		};
	}
	throw new MediumContractError(`${label}.type is unsupported`);
}

export function validateMediumDocument(value, label = "bodyDocument") {
	const document = assertPlainObject(value, label);
	assertOnlyKeys(document, new Set(["blocks"]), label);
	if (!Array.isArray(document.blocks) || document.blocks.length === 0) {
		throw new MediumContractError(`${label}.blocks must not be empty`);
	}
	return {
		blocks: document.blocks.map((block, index) =>
			validateBlock(block, `${label}.blocks[${index}]`),
		),
	};
}

export function decodeUtf8(buffer, label) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch (error) {
		throw new MediumContractError(`${label} is not valid UTF-8`, {
			cause: error,
		});
	}
}
