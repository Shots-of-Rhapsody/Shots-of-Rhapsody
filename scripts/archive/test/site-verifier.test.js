import assert from "node:assert/strict";
import test from "node:test";
import { archiveBodyStructure } from "../../verify-built-site.mjs";

test("built-site body comparison normalizes HTML serialization only", () => {
	const source =
		"<p>Exact &#39;text&#39; &amp; marks</p>\n<p><strong>Bold</strong><br /><em>Italic</em></p>";
	const serialized =
		"\n<p>Exact 'text' &amp; marks</p>\n<p><strong>Bold</strong><br><em>Italic</em></p>\n";
	assert.deepEqual(
		archiveBodyStructure(serialized),
		archiveBodyStructure(source),
	);
});

test("built-site body comparison retains exact text, marks, and blocks", () => {
	const source = "<p>Exact text</p><p><strong>Marked</strong></p>";
	assert.notDeepEqual(
		archiveBodyStructure("<p>Edited text</p><p><strong>Marked</strong></p>"),
		archiveBodyStructure(source),
	);
	assert.notDeepEqual(
		archiveBodyStructure("<p>Exact text</p><p><em>Marked</em></p>"),
		archiveBodyStructure(source),
	);
	assert.notDeepEqual(
		archiveBodyStructure("<p>Exact text</p>"),
		archiveBodyStructure(source),
	);
});
