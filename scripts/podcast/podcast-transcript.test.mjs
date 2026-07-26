import assert from "node:assert/strict";
import test from "node:test";
import { canonicalTranscriptHtml } from "../../src/utils/podcast-transcript.mjs";

test("transcript allowlist preserves only reviewed semantic text markup", () => {
	assert.equal(
		canonicalTranscriptHtml(
			"<h2>Opening</h2><p>Plain <strong>bold</strong> and <em>italic</em>.<br>Next line.</p><blockquote><p>Quoted.</p></blockquote><ul><li>One</li></ul>",
		),
		"<h2>Opening</h2><p>Plain <strong>bold</strong> and <em>italic</em>.<br>Next line.</p><blockquote><p>Quoted.</p></blockquote><ul><li>One</li></ul>",
	);
});

for (const [label, source, pattern] of [
	["scripts", "<p>Text</p><script>alert(1)</script>", /unsupported element/u],
	[
		"event handlers",
		'<p onclick="alert(1)">Text</p>',
		/unsupported attributes/u,
	],
	[
		"links",
		'<p><a href="https://example.com">Text</a></p>',
		/unsupported element/u,
	],
	["comments", "<p>Text</p><!-- hidden -->", /HTML comment/u],
	["empty markup", "<p> </p>", /readable text/u],
]) {
	test(`transcript allowlist rejects ${label}`, () => {
		assert.throws(() => canonicalTranscriptHtml(source), pattern);
	});
}
