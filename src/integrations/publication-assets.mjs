import { createHash } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|svg|webp)$/iu;
const manifestPath = fileURLToPath(
	new URL("../../provenance/tai-song/manifest.json", import.meta.url),
);

async function walk(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(entryPath)));
		else if (entry.isFile()) files.push(entryPath);
	}
	return files;
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function normalizePath(value) {
	return value.replace(/\\/gu, "/");
}

export default function publicationAssets() {
	return {
		name: "shots-of-rhapsody-publication-assets",
		hooks: {
			"astro:build:done": async ({ dir }) => {
				const outputRoot = fileURLToPath(dir);
				const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
				const articles = manifest.articles ?? [];
				if (
					articles.length !== 11 ||
					new Set(articles.map((article) => article.slug)).size !== 11
				) {
					throw new Error(
						"Publication assets require exactly 11 unique manifest articles",
					);
				}

				const originalHashes = new Set(
					articles.map((article) =>
						String(article.hashes.image).replace(/^sha256:/u, ""),
					),
				);
				if (originalHashes.size !== 11) {
					throw new Error("Publication image hashes must be unique");
				}
				const expectedSocialImages = new Set(
					articles.map((article) => `social/${article.slug}.jpg`),
				);
				expectedSocialImages.add("social/site.jpg");

				const sourceAssetStems = new Set();
				const foundOriginalHashes = new Set();
				for (const file of await walk(outputRoot)) {
					if (!IMAGE_EXTENSION.test(file)) continue;
					const bytes = await readFile(file);
					const digest = sha256(bytes);
					if (!originalHashes.has(digest)) continue;
					const relative = normalizePath(path.relative(outputRoot, file));
					if (!/^_astro\/[^/]+\.png$/u.test(relative)) {
						throw new Error(
							`Manifest original was emitted outside the expected Astro asset boundary: ${relative}`,
						);
					}
					foundOriginalHashes.add(digest);
					sourceAssetStems.add(path.basename(relative, path.extname(relative)));
					await unlink(file);
				}
				if (
					foundOriginalHashes.size !== originalHashes.size ||
					sourceAssetStems.size !== originalHashes.size
				) {
					throw new Error(
						"Astro output did not expose one unique source-asset family for every manifest image",
					);
				}

				const emittedImages = (await walk(outputRoot))
					.filter((file) => IMAGE_EXTENSION.test(file))
					.map((file) => normalizePath(path.relative(outputRoot, file)));
				const unexpectedImages = emittedImages.filter(
					(relative) =>
						relative !== "mark.svg" &&
						!expectedSocialImages.has(relative) &&
						(!/^_astro\/[^/]+\.(?:avif|webp)$/u.test(relative) ||
							![...sourceAssetStems].some((stem) =>
								path.basename(relative).startsWith(`${stem}_`),
							)),
				);
				const missingSocialImages = [...expectedSocialImages].filter(
					(relative) => !emittedImages.includes(relative),
				);
				if (unexpectedImages.length > 0 || missingSocialImages.length > 0) {
					throw new Error(
						[
							unexpectedImages.length > 0
								? `Unexpected built images: ${unexpectedImages.join(", ")}`
								: "",
							missingSocialImages.length > 0
								? `Missing social images: ${missingSocialImages.join(", ")}`
								: "",
						]
							.filter(Boolean)
							.join("; "),
					);
				}
			},
		},
	};
}
