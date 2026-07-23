import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parse } from "parse5";

const [baselineArgument, candidateArgument = "dist"] = process.argv.slice(2);
if (!baselineArgument) {
	throw new Error(
		"Usage: node scripts/compare-built-html.mjs <baseline-dist> [candidate-dist]",
	);
}

const baselineRoot = path.resolve(baselineArgument);
const candidateRoot = path.resolve(candidateArgument);

async function listHtmlFiles(root, directory = root) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const absolutePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listHtmlFiles(root, absolutePath)));
		} else if (entry.isFile() && entry.name.endsWith(".html")) {
			files.push(path.relative(root, absolutePath).replace(/\\/g, "/"));
		}
	}
	return files.sort();
}

function normalizeAssetUrl(value) {
	return value.replace(
		/(\/[_A-Za-z0-9-]*astro\/)([^\s,"')?#]+)/g,
		(_match, prefix, filename) => {
			const extension = path.posix.extname(filename);
			const stem = filename.slice(0, -extension.length);
			const stableStem = stem.replace(
				/\.[A-Za-z0-9_-]{8,}(?:_[A-Za-z0-9_-]+)?$/,
				".<asset>",
			);
			return `${prefix}${stableStem}${extension}`;
		},
	);
}

function stableAttributes(node) {
	const attributes = [];
	for (const attribute of node.attrs ?? []) {
		if (
			(node.tagName === "path" && attribute.name === "d") ||
			attribute.name === "class" ||
			attribute.name === "style" ||
			attribute.name.startsWith("data-astro-cid-") ||
			attribute.name.startsWith("data-astro-transition-") ||
			attribute.name === "data-astro-source-file" ||
			attribute.name === "data-astro-source-loc" ||
			(attribute.name === "fetchpriority" && attribute.value === "auto") ||
			attribute.name === "component-url" ||
			attribute.name === "component-export" ||
			attribute.name === "uid" ||
			attribute.name === "renderer-url" ||
			attribute.name === "props" ||
			attribute.name === "opts"
		) {
			continue;
		}
		attributes.push([
			attribute.name,
			normalizeAssetUrl(attribute.value.replace(/\s+/g, " ").trim()).replace(
				/\bGC[A-Za-z0-9]{6,12}\b/g,
				"GC<hash>",
			),
		]);
	}
	return attributes.sort(([left], [right]) => left.localeCompare(right));
}

function shouldSkip(node) {
	if (node.nodeName === "#comment") return true;
	if (node.tagName === "script" || node.tagName === "style") return true;
	if (node.tagName === "meta") {
		const name = node.attrs?.find(
			(attribute) => attribute.name === "name",
		)?.value;
		if (name === "generator") return true;
	}
	if (node.tagName === "link") {
		const rel = node.attrs?.find(
			(attribute) => attribute.name === "rel",
		)?.value;
		if (rel && /^(?:stylesheet|modulepreload|preload)$/.test(rel)) return true;
	}
	return false;
}

function normalizeNode(node, preserveWhitespace = false) {
	if (shouldSkip(node)) return undefined;
	if (node.nodeName === "#text") {
		const normalized = preserveWhitespace
			? node.value.replace(/\r\n?/g, "\n")
			: node.value.replace(/\s+/g, " ").trim();
		return normalized ? { text: normalized } : undefined;
	}

	const tagName = node.tagName ?? node.nodeName;
	const keepWhitespace =
		preserveWhitespace || /^(?:code|pre|textarea)$/.test(tagName);
	const children = (node.childNodes ?? [])
		.map((child) => normalizeNode(child, keepWhitespace))
		.filter(Boolean);
	return {
		tag: tagName,
		attrs: stableAttributes(node),
		children,
	};
}

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

function findFirstDifference(left, right, location = "document") {
	if (Object.is(left, right)) return undefined;
	if (typeof left !== typeof right) {
		return `${location}: ${typeof left} != ${typeof right}`;
	}
	if (left === null || right === null || typeof left !== "object") {
		return `${location}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`;
	}
	if (Array.isArray(left) !== Array.isArray(right)) {
		return `${location}: array shape changed`;
	}
	if (Array.isArray(left)) {
		if (left.length !== right.length) {
			if (location.endsWith(".attrs")) {
				return `${location}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`;
			}
			return `${location}: ${left.length} children != ${right.length} children`;
		}
		for (let index = 0; index < left.length; index += 1) {
			const difference = findFirstDifference(
				left[index],
				right[index],
				`${location}[${index}]`,
			);
			if (difference) return difference;
		}
		return undefined;
	}
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (JSON.stringify(leftKeys) !== JSON.stringify(rightKeys)) {
		return `${location}: object keys changed`;
	}
	for (const key of leftKeys) {
		const difference = findFirstDifference(
			left[key],
			right[key],
			`${location}.${key}`,
		);
		if (difference) return difference;
	}
	return undefined;
}

const baselineFiles = await listHtmlFiles(baselineRoot);
const candidateFiles = await listHtmlFiles(candidateRoot);
if (JSON.stringify(baselineFiles) !== JSON.stringify(candidateFiles)) {
	throw new Error(
		`HTML route set changed.\nBaseline: ${baselineFiles.join(", ")}\nCandidate: ${candidateFiles.join(", ")}`,
	);
}

const differences = [];
for (const relativePath of baselineFiles) {
	const [baselineHtml, candidateHtml] = await Promise.all([
		readFile(path.join(baselineRoot, relativePath), "utf8"),
		readFile(path.join(candidateRoot, relativePath), "utf8"),
	]);
	const baselineDocument = normalizeNode(parse(baselineHtml));
	const candidateDocument = normalizeNode(parse(candidateHtml));
	const baselineSemantic = JSON.stringify(baselineDocument);
	const candidateSemantic = JSON.stringify(candidateDocument);
	if (baselineSemantic !== candidateSemantic) {
		differences.push(
			`${relativePath}: ${digest(baselineSemantic)} != ${digest(candidateSemantic)} (${findFirstDifference(baselineDocument, candidateDocument)})`,
		);
	}
}

if (differences.length > 0) {
	throw new Error(
		`Semantic DOM changed in ${differences.length} page(s):\n${differences.join("\n")}`,
	);
}

console.log(
	`Semantic DOM comparison passed: ${baselineFiles.length} HTML pages match`,
);
