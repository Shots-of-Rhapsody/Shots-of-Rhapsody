import {
	assertNonEmptyString,
	assertOptionalString,
	assertPlainObject,
	ContractError,
} from "./contract.js";

function assertOnlyKeys(object, allowed, label) {
	for (const key of Object.keys(object)) {
		if (!allowed.has(key)) {
			throw new ContractError(
				`${label} contains unsupported key ${JSON.stringify(key)}`,
			);
		}
	}
}

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
		.replace(/\r\n|\r|\n/g, "<br />\n");
}

function renderTextLeaf(leaf, label) {
	assertPlainObject(leaf, label);
	assertOnlyKeys(leaf, new Set(["object", "text", "marks"]), label);
	if (leaf.object !== "text") {
		throw new ContractError(`${label}.object must equal "text"`);
	}
	if (typeof leaf.text !== "string") {
		throw new ContractError(`${label}.text must be a string`);
	}
	if (!Array.isArray(leaf.marks)) {
		throw new ContractError(`${label}.marks must be an array`);
	}
	const marks = new Set();
	for (let index = 0; index < leaf.marks.length; index += 1) {
		const markLabel = `${label}.marks[${index}]`;
		const mark = assertPlainObject(leaf.marks[index], markLabel);
		assertOnlyKeys(mark, new Set(["type"]), markLabel);
		if (mark.type !== "bold" && mark.type !== "italic") {
			throw new ContractError(
				`${markLabel}.type ${JSON.stringify(mark.type)} is unsupported`,
			);
		}
		if (marks.has(mark.type)) {
			throw new ContractError(`${label} repeats the ${mark.type} mark`);
		}
		marks.add(mark.type);
	}

	let rendered = escapeHtml(leaf.text);
	if (marks.has("italic")) rendered = `<em>${rendered}</em>`;
	if (marks.has("bold")) rendered = `<strong>${rendered}</strong>`;
	return rendered;
}

function renderParagraph(node, index) {
	const label = `post.content.document.nodes[${index}]`;
	assertPlainObject(node, label);
	assertOnlyKeys(node, new Set(["object", "type", "data", "nodes"]), label);
	if (node.object !== "block") {
		throw new ContractError(`${label}.object must equal "block"`);
	}
	if (node.type !== "paragraph") {
		throw new ContractError(
			`${label}.type ${JSON.stringify(node.type)} is unsupported; expected paragraph`,
		);
	}
	const data = assertPlainObject(node.data, `${label}.data`);
	if (Object.keys(data).length !== 0) {
		throw new ContractError(`${label}.data must be empty`);
	}
	if (!Array.isArray(node.nodes)) {
		throw new ContractError(`${label}.nodes must be an array`);
	}
	const children = node.nodes.map((leaf, childIndex) =>
		renderTextLeaf(leaf, `${label}.nodes[${childIndex}]`),
	);
	return `<p>${children.join("")}</p>`;
}

export function renderSlateDocument(document) {
	assertPlainObject(document, "post.content.document");
	assertOnlyKeys(
		document,
		new Set(["object", "data", "nodes"]),
		"post.content.document",
	);
	if (document.object !== "document") {
		throw new ContractError(
			'post.content.document.object must equal "document"',
		);
	}
	const data = assertPlainObject(document.data, "post.content.document.data");
	if (Object.keys(data).length !== 0) {
		throw new ContractError("post.content.document.data must be empty");
	}
	if (!Array.isArray(document.nodes) || document.nodes.length === 0) {
		throw new ContractError(
			"post.content.document.nodes must be a non-empty array",
		);
	}
	return document.nodes.map(renderParagraph).join("\n");
}

function yamlString(value) {
	return JSON.stringify(value);
}

function yamlStringList(values) {
	return `[${values.map((value) => yamlString(value)).join(", ")}]`;
}

function appendString(lines, name, value) {
	lines.push(`${name}: ${yamlString(value)}`);
}

function yamlValue(value, label) {
	if (value === null) return "null";
	if (typeof value === "string") return yamlString(value);
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	throw new ContractError(`${label} must be a string or finite number`);
}

export function renderIndexMarkdown(metadata, document) {
	assertPlainObject(metadata, "metadata");
	const title = assertNonEmptyString(metadata.title, "metadata.title");
	const subtitle = assertNonEmptyString(metadata.subtitle, "metadata.subtitle");
	const summary = assertNonEmptyString(metadata.summary, "metadata.summary");
	const published = assertNonEmptyString(
		metadata.published,
		"metadata.published",
	);
	const sourceUrl = assertNonEmptyString(
		metadata.sourceUrl,
		"metadata.sourceUrl",
	);
	const imageAlt = metadata.imageAlt;
	if (imageAlt !== null && typeof imageAlt !== "string") {
		throw new ContractError("metadata.imageAlt must be a string or null");
	}
	const imageCaption = assertOptionalString(
		metadata.imageCaption,
		"metadata.imageCaption",
	);
	if (imageCaption === undefined) {
		throw new ContractError("metadata.imageCaption must be a string");
	}
	const imageSourceUrl = assertNonEmptyString(
		metadata.imageSourceUrl,
		"metadata.imageSourceUrl",
	);
	const updated = assertOptionalString(metadata.updated, "metadata.updated");
	const category = assertNonEmptyString(metadata.category, "metadata.category");
	if (
		!Array.isArray(metadata.tags) ||
		metadata.tags.some((tag) => typeof tag !== "string")
	) {
		throw new ContractError("metadata.tags must be an array of strings");
	}
	const source = assertPlainObject(metadata.source, "metadata.source");
	for (const key of [
		"id",
		"url",
		"capturedAt",
		"publishedAt",
		"wordCount",
		"communitySlug",
	]) {
		if (source[key] === undefined || source[key] === null) {
			throw new ContractError(`metadata.source.${key} is required`);
		}
	}
	if (
		source.contentUpdatedAt !== null &&
		typeof source.contentUpdatedAt !== "string"
	) {
		throw new ContractError(
			"metadata.source.contentUpdatedAt must be a string or null",
		);
	}

	const lines = ["---"];
	appendString(lines, "title", title);
	appendString(lines, "subtitle", subtitle);
	appendString(lines, "published", published);
	if (updated !== undefined) appendString(lines, "updated", updated);
	appendString(lines, "description", subtitle);
	appendString(lines, "summary", summary);
	appendString(lines, "image", "./hero-original.png");
	lines.push(`imageAlt: ${yamlValue(imageAlt, "metadata.imageAlt")}`);
	appendString(lines, "imageCaption", imageCaption);
	appendString(lines, "imageSourceUrl", imageSourceUrl);
	appendString(lines, "author", "Tai Song");
	lines.push(`tags: ${yamlStringList(metadata.tags)}`);
	appendString(lines, "category", category);
	lines.push("source:");
	appendString(lines, "  platform", "Vocal");
	lines.push(`  id: ${yamlValue(source.id, "metadata.source.id")}`);
	appendString(lines, "  url", sourceUrl);
	appendString(lines, "  capturedAt", source.capturedAt);
	appendString(lines, "  publishedAt", source.publishedAt);
	lines.push(
		`  contentUpdatedAt: ${yamlValue(source.contentUpdatedAt, "metadata.source.contentUpdatedAt")}`,
	);
	lines.push(
		`  wordCount: ${yamlValue(source.wordCount, "metadata.source.wordCount")}`,
	);
	appendString(lines, "  communitySlug", source.communitySlug);
	lines.push("license:");
	appendString(lines, "  name", "All Rights Reserved");
	lines.push("---", "", renderSlateDocument(document), "");
	return lines.join("\n");
}
