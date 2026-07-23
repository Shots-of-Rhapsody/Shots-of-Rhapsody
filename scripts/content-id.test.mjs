import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@astrojs/markdown-remark";
import { generateContentId } from "../src/utils/content-id.ts";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

async function listMarkdownFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const absolutePath = path.join(directory, entry.name);
		if (entry.isDirectory())
			files.push(...(await listMarkdownFiles(absolutePath)));
		else if (entry.isFile() && /\.mdx?$/i.test(entry.name))
			files.push(absolutePath);
	}
	return files.sort();
}

test("preserves historical directory-index and nested post routes", () => {
	assert.equal(
		generateContentId("before-the-sky-went-quiet/index.md", {}),
		"before-the-sky-went-quiet",
	);
	assert.equal(
		generateContentId("Modular Ethics/Modular Ethics.md", {}),
		"modular-ethics/modular-ethics",
	);
	assert.equal(generateContentId("video.md", {}), "video");
});

test("normalizes Windows paths and Unicode deterministically", () => {
	assert.equal(
		generateContentId("Café Notes\\L'Eté.mdx", {}),
		"cafe-notes/lete",
	);
});

test("explicit frontmatter slugs take precedence without case changes", () => {
	assert.equal(
		generateContentId("ignored/index.md", { slug: " /Keep/This-Route/ " }),
		"Keep/This-Route",
	);
});

test("the complete post inventory has unique deterministic route IDs", async () => {
	const postsRoot = path.join(repositoryRoot, "src/content/posts");
	const files = await listMarkdownFiles(postsRoot);
	const owners = new Map();
	for (const absolutePath of files) {
		const entry = path.relative(postsRoot, absolutePath).replaceAll("\\", "/");
		const source = await readFile(absolutePath, "utf8");
		const { frontmatter } = parseFrontmatter(source);
		const id = generateContentId(entry, frontmatter);
		assert.equal(
			owners.get(id),
			undefined,
			`content ID ${id} is shared by ${owners.get(id)} and ${entry}`,
		);
		owners.set(id, entry);
	}

	assert.equal(
		owners.size,
		15,
		"the release inventory must retain 11 posts and 4 drafts",
	);
	const manifest = JSON.parse(
		await readFile(
			path.join(repositoryRoot, "provenance/tai-song/manifest.json"),
			"utf8",
		),
	);
	for (const article of manifest.articles) {
		assert.ok(
			owners.has(article.slug),
			`manifest route ${article.slug} is missing`,
		);
	}
});
