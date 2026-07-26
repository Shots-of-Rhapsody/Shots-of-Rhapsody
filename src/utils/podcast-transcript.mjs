import { parseFragment, serializeOuter } from "parse5";

const TRANSCRIPT_ELEMENTS = new Set([
	"blockquote",
	"br",
	"em",
	"h2",
	"h3",
	"li",
	"ol",
	"p",
	"strong",
	"ul",
]);

export function canonicalTranscriptHtml(source, label = "Podcast transcript") {
	if (typeof source !== "string")
		throw new TypeError(`${label} must be UTF-8 text`);
	const fragment = parseFragment(source);
	let text = "";
	function inspect(node) {
		if (node.nodeName === "#comment")
			throw new Error(`${label} contains an HTML comment`);
		if (node.nodeName === "#text") {
			text += node.value;
			return;
		}
		if (node.tagName) {
			if (!TRANSCRIPT_ELEMENTS.has(node.tagName))
				throw new Error(
					`${label} contains unsupported element <${node.tagName}>`,
				);
			if ((node.attrs ?? []).length > 0)
				throw new Error(
					`${label} contains unsupported attributes on <${node.tagName}>`,
				);
		}
		for (const child of node.childNodes ?? []) inspect(child);
	}
	for (const node of fragment.childNodes) inspect(node);
	if (text.trim().length === 0)
		throw new Error(`${label} does not contain readable text`);
	return fragment.childNodes.map((node) => serializeOuter(node)).join("");
}
