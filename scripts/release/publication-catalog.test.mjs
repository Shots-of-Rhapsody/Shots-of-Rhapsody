import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createEffectivePublicationCatalog } from "../../src/data/publication-catalog.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function readJson(relative) {
	return JSON.parse(
		await readFile(path.join(repositoryRoot, relative), "utf8"),
	);
}

async function committedFixture() {
	return {
		publicationCatalog: await readJson("provenance/publication-catalog.json"),
		mediumManifest: await readJson("provenance/medium/manifest.json"),
		releaseTarget: await readJson("provenance/release-target.json"),
	};
}

test("release and review modes use the same exact 35-work catalog", async () => {
	const fixture = await committedFixture();
	for (const mode of ["release", "public-review"]) {
		const catalog = createEffectivePublicationCatalog({ mode, ...fixture });
		assert.equal(catalog.entries.length, 35);
		assert.equal(
			catalog.entries.filter((entry) => entry.source === "tai-song").length,
			11,
		);
		assert.equal(
			catalog.entries.filter((entry) => entry.source === "medium").length,
			24,
		);
		assert.equal(
			catalog.entries.filter((entry) => entry.section === "nonfiction").length,
			24,
		);
	}
});

test("the v1 catalog rejects missing, extra, and path-drifted writing", async () => {
	const fixture = await committedFixture();
	const mediumIndex = fixture.publicationCatalog.entries.findIndex(
		(entry) => entry.source === "medium",
	);
	const missing = structuredClone(fixture.publicationCatalog);
	missing.entries.splice(mediumIndex, 1);
	assert.throws(
		() =>
			createEffectivePublicationCatalog({
				mode: "release",
				...fixture,
				publicationCatalog: missing,
			}),
		/exactly 24|all 24|invalid count/u,
	);

	const drifted = structuredClone(fixture.publicationCatalog);
	drifted.entries[mediumIndex].markdown =
		"src/content/posts/wrong-path/index.md";
	assert.throws(
		() =>
			createEffectivePublicationCatalog({
				mode: "release",
				...fixture,
				publicationCatalog: drifted,
			}),
		/invalid publication entry|manifest paths/u,
	);

	const extra = structuredClone(fixture.publicationCatalog);
	extra.entries.push({
		slug: "unapproved-work",
		source: "first-party",
		markdown: "src/content/posts/unapproved-work/index.md",
		section: "nonfiction",
	});
	assert.throws(
		() =>
			createEffectivePublicationCatalog({
				mode: "release",
				...fixture,
				publicationCatalog: extra,
			}),
		/permits only/u,
	);
});
