import { parseFragment } from "parse5";
import {
	assertOnlyKeys,
	assertPlainObject,
	assertString,
	ContractError,
} from "./contract.js";

const ROOT_TAGS = new Set(["h1", "h2", "p"]);
const INLINE_TAGS = new Set([
	"span",
	"br",
	"img",
	"a",
	"b",
	"strong",
	"i",
	"em",
]);
const ATTRIBUTES = new Map([
	["h1", new Set(["dir", "style"])],
	["h2", new Set(["dir", "style"])],
	["p", new Set(["dir", "style"])],
	["span", new Set(["style"])],
	["strong", new Set(["style"])],
	["em", new Set(["style"])],
	["img", new Set(["src", "alt", "width", "height"])],
	["a", new Set(["href"])],
	["b", new Set()],
	["i", new Set()],
	["br", new Set()],
]);
const SAFE_STYLE_VALUES = new Map([
	["font-size", "16px"],
	["text-align", "start"],
	["white-space", "pre-wrap"],
]);

function validateStyle(value, label) {
	const declarations = value
		.split(";")
		.map((declaration) => declaration.trim())
		.filter(Boolean);
	if (declarations.length === 0) {
		throw new ContractError(`${label} must not be empty`);
	}
	const properties = new Set();
	for (const declaration of declarations) {
		const match = declaration.match(/^([a-z-]+)\s*:\s*([^;]+)$/u);
		if (!match) {
			throw new ContractError(`${label} contains malformed CSS`);
		}
		const property = match[1];
		const propertyValue = match[2].trim().toLowerCase();
		if (properties.has(property)) {
			throw new ContractError(`${label} repeats CSS property ${property}`);
		}
		properties.add(property);
		if (SAFE_STYLE_VALUES.get(property) !== propertyValue) {
			throw new ContractError(
				`${label} contains unsupported CSS ${property}: ${propertyValue}`,
			);
		}
	}
}

function attributeMap(node, label) {
	const values = {};
	for (const attribute of node.attrs ?? []) {
		if (Object.hasOwn(values, attribute.name)) {
			throw new ContractError(`${label} repeats attribute ${attribute.name}`);
		}
		values[attribute.name] = attribute.value;
	}
	return values;
}

function validateElement(node, label) {
	const allowedAttributes = ATTRIBUTES.get(node.tagName);
	if (!allowedAttributes) {
		throw new ContractError(
			`${label} uses unsupported element <${node.tagName}>`,
		);
	}
	const attributes = attributeMap(node, label);
	assertOnlyKeys(attributes, allowedAttributes, label);
	if (attributes.dir !== undefined && attributes.dir !== "ltr") {
		throw new ContractError(`${label}.dir must equal "ltr"`);
	}
	if (attributes.style !== undefined) {
		validateStyle(attributes.style, `${label}.style`);
	}
	if (node.tagName === "img") {
		for (const name of ["src", "alt", "width", "height"]) {
			if (attributes[name] === undefined) {
				throw new ContractError(`${label}.${name} is required`);
			}
		}
		let source;
		try {
			source = new URL(attributes.src);
		} catch (error) {
			throw new ContractError(`${label}.src must be an absolute HTTPS URL`, {
				cause: error,
			});
		}
		if (source.protocol !== "https:") {
			throw new ContractError(`${label}.src must use HTTPS`);
		}
		if (attributes.width !== "inherit" || attributes.height !== "inherit") {
			throw new ContractError(
				`${label} must preserve Proton's inherit width and height markers`,
			);
		}
	}
	if (node.tagName === "a") {
		if (attributes.href !== "https://vocal.media/authors/tai-song") {
			throw new ContractError(
				`${label}.href must equal the reviewed Tai Song Vocal author URL`,
			);
		}
		if ((node.childNodes ?? []).length !== 0) {
			throw new ContractError(
				`${label} author link must be inert and have no children`,
			);
		}
	}
	return attributes;
}

function canonicalMarks(marks) {
	return ["bold", "italic"].filter((mark) => marks.has(mark));
}

function flattenInlineNodes(nodes, label, marks = new Set()) {
	const tokens = [];
	for (let index = 0; index < nodes.length; index += 1) {
		const node = nodes[index];
		const nodeLabel = `${label}.childNodes[${index}]`;
		if (node.nodeName === "#text") {
			tokens.push({
				type: "text",
				text: assertString(node.value, `${nodeLabel}.value`),
				marks: canonicalMarks(marks),
			});
			continue;
		}
		if (node.nodeName === "#comment") {
			throw new ContractError(`${nodeLabel} contains an unsupported comment`);
		}
		if (!node.tagName || !INLINE_TAGS.has(node.tagName)) {
			throw new ContractError(
				`${nodeLabel} uses unsupported element <${node.tagName ?? node.nodeName}>`,
			);
		}
		const attributes = validateElement(node, nodeLabel);
		if (node.tagName === "br") {
			if ((node.childNodes ?? []).length !== 0) {
				throw new ContractError(`${nodeLabel} <br> must not have children`);
			}
			tokens.push({ type: "break" });
			continue;
		}
		if (node.tagName === "img") {
			if ((node.childNodes ?? []).length !== 0) {
				throw new ContractError(`${nodeLabel} <img> must not have children`);
			}
			tokens.push({ type: "hero", alt: attributes.alt });
			continue;
		}
		if (node.tagName === "a") {
			tokens.push({ type: "inert-author-link" });
			continue;
		}
		const nextMarks = new Set(marks);
		if (node.tagName === "b" || node.tagName === "strong") {
			nextMarks.add("bold");
		}
		if (node.tagName === "i" || node.tagName === "em") {
			nextMarks.add("italic");
		}
		tokens.push(
			...flattenInlineNodes(node.childNodes ?? [], nodeLabel, nextMarks),
		);
	}
	return tokens;
}

function inlineText(tokens, label) {
	if (tokens.length === 0) {
		throw new ContractError(`${label} must not be empty`);
	}
	let value = "";
	for (const [index, token] of tokens.entries()) {
		if (token.type !== "text") {
			throw new ContractError(
				`${label}[${index}] must be plain text without line breaks`,
			);
		}
		if (token.marks.length !== 0) {
			throw new ContractError(`${label}[${index}] must not be marked up`);
		}
		value += token.text;
	}
	if (!/\S/u.test(value)) {
		throw new ContractError(`${label} must contain non-whitespace text`);
	}
	return value;
}

function countTrailingBreaks(tokens) {
	let end = tokens.length;
	while (end > 0 && tokens[end - 1].type === "break") end -= 1;
	return { end, count: tokens.length - end };
}

function splitInlineMetadata(tokens) {
	const breakIndexes = [];
	for (const [index, token] of tokens.entries()) {
		if (token.type === "break") breakIndexes.push(index);
		if (token.type === "inert-author-link" || token.type === "hero") {
			throw new ContractError(
				"Combined leading metadata may contain only title/subtitle text and breaks",
			);
		}
	}
	if (breakIndexes.length === 0) {
		return {
			leadTitle: undefined,
			subtitle: inlineText(tokens, "leading subtitle"),
		};
	}
	if (breakIndexes.length !== 2 || breakIndexes[1] !== breakIndexes[0] + 1) {
		throw new ContractError(
			"Optional leading title must be separated from the subtitle by exactly two <br> elements",
		);
	}
	return {
		leadTitle: inlineText(tokens.slice(0, breakIndexes[0]), "leading title"),
		subtitle: inlineText(tokens.slice(breakIndexes[1] + 1), "leading subtitle"),
	};
}

function splitLead(tokens, externalSubtitle) {
	const heroIndexes = [];
	for (const [index, token] of tokens.entries()) {
		if (token.type === "hero") heroIndexes.push(index);
	}
	if (heroIndexes.length !== 1) {
		throw new ContractError(
			`The leading block must contain exactly one hero image; found ${heroIndexes.length}`,
		);
	}
	const heroIndex = heroIndexes[0];
	const beforeHero = tokens.slice(0, heroIndex);
	const afterHero = tokens.slice(heroIndex + 1);

	const subtitleBoundary = countTrailingBreaks(beforeHero);
	if (subtitleBoundary.count < 1 || subtitleBoundary.count > 3) {
		throw new ContractError(
			"The leading block must separate metadata from the hero with one to three <br> elements",
		);
	}
	const beforeBoundary = beforeHero.slice(0, subtitleBoundary.end);
	let leadTitle;
	let subtitle;
	if (externalSubtitle === undefined) {
		({ leadTitle, subtitle } = splitInlineMetadata(beforeBoundary));
	} else {
		if (
			beforeBoundary.length !== 1 ||
			beforeBoundary[0].type !== "inert-author-link"
		) {
			throw new ContractError(
				"A split leading block must contain only the reviewed inert author link before the hero",
			);
		}
		subtitle = externalSubtitle;
	}

	let captionStart = 0;
	while (
		captionStart < afterHero.length &&
		afterHero[captionStart].type === "break"
	) {
		captionStart += 1;
	}
	if (captionStart < 1 || captionStart > 3) {
		throw new ContractError(
			"The leading block must separate the hero from its caption with one to three <br> elements",
		);
	}

	const separatorStarts = [];
	for (let index = captionStart + 1; index < afterHero.length; index += 1) {
		if (
			afterHero[index]?.type === "break" &&
			afterHero[index + 1]?.type === "break" &&
			afterHero[index + 2]?.type === "break" &&
			afterHero[index - 1]?.type !== "break" &&
			afterHero[index + 3]?.type !== "break"
		) {
			separatorStarts.push(index);
		}
	}
	if (separatorStarts.length !== 1) {
		throw new ContractError(
			`The leading block must contain exactly one three-<br> caption/body separator; found ${separatorStarts.length}`,
		);
	}
	const separatorStart = separatorStarts[0];
	const caption = inlineText(
		afterHero.slice(captionStart, separatorStart),
		"hero caption",
	);
	const remainder = afterHero.slice(separatorStart + 3);
	if (remainder.length === 0) {
		throw new ContractError(
			"The leading block must preserve post-separator body content",
		);
	}
	if (remainder.some((token) => token.type === "hero")) {
		throw new ContractError("The hero image may appear only once");
	}
	if (remainder.some((token) => token.type === "inert-author-link")) {
		throw new ContractError(
			"The inert author link may appear only before the hero",
		);
	}
	return {
		leadTitle,
		subtitle,
		caption,
		hero: tokens[heroIndex],
		firstBodyBlock: { type: "paragraph", children: remainder },
	};
}

function significantRootNodes(fragment) {
	const nodes = [];
	for (const [index, node] of (fragment.childNodes ?? []).entries()) {
		if (node.nodeName === "#text" && /^\s*$/u.test(node.value)) continue;
		if (node.nodeName === "#comment") {
			throw new ContractError(
				`document.childNodes[${index}] contains an unsupported comment`,
			);
		}
		if (!node.tagName || !ROOT_TAGS.has(node.tagName)) {
			throw new ContractError(
				`document.childNodes[${index}] uses unsupported top-level element <${node.tagName ?? node.nodeName}>`,
			);
		}
		nodes.push(node);
	}
	return nodes;
}

function countDescendants(node, tagName) {
	let count = node.tagName === tagName ? 1 : 0;
	for (const child of node.childNodes ?? []) {
		count += countDescendants(child, tagName);
	}
	return count;
}

export function extractProtonHtml(html) {
	if (typeof html !== "string") {
		throw new ContractError("page.html must decode as UTF-8 text");
	}
	const parseErrors = [];
	const fragment = parseFragment(html, {
		onParseError: (error) => parseErrors.push(error),
	});
	if (parseErrors.length > 0) {
		throw new ContractError(
			`page.html contains malformed HTML (${parseErrors[0].code})`,
		);
	}
	const roots = significantRootNodes(fragment);
	if (roots.length === 0) {
		throw new ContractError("page.html contains no article blocks");
	}
	const rootsWithHero = roots
		.map((root, index) => ({ index, count: countDescendants(root, "img") }))
		.filter((entry) => entry.count > 0);
	if (
		rootsWithHero.length !== 1 ||
		rootsWithHero[0].count !== 1 ||
		(rootsWithHero[0].index !== 0 && rootsWithHero[0].index !== 1)
	) {
		throw new ContractError(
			"The document must contain exactly one hero in the first or second block",
		);
	}
	const leadIndex = rootsWithHero[0].index;
	let externalSubtitle;
	if (leadIndex === 1) {
		const subtitleRoot = roots[0];
		if (subtitleRoot.tagName !== "h1" && subtitleRoot.tagName !== "h2") {
			throw new ContractError(
				"A split subtitle must use the first h1 or h2 block",
			);
		}
		validateElement(subtitleRoot, "document.childNodes[0]");
		externalSubtitle = inlineText(
			flattenInlineNodes(
				subtitleRoot.childNodes ?? [],
				"document.childNodes[0]",
			),
			"split leading subtitle",
		);
	}
	const lead = roots[leadIndex];
	validateElement(lead, `document.childNodes[${leadIndex}]`);
	const split = splitLead(
		flattenInlineNodes(
			lead.childNodes ?? [],
			`document.childNodes[${leadIndex}]`,
		),
		externalSubtitle,
	);
	const blocks = [split.firstBodyBlock];
	for (let index = leadIndex + 1; index < roots.length; index += 1) {
		const root = roots[index];
		if (root.tagName !== "p") {
			throw new ContractError(
				`document block ${index} must be a paragraph, found <${root.tagName}>`,
			);
		}
		validateElement(root, `document.childNodes[${index}]`);
		const children = flattenInlineNodes(
			root.childNodes ?? [],
			`document.childNodes[${index}]`,
		);
		if (
			children.some(
				(token) => token.type === "hero" || token.type === "inert-author-link",
			)
		) {
			throw new ContractError(
				"The document must contain exactly one hero image",
			);
		}
		blocks.push({ type: "paragraph", children });
	}
	return {
		leadTitle: split.leadTitle,
		subtitle: split.subtitle,
		caption: split.caption,
		hero: { alt: split.hero.alt },
		document: { blocks },
	};
}

export function validateDocument(value, label = "bodyDocument") {
	const document = assertPlainObject(value, label);
	assertOnlyKeys(document, new Set(["blocks"]), label);
	if (!Array.isArray(document.blocks) || document.blocks.length === 0) {
		throw new ContractError(`${label}.blocks must be a non-empty array`);
	}
	return {
		blocks: document.blocks.map((blockValue, blockIndex) => {
			const blockLabel = `${label}.blocks[${blockIndex}]`;
			const block = assertPlainObject(blockValue, blockLabel);
			assertOnlyKeys(block, new Set(["type", "children"]), blockLabel);
			if (block.type !== "paragraph") {
				throw new ContractError(`${blockLabel}.type must equal "paragraph"`);
			}
			if (!Array.isArray(block.children)) {
				throw new ContractError(`${blockLabel}.children must be an array`);
			}
			return {
				type: "paragraph",
				children: block.children.map((childValue, childIndex) => {
					const childLabel = `${blockLabel}.children[${childIndex}]`;
					const child = assertPlainObject(childValue, childLabel);
					if (child.type === "break") {
						assertOnlyKeys(child, new Set(["type"]), childLabel);
						return { type: "break" };
					}
					if (child.type !== "text") {
						throw new ContractError(
							`${childLabel}.type must equal "text" or "break"`,
						);
					}
					assertOnlyKeys(child, new Set(["type", "text", "marks"]), childLabel);
					assertString(child.text, `${childLabel}.text`);
					if (
						!Array.isArray(child.marks) ||
						child.marks.some((mark) => mark !== "bold" && mark !== "italic") ||
						new Set(child.marks).size !== child.marks.length ||
						child.marks.join(",") !==
							["bold", "italic"]
								.filter((mark) => child.marks.includes(mark))
								.join(",")
					) {
						throw new ContractError(
							`${childLabel}.marks must contain unique bold/italic marks in canonical order`,
						);
					}
					return { type: "text", text: child.text, marks: [...child.marks] };
				}),
			};
		}),
	};
}

export function decodeUtf8(buffer, label = "page.html") {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch (error) {
		throw new ContractError(`${label} is not valid UTF-8`, { cause: error });
	}
}
