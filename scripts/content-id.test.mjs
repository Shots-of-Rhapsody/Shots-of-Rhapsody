import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@astrojs/markdown-remark";
import {
	generateContentId,
	generatePostContentId,
} from "../src/utils/content-id.ts";

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

test("published master folders do not become part of stable post IDs", () => {
	assert.equal(
		generatePostContentId("fiction/before-the-sky-went-quiet/index.md"),
		"before-the-sky-went-quiet",
	);
	assert.equal(
		generatePostContentId("nonfiction/the-invisible-ledger/index.md"),
		"the-invisible-ledger",
	);
	assert.equal(
		generatePostContentId("fiction\\cold-children\\index.md"),
		"cold-children",
	);
	for (const entry of [
		"before-the-sky-went-quiet/index.md",
		"poetry/poetic-biography/index.md",
		"fiction/nested/work/index.md",
		"fiction/work.md",
	]) {
		assert.throws(() => generatePostContentId(entry), /unsupported layout/u);
	}
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

test("the complete two-folder post inventory preserves every public route", async () => {
	const postsRoot = path.join(repositoryRoot, "src/content/posts");
	const topLevel = await readdir(postsRoot, { withFileTypes: true });
	assert.deepEqual(
		topLevel
			.map(
				(entry) =>
					`${entry.isDirectory() ? "directory" : "other"}:${entry.name}`,
			)
			.sort(),
		["directory:fiction", "directory:nonfiction"],
	);
	const files = await listMarkdownFiles(postsRoot);
	const owners = new Map();
	for (const absolutePath of files) {
		const entry = path.relative(postsRoot, absolutePath).replaceAll("\\", "/");
		const source = await readFile(absolutePath, "utf8");
		const { frontmatter } = parseFrontmatter(source);
		const id = generatePostContentId(entry);
		assert.equal(
			owners.get(id),
			undefined,
			`content ID ${id} is shared by ${owners.get(id)} and ${entry}`,
		);
		owners.set(id, entry);
		assert.notEqual(frontmatter.draft, true, `${entry} must be published`);
	}

	const releaseTarget = JSON.parse(
		await readFile(
			path.join(repositoryRoot, "provenance/release-target.json"),
			"utf8",
		),
	);
	const expectedWritingCount =
		releaseTarget.expected.archiveWriting +
		releaseTarget.expected.mediumWriting;
	assert.equal(
		owners.size,
		expectedWritingCount,
		"the published inventory must contain exactly every targeted work",
	);
	const manifests = await Promise.all(
		["tai-song", "medium"].map(async (source) =>
			JSON.parse(
				await readFile(
					path.join(repositoryRoot, `provenance/${source}/manifest.json`),
					"utf8",
				),
			),
		),
	);
	const articles = manifests.flatMap((manifest) => manifest.articles);
	assert.equal(articles.length, expectedWritingCount);
	for (const article of articles) {
		assert.ok(
			owners.has(article.slug),
			`manifest route ${article.slug} is missing`,
		);
	}

	const catalog = JSON.parse(
		await readFile(
			path.join(repositoryRoot, "provenance/publication-catalog.json"),
			"utf8",
		),
	);
	assert.equal(catalog.schemaVersion, 2);
	assert.equal(
		catalog.entries.filter((entry) => entry.masterFolder === "fiction").length,
		11,
	);
	assert.equal(
		catalog.entries.filter((entry) => entry.masterFolder === "nonfiction")
			.length,
		24,
	);
	for (const entry of catalog.entries) {
		assert.equal(
			owners.get(entry.slug),
			`${entry.masterFolder}/${entry.slug}/index.md`,
		);
	}

	const draftsRoot = path.join(repositoryRoot, "src/content/drafts");
	const draftFiles = await listMarkdownFiles(draftsRoot);
	assert.equal(draftFiles.length, 4, "the four legacy drafts must remain");
	for (const absolutePath of draftFiles) {
		const { frontmatter } = parseFrontmatter(
			await readFile(absolutePath, "utf8"),
		);
		assert.equal(frontmatter.draft, true);
	}
});
