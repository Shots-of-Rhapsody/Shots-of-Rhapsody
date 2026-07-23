import {
	ALL_RIGHTS_RESERVED,
	AUTHOR_NAME,
	AUTHORITY_PLATFORM,
	assertNonEmptyString,
	assertPlainObject,
	assertString,
	ContractError,
} from "./contract.js";
import { validateDocument } from "./extract.js";
import { sha256 } from "./integrity.js";

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderInline(child) {
	if (child.type === "break") return "<br />";
	let rendered = escapeHtml(child.text);
	if (child.marks.includes("italic")) rendered = `<em>${rendered}</em>`;
	if (child.marks.includes("bold")) rendered = `<strong>${rendered}</strong>`;
	return rendered;
}

export function renderBodyHtml(value) {
	const document = validateDocument(value);
	return document.blocks
		.map((block) => `<p>${block.children.map(renderInline).join("")}</p>`)
		.join("\n");
}

export function bodyTextSha256(value) {
	const document = validateDocument(value);
	const textStructure = document.blocks.map((block) =>
		block.children.map((child) =>
			child.type === "break" ? ["break"] : ["text", child.text],
		),
	);
	return sha256(Buffer.from(JSON.stringify(textStructure), "utf8"));
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

export function renderIndexMarkdown(snapshot) {
	const value = assertPlainObject(snapshot, "snapshot");
	const title = assertNonEmptyString(value.title, "snapshot.title");
	const subtitle = assertNonEmptyString(value.subtitle, "snapshot.subtitle");
	const summary = assertString(value.summary, "snapshot.summary");
	const description = assertString(value.description, "snapshot.description");
	const published = assertNonEmptyString(value.published, "snapshot.published");
	const category = assertNonEmptyString(value.category, "snapshot.category");
	if (
		!Array.isArray(value.tags) ||
		value.tags.some((tag) => typeof tag !== "string")
	) {
		throw new ContractError("snapshot.tags must be an array of strings");
	}
	assertPlainObject(value.hero, "snapshot.hero");
	const alt = value.imageAlt;
	if (alt !== null && typeof alt !== "string") {
		throw new ContractError("snapshot.imageAlt must be a string or null");
	}
	const caption = assertNonEmptyString(
		value.imageCaption,
		"snapshot.imageCaption",
	);
	const provenance = assertPlainObject(value.provenance, "snapshot.provenance");

	const lines = ["---"];
	appendString(lines, "title", title);
	appendString(lines, "subtitle", subtitle);
	appendString(lines, "published", published);
	appendString(lines, "description", description);
	appendString(lines, "summary", summary);
	appendString(lines, "image", "./hero-original.png");
	lines.push(`imageAlt: ${alt === null ? "null" : yamlString(alt)}`);
	appendString(lines, "imageCaption", caption);
	appendString(lines, "author", AUTHOR_NAME);
	lines.push(`tags: ${yamlStringList(value.tags)}`);
	appendString(lines, "category", category);
	lines.push("provenance:");
	appendString(lines, "  authority", AUTHORITY_PLATFORM);
	appendString(lines, "  captureFormat", provenance.captureFormat);
	appendString(lines, "  capturedAt", provenance.capturedAt);
	appendString(lines, "  bodyTextSha256", value.bodyTextSha256);
	lines.push(`  bodyBlockCount: ${value.bodyBlockCount}`);
	if (value.publication) {
		lines.push("publication:");
		appendString(lines, "  platform", value.publication.platform);
		appendString(lines, "  url", value.publication.url);
	}
	lines.push("license:");
	appendString(lines, "  name", ALL_RIGHTS_RESERVED);
	lines.push("---", "", value.bodyHtml, "");
	return lines.join("\n");
}
