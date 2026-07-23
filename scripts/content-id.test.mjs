import assert from "node:assert/strict";
import test from "node:test";
import { generateContentId } from "../src/utils/content-id.ts";

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
