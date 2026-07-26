import { parse } from "parse5";
import {
	AUTHOR_NAME,
	AUTHOR_PROFILE_URL,
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

const OFFICIAL_GRAF_CLASSES = new Map([
	["h2", new Set(["graf graf--h2 graf--leading graf--title"])],
	[
		"h3",
		new Set([
			"graf graf--h3 graf--leading graf--title",
			"graf graf--h3 graf-after--figure",
			"graf graf--h3 graf-after--h3",
			"graf graf--h3 graf-after--p",
		]),
	],
	[
		"h4",
		new Set([
			"graf graf--h4 graf-after--h2 graf--subtitle",
			"graf graf--h4 graf-after--h3 graf--subtitle",
		]),
	],
	[
		"p",
		new Set([
			"graf graf--p graf--startsWithDoubleQuote graf-after--figure",
			"graf graf--p graf--startsWithDoubleQuote graf-after--p",
			"graf graf--p graf-after--figure",
			"graf graf--p graf-after--h3",
			"graf graf--p graf-after--h4",
			"graf graf--p graf-after--li",
			"graf graf--p graf-after--p",
			"graf graf--p graf-after--p graf--trailing",
		]),
	],
	[
		"li",
		new Set(["graf graf--li graf-after--li", "graf graf--li graf-after--p"]),
	],
	["figure", new Set(["graf graf--figure graf-after--p"])],
]);
const OFFICIAL_STRONG_CLASSES = new Set([
	"markup--strong markup--h2-strong",
	"markup--strong markup--h3-strong",
	"markup--strong markup--li-strong",
	"markup--strong markup--p-strong",
]);
const OFFICIAL_EM_CLASSES = new Set(["markup--em markup--p-em"]);
const OFFICIAL_ANCHOR_CLASSES = new Set([
	"markup--anchor markup--li-anchor",
	"markup--anchor markup--p-anchor",
]);

function rawAttributes(node, label) {
	const values = {};
	for (const attribute of node.attrs ?? []) {
		if (Object.hasOwn(values, attribute.name)) {
			throw new MediumContractError(
				`${label} repeats attribute ${attribute.name}`,
			);
		}
		values[attribute.name] = attribute.value;
	}
	return values;
}

function attributes(node, label) {
	const values = rawAttributes(node, label);
	const allowed = ALLOWED_ATTRIBUTES.get(node.tagName);
	if (!allowed) {
		throw new MediumContractError(
			`${label} uses unsupported <${node.tagName}>`,
		);
	}
	assertOnlyKeys(values, allowed, label);
	return values;
}

function exactAttributes(node, expected, label) {
	const values = rawAttributes(node, label);
	assertOnlyKeys(values, new Set(Object.keys(expected)), label);
	for (const [name, expectedValue] of Object.entries(expected)) {
		if (values[name] !== expectedValue) {
			throw new MediumContractError(
				`${label}.${name} must equal ${JSON.stringify(expectedValue)}`,
			);
		}
	}
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
	const exportedSubtitles = [];
	const renderedSubtitles = [];
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
		if (node.tagName === "section") {
			const dataField = attributeValue(node, "data-field");
			const classes = attributeValue(node, "class")?.split(/\s+/u) ?? [];
			if (dataField === "subtitle" && classes.includes("p-summary")) {
				exportedSubtitles.push(textContent(node));
			}
		}
		if (node.tagName === "h4") {
			const classes = attributeValue(node, "class")?.split(/\s+/u) ?? [];
			if (classes.includes("graf--subtitle")) {
				renderedSubtitles.push(textContent(node));
			}
		}
		if (node.tagName === "link") {
			const rel = attributeValue(node, "rel")?.toLowerCase().split(/\s+/u);
			const href = attributeValue(node, "href");
			if (rel?.includes("canonical") && href !== undefined) {
				canonicalUrls.push(href);
			}
		}
		if (node.tagName === "a") {
			const classes = attributeValue(node, "class")?.split(/\s+/u) ?? [];
			const href = attributeValue(node, "href");
			if (classes.includes("p-canonical") && href !== undefined) {
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
	const metaDescription = uniqueNonEmpty(
		descriptions,
		`${sourcePath} description`,
	);
	const exportedSubtitle = uniqueNonEmpty(
		exportedSubtitles,
		`${sourcePath} exported subtitle`,
	);
	const renderedSubtitle = uniqueNonEmpty(
		renderedSubtitles,
		`${sourcePath} rendered subtitle`,
	);
	return {
		suggestedSlug: suggestedSlug(title),
		title,
		descriptionCandidate:
			metaDescription ?? exportedSubtitle ?? renderedSubtitle,
		publishedAtCandidate: publishedAt,
		canonicalUrlCandidate: canonicalUrl,
	};
}

export function extractMediumAuthorEvidence(html, sourcePath) {
	const document = parseDocument(html, sourcePath);
	const officialArticles = [];
	walkElements(document, (node) => {
		if (
			node.tagName === "article" &&
			attributeValue(node, "class") === "h-entry"
		) {
			officialArticles.push(node);
		}
	});
	if (officialArticles.length !== 1) {
		throw new MediumContractError(
			`${sourcePath} must contain exactly one official Medium article.h-entry`,
		);
	}
	const footers = significantChildren(
		officialArticles[0],
		`${sourcePath} article.h-entry`,
	).filter((node) => node.tagName === "footer");
	if (footers.length !== 1) {
		throw new MediumContractError(
			`${sourcePath} must contain exactly one direct official article footer`,
		);
	}
	const authorLinks = [];
	walkElements(footers[0], (node) => {
		if (
			node.tagName === "a" &&
			attributeValue(node, "class") === "p-author h-card"
		) {
			authorLinks.push(node);
		}
	});
	const documentAuthorLinks = [];
	walkElements(document, (node) => {
		if (
			node.tagName === "a" &&
			attributeValue(node, "class") === "p-author h-card"
		) {
			documentAuthorLinks.push(node);
		}
	});
	if (authorLinks.length !== 1 || documentAuthorLinks.length !== 1) {
		throw new MediumContractError(
			`${sourcePath} must contain exactly one official Medium author credit inside its article footer`,
		);
	}
	const authorLink = authorLinks[0];
	const attrs = rawAttributes(authorLink, `${sourcePath} author credit`);
	assertOnlyKeys(
		attrs,
		new Set(["href", "class"]),
		`${sourcePath} author credit`,
	);
	const profileUrl = assertHttpsUrl(
		attrs.href,
		`${sourcePath} author profile URL`,
		{ hostname: "medium.com" },
	).toString();
	const name = textContent(authorLink);
	if (name !== AUTHOR_NAME || profileUrl !== AUTHOR_PROFILE_URL) {
		throw new MediumContractError(
			`${sourcePath} author credit does not match Tai Song at the Shots of Rhapsody profile`,
		);
	}
	return { name, profileUrl };
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

function requireSingleChild(node, tagName, label) {
	const children = significantChildren(node, label);
	if (children.length !== 1 || children[0].tagName !== tagName) {
		throw new MediumContractError(
			`${label} must contain exactly one <${tagName}> child`,
		);
	}
	return children[0];
}

function normalizeOfficialGrafAttributes(node, label) {
	const attrs = rawAttributes(node, label);
	assertOnlyKeys(attrs, new Set(["name", "id", "class"]), label);
	if (!/^[0-9a-f]{4}$/u.test(attrs.name ?? "") || attrs.id !== attrs.name) {
		throw new MediumContractError(
			`${label} must have matching four-character lowercase hexadecimal name and id attributes`,
		);
	}
	const allowedClasses = OFFICIAL_GRAF_CLASSES.get(node.tagName);
	if (!allowedClasses?.has(attrs.class)) {
		throw new MediumContractError(
			`${label}.class is not a recognized Medium export class`,
		);
	}
	node.attrs = [];
}

function normalizeOfficialContentAttributes(node, label) {
	if (node.nodeName === "#text") return;
	if (node.nodeName === "#comment") {
		throw new MediumContractError(`${label} contains a comment`);
	}
	if (!node.tagName || !ALLOWED_ATTRIBUTES.has(node.tagName)) {
		throw new MediumContractError(
			`${label} uses unsupported <${node.tagName ?? node.nodeName}>`,
		);
	}
	if (OFFICIAL_GRAF_CLASSES.has(node.tagName)) {
		normalizeOfficialGrafAttributes(node, label);
	} else if (node.tagName === "ul" || node.tagName === "ol") {
		const attrs = rawAttributes(node, label);
		assertOnlyKeys(
			attrs,
			new Set(node.tagName === "ol" ? ["class", "start"] : ["class"]),
			label,
		);
		if (attrs.class !== "postList") {
			throw new MediumContractError(`${label}.class must equal "postList"`);
		}
		node.attrs =
			attrs.start === undefined ? [] : [{ name: "start", value: attrs.start }];
	} else if (node.tagName === "strong") {
		const attrs = rawAttributes(node, label);
		assertOnlyKeys(attrs, new Set(["class"]), label);
		if (!OFFICIAL_STRONG_CLASSES.has(attrs.class)) {
			throw new MediumContractError(
				`${label}.class is not a recognized Medium strong class`,
			);
		}
		node.attrs = [];
	} else if (node.tagName === "em") {
		const attrs = rawAttributes(node, label);
		assertOnlyKeys(attrs, new Set(["class"]), label);
		if (!OFFICIAL_EM_CLASSES.has(attrs.class)) {
			throw new MediumContractError(
				`${label}.class is not a recognized Medium emphasis class`,
			);
		}
		node.attrs = [];
	} else if (node.tagName === "a") {
		const attrs = rawAttributes(node, label);
		assertOnlyKeys(
			attrs,
			new Set(["href", "data-href", "class", "rel", "target"]),
			label,
		);
		assertHttpsUrl(attrs.href, `${label}.href`);
		if (
			attrs["data-href"] !== attrs.href ||
			!OFFICIAL_ANCHOR_CLASSES.has(attrs.class) ||
			attrs.target !== "_blank"
		) {
			throw new MediumContractError(
				`${label} has inconsistent Medium link metadata`,
			);
		}
		const relTokens = attrs.rel?.split(/\s+/u).filter(Boolean) ?? [];
		if (
			!relTokens.includes("noopener") ||
			relTokens.some(
				(token) => !new Set(["noopener", "ugc", "nofollow"]).has(token),
			)
		) {
			throw new MediumContractError(
				`${label}.rel contains unsupported link behavior`,
			);
		}
		node.attrs = [{ name: "href", value: attrs.href }];
	} else if (node.tagName === "img") {
		const attrs = rawAttributes(node, label);
		assertOnlyKeys(
			attrs,
			new Set([
				"class",
				"data-image-id",
				"data-width",
				"data-height",
				"data-is-featured",
				"src",
				"alt",
			]),
			label,
		);
		if (
			attrs.class !== "graf-image" ||
			!/^\S+$/u.test(attrs["data-image-id"] ?? "")
		) {
			throw new MediumContractError(
				`${label} has incomplete Medium image metadata`,
			);
		}
		for (const dimension of ["data-width", "data-height"]) {
			if (!/^[1-9][0-9]*$/u.test(attrs[dimension] ?? "")) {
				throw new MediumContractError(
					`${label}.${dimension} must be a positive integer`,
				);
			}
		}
		if (
			attrs["data-is-featured"] !== undefined &&
			attrs["data-is-featured"] !== "true"
		) {
			throw new MediumContractError(
				`${label}.data-is-featured must equal "true" when present`,
			);
		}
		assertHttpsUrl(attrs.src, `${label}.src`);
		node.attrs = [
			{ name: "src", value: attrs.src },
			...(attrs.alt === undefined ? [] : [{ name: "alt", value: attrs.alt }]),
		];
	} else {
		attributes(node, label);
	}
	for (const [index, child] of (node.childNodes ?? []).entries()) {
		normalizeOfficialContentAttributes(child, `${label}.childNodes[${index}]`);
	}
}

function validateOfficialFooter(footer, label) {
	exactAttributes(footer, {}, label);
	const visit = (node, nodeLabel) => {
		if (node.nodeName === "#text") return;
		if (node.nodeName === "#comment") {
			throw new MediumContractError(`${nodeLabel} contains a comment`);
		}
		if (!node.tagName || !new Set(["p", "a", "time"]).has(node.tagName)) {
			throw new MediumContractError(
				`${nodeLabel} uses unsupported footer <${node.tagName ?? node.nodeName}>`,
			);
		}
		const attrs = rawAttributes(node, nodeLabel);
		if (node.tagName === "p") {
			assertOnlyKeys(attrs, new Set(), nodeLabel);
		} else if (node.tagName === "a") {
			assertOnlyKeys(attrs, new Set(["href", "class"]), nodeLabel);
			const url = assertHttpsUrl(attrs.href, `${nodeLabel}.href`, {
				hostname: "medium.com",
			});
			if (url.hostname !== "medium.com") {
				throw new MediumContractError(
					`${nodeLabel}.href must remain on medium.com`,
				);
			}
			if (
				attrs.class !== undefined &&
				attrs.class !== "p-author h-card" &&
				attrs.class !== "p-canonical"
			) {
				throw new MediumContractError(
					`${nodeLabel}.class is not a recognized Medium footer class`,
				);
			}
		} else {
			assertOnlyKeys(attrs, new Set(["class", "datetime"]), nodeLabel);
			if (
				attrs.class !== "dt-published" ||
				Number.isNaN(new Date(attrs.datetime).valueOf())
			) {
				throw new MediumContractError(
					`${nodeLabel} has invalid publication metadata`,
				);
			}
		}
		for (const [index, child] of (node.childNodes ?? []).entries()) {
			visit(child, `${nodeLabel}.childNodes[${index}]`);
		}
	};
	for (const [index, child] of (footer.childNodes ?? []).entries()) {
		visit(child, `${label}.childNodes[${index}]`);
	}
}

function shellTextMatches(sourceText, reviewedText) {
	return (
		sourceText === reviewedText ||
		sourceText.replaceAll("\u00a0", " ") === reviewedText
	);
}

function reconcileOfficialPresentationShell(nodes, expected) {
	const leadingTitle = nodes[0];
	const leadingTitleClass = leadingTitle
		? attributeValue(leadingTitle, "class")
		: undefined;
	const isRendererTitle =
		(leadingTitle?.tagName === "h2" || leadingTitle?.tagName === "h3") &&
		leadingTitleClass ===
			`graf graf--${leadingTitle.tagName} graf--leading graf--title`;
	if (!isRendererTitle) return nodes;
	const titleText = textContent(leadingTitle).trim();
	if (!shellTextMatches(titleText, expected.title)) return nodes;
	normalizeOfficialContentAttributes(
		leadingTitle,
		"story.body.presentationTitle",
	);

	const remaining = nodes.slice(1);
	const leadingSubtitle = remaining[0];
	const isRendererSubtitle =
		leadingSubtitle?.tagName === "h4" &&
		OFFICIAL_GRAF_CLASSES.get("h4")?.has(
			attributeValue(leadingSubtitle, "class"),
		);
	if (
		isRendererSubtitle &&
		expected.subtitle.length > 0 &&
		shellTextMatches(textContent(leadingSubtitle).trim(), expected.subtitle)
	) {
		normalizeOfficialContentAttributes(
			leadingSubtitle,
			"story.body.presentationSubtitle",
		);
		return remaining.slice(1);
	}
	return remaining;
}

function extractOfficialMediumStory(body, expected) {
	exactAttributes(body, {}, "document.body");
	const article = requireSingleChild(
		body,
		"article",
		"Medium story export body",
	);
	exactAttributes(article, { class: "h-entry" }, "document.body.article");
	const parts = significantChildren(article, "document.body.article");
	if (parts[0]?.tagName !== "header") {
		throw new MediumContractError(
			"Official Medium story export must begin with its <header>",
		);
	}
	exactAttributes(parts[0], {}, "story.header");
	const titleNode = requireSingleChild(parts[0], "h1", "story.header");
	exactAttributes(titleNode, { class: "p-name" }, "story.header.title");
	if (textContent(titleNode).trim() !== expected.title) {
		throw new MediumContractError(
			`Exported title does not exactly match reviewed inventory title for ${expected.slug}`,
		);
	}

	let cursor = 1;
	const subtitleNode =
		parts[cursor]?.tagName === "section" &&
		attributeValue(parts[cursor], "data-field") === "subtitle"
			? parts[cursor]
			: null;
	if (subtitleNode) {
		exactAttributes(
			subtitleNode,
			{ "data-field": "subtitle", class: "p-summary" },
			"story.subtitle",
		);
		if (expected.subtitle.length === 0) {
			throw new MediumContractError(
				`Exported story ${expected.slug} has an unexpected subtitle`,
			);
		}
		if (textContent(subtitleNode).trim() !== expected.subtitle) {
			throw new MediumContractError(
				`Exported subtitle does not exactly match reviewed inventory subtitle for ${expected.slug}`,
			);
		}
		cursor += 1;
	}

	const bodySection = parts[cursor];
	if (bodySection?.tagName !== "section") {
		throw new MediumContractError(
			"Official Medium story export is missing its body section",
		);
	}
	exactAttributes(
		bodySection,
		{ "data-field": "body", class: "e-content" },
		"story.body",
	);
	const layoutSection = requireSingleChild(
		bodySection,
		"section",
		"story.body",
	);
	const layoutAttrs = rawAttributes(layoutSection, "story.body.layout");
	assertOnlyKeys(layoutAttrs, new Set(["name", "class"]), "story.body.layout");
	if (
		!/^[0-9a-f]{4}$/u.test(layoutAttrs.name ?? "") ||
		layoutAttrs.class !== "section section--body section--first section--last"
	) {
		throw new MediumContractError(
			"story.body.layout is not a recognized Medium export body wrapper",
		);
	}
	const layoutChildren = significantChildren(
		layoutSection,
		"story.body.layout",
	);
	if (
		layoutChildren.length !== 2 ||
		layoutChildren[0].tagName !== "div" ||
		layoutChildren[1].tagName !== "div"
	) {
		throw new MediumContractError(
			"story.body.layout must contain its divider and content wrappers",
		);
	}
	exactAttributes(
		layoutChildren[0],
		{ class: "section-divider" },
		"story.body.divider",
	);
	const divider = requireSingleChild(
		layoutChildren[0],
		"hr",
		"story.body.divider",
	);
	exactAttributes(
		divider,
		{ class: "section-divider" },
		"story.body.divider.hr",
	);
	exactAttributes(
		layoutChildren[1],
		{ class: "section-content" },
		"story.body.content",
	);
	const inner = requireSingleChild(
		layoutChildren[1],
		"div",
		"story.body.content",
	);
	exactAttributes(
		inner,
		{ class: "section-inner sectionLayout--insetColumn" },
		"story.body.content.inner",
	);
	const rawStoryNodes = significantChildren(inner, "story.body.content.inner");
	if (!subtitleNode && expected.subtitle.length > 0) {
		const renderedSubtitle = rawStoryNodes[1];
		if (
			renderedSubtitle?.tagName !== "h4" ||
			!OFFICIAL_GRAF_CLASSES.get("h4")?.has(
				attributeValue(renderedSubtitle, "class"),
			) ||
			!shellTextMatches(textContent(renderedSubtitle).trim(), expected.subtitle)
		) {
			throw new MediumContractError(
				`Exported story ${expected.slug} is missing its reviewed subtitle`,
			);
		}
	}
	const storyNodes = reconcileOfficialPresentationShell(
		rawStoryNodes,
		expected,
	);
	for (const [index, node] of storyNodes.entries()) {
		normalizeOfficialContentAttributes(
			node,
			`story.body.content.inner.blocks[${index}]`,
		);
	}
	cursor += 1;
	const footer = parts[cursor];
	if (footer?.tagName !== "footer" || cursor !== parts.length - 1) {
		throw new MediumContractError(
			"Official Medium story export must end with exactly one footer",
		);
	}
	validateOfficialFooter(footer, "story.footer");
	return { blocks: extractBlocks(storyNodes, "story") };
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
	if (
		roots.length === 1 &&
		roots[0].tagName === "article" &&
		attributeValue(roots[0], "class") === "h-entry"
	) {
		return validateMediumDocument(extractOfficialMediumStory(body, expected));
	}
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

function collectFigureBlocks(blocks, figures = []) {
	for (const block of blocks) {
		if (block.type === "figure") figures.push(block);
		if (block.type === "blockquote") {
			collectFigureBlocks(block.blocks, figures);
		}
		if (block.type === "list") {
			for (const item of block.items) collectFigureBlocks(item, figures);
		}
	}
	return figures;
}

export function extractMediumHeroEvidence(html, expected) {
	const story = extractMediumStoryHtml(html, expected);
	const document = parseDocument(html, "Medium story export");
	const body = getSingleElement(document, "body", "Medium story export");
	const exportedFigureImages = [];
	walkElements(body, (node) => {
		if (
			node.tagName === "img" &&
			node.parentNode?.tagName === "figure" &&
			attributeValue(node, "data-image-id") !== undefined
		) {
			exportedFigureImages.push(node);
		}
	});
	const explicitlyFeatured = exportedFigureImages.filter(
		(image) => attributeValue(image, "data-is-featured") === "true",
	);
	if (explicitlyFeatured.length > 1) {
		throw new MediumContractError(
			`Exported story ${expected.slug} contains multiple explicitly featured hero images`,
		);
	}
	if (explicitlyFeatured.length === 0 && exportedFigureImages.length !== 1) {
		throw new MediumContractError(
			`Exported story ${expected.slug} has no explicit hero and must contain exactly one exported figure image; found ${exportedFigureImages.length}`,
		);
	}

	const image = explicitlyFeatured[0] ?? exportedFigureImages[0];
	const imageAttributes = rawAttributes(image, "story.hero.img");
	if (
		imageAttributes["data-is-featured"] !== undefined &&
		imageAttributes["data-is-featured"] !== "true"
	) {
		throw new MediumContractError(
			`Exported story ${expected.slug} hero data-is-featured must equal "true" when present`,
		);
	}
	if (!/^\S+$/u.test(imageAttributes["data-image-id"] ?? "")) {
		throw new MediumContractError(
			`Exported story ${expected.slug} hero has no unambiguous image id`,
		);
	}
	for (const dimension of ["data-width", "data-height"]) {
		if (!/^[1-9][0-9]*$/u.test(imageAttributes[dimension] ?? "")) {
			throw new MediumContractError(
				`Exported story ${expected.slug} hero ${dimension} must be a positive integer`,
			);
		}
	}
	assertHttpsUrl(
		imageAttributes.src,
		`Exported story ${expected.slug} hero URL`,
	);
	const sourceUrl = imageAttributes.src;
	const encodedPathComponent = new URL(sourceUrl).pathname.split("/").at(-1);
	let decodedPathComponent;
	try {
		decodedPathComponent = decodeURIComponent(encodedPathComponent ?? "");
	} catch (error) {
		throw new MediumContractError(
			`Exported story ${expected.slug} hero URL has an invalid encoded path component`,
			{ cause: error },
		);
	}
	if (decodedPathComponent !== imageAttributes["data-image-id"]) {
		throw new MediumContractError(
			`Exported story ${expected.slug} hero data-image-id does not match its decoded URL path component`,
		);
	}
	const figure = image.parentNode;
	if (figure?.tagName !== "figure") {
		throw new MediumContractError(
			`Exported story ${expected.slug} featured hero must be contained by a figure`,
		);
	}
	const captions = significantChildren(figure, "story.hero.figure").filter(
		(child) => child.tagName === "figcaption",
	);
	if (captions.length > 1) {
		throw new MediumContractError(
			`Exported story ${expected.slug} hero has multiple captions`,
		);
	}

	const matchingFigures = collectFigureBlocks(story.blocks).filter(
		(block) => new URL(block.sourceUrl).toString() === sourceUrl,
	);
	if (matchingFigures.length !== 1) {
		throw new MediumContractError(
			`Exported story ${expected.slug} hero URL must identify exactly one converted figure`,
		);
	}
	const altPresent = Object.hasOwn(imageAttributes, "alt");
	const captionPresent = captions.length === 1;
	const captionValue = captionPresent ? textContent(captions[0]) : null;
	const convertedCaption = matchingFigures[0].caption
		.map((token) => (token.type === "text" ? token.text : ""))
		.join("");
	if (
		matchingFigures[0].alt !== (altPresent ? imageAttributes.alt : "") ||
		convertedCaption !== (captionValue ?? "")
	) {
		throw new MediumContractError(
			`Exported story ${expected.slug} hero evidence differs from the converted figure`,
		);
	}

	return {
		imageId: imageAttributes["data-image-id"],
		identificationEvidence:
			imageAttributes["data-is-featured"] === "true"
				? "exported-featured-flag"
				: "sole-exported-figure",
		sourceUrl,
		declaredWidth: Number(imageAttributes["data-width"]),
		declaredHeight: Number(imageAttributes["data-height"]),
		alt: {
			present: altPresent,
			value: altPresent ? imageAttributes.alt : null,
		},
		caption: {
			present: captionPresent,
			value: captionValue,
		},
	};
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
