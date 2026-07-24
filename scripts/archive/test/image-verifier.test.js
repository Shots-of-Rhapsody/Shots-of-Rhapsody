import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { verifyBuiltImages } from "../../verify-images.mjs";

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function pictureMarkup({ priority = false } = {}) {
	return `<picture><source type="image/avif" srcset="/_astro/hero.avif 320w" sizes="100vw"><img src="/_astro/hero.webp" srcset="/_astro/hero.webp 320w" sizes="100vw" width="2048" height="2048" loading="${priority ? "eager" : "lazy"}"${priority ? ' fetchpriority="high"' : ""} alt=""></picture>`;
}

async function createFixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "shots-images-"));
	const dist = path.join(root, "dist");
	const provenance = path.join(root, "provenance", "tai-song");
	await mkdir(path.join(dist, "_astro"), { recursive: true });
	await mkdir(path.join(dist, "social"), { recursive: true });
	await mkdir(provenance, { recursive: true });

	const originalBytes = Buffer.from("archival-original-fixture");
	const slugs = Array.from(
		{ length: 11 },
		(_, index) => `article-${index + 1}`,
	);
	const manifest = {
		articles: slugs.map((slug, index) => ({
			slug,
			hashes: {
				image:
					index === 0
						? `sha256:${sha256(originalBytes)}`
						: `sha256:${String(index).padStart(64, "0")}`,
			},
		})),
	};
	await writeFile(
		path.join(provenance, "manifest.json"),
		JSON.stringify(manifest),
	);

	const responsiveInput = randomBytes(320 * 320 * 3);
	const responsiveAvif = await sharp(responsiveInput, {
		raw: { width: 320, height: 320, channels: 3 },
	})
		.avif({ quality: 20 })
		.toBuffer();
	const responsiveWebp = await sharp(responsiveInput, {
		raw: { width: 320, height: 320, channels: 3 },
	})
		.webp({ quality: 20 })
		.toBuffer();
	await writeFile(path.join(dist, "_astro", "hero.avif"), responsiveAvif);
	await writeFile(path.join(dist, "_astro", "hero.webp"), responsiveWebp);

	const socialJpeg = await sharp({
		create: {
			width: 1200,
			height: 1200,
			channels: 3,
			background: "#efe8d5",
		},
	})
		.jpeg({ quality: 40, mozjpeg: true })
		.toBuffer();
	for (const slug of slugs) {
		await writeFile(path.join(dist, "social", `${slug}.jpg`), socialJpeg);
		const postDirectory = path.join(dist, "posts", slug);
		await mkdir(postDirectory, { recursive: true });
		await writeFile(
			path.join(postDirectory, "index.html"),
			`<figure data-archive-hero><div data-image-variant="hero">${pictureMarkup()}</div></figure><meta property="og:image" content="/social/${slug}.jpg">`,
		);
	}
	await writeFile(path.join(dist, "mark.svg"), "<svg></svg>");
	await mkdir(path.join(dist, "pagefind"), { recursive: true });
	await writeFile(
		path.join(dist, "pagefind", "pagefind.js"),
		randomBytes(32 * 1024),
	);
	await writeFile(
		path.join(dist, "index.html"),
		`<!doctype html><html><head><link rel="icon" href="/mark.svg"><script>window.__fixture=true</script></head><body><article data-editorial-slug="${slugs[0]}">${pictureMarkup({ priority: true })}</article></body></html>`,
	);

	return { root, dist, originalBytes, slugs };
}

test("accepts an allowlisted responsive publication artifact", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	const stats = await verifyBuiltImages({
		dist: fixture.dist,
		repoRoot: fixture.root,
	});
	assert.equal(stats.imageCount, 14);
	assert.ok(stats.initialJavaScriptGzipBytes > 0);
	assert.ok(stats.initialJavaScriptGzipBytes < 1024);
	assert.ok(stats.homepageInitialImageBytes > 0);
});

test("rejects a leaked archival original by its manifest hash", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	await writeFile(
		path.join(fixture.dist, "_astro", "original.png"),
		fixture.originalBytes,
	);
	await assert.rejects(
		verifyBuiltImages({ dist: fixture.dist, repoRoot: fixture.root }),
		/archival original image leaked into dist/u,
	);
});

test("rejects an unreferenced responsive or draft asset", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	const orphan = await sharp({
		create: {
			width: 320,
			height: 320,
			channels: 3,
			background: "#111111",
		},
	})
		.webp()
		.toBuffer();
	await writeFile(path.join(fixture.dist, "_astro", "draft.webp"), orphan);
	await assert.rejects(
		verifyBuiltImages({ dist: fixture.dist, repoRoot: fixture.root }),
		/built image is not referenced by any output/u,
	);
});

test("rejects a referenced derivative outside manifest-bound heroes and cards", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	const draft = await sharp({
		create: {
			width: 320,
			height: 320,
			channels: 3,
			background: "#111111",
		},
	})
		.webp()
		.toBuffer();
	await writeFile(path.join(fixture.dist, "_astro", "draft.webp"), draft);
	const homepagePath = path.join(fixture.dist, "index.html");
	const homepage = await readFile(homepagePath, "utf8");
	await writeFile(
		homepagePath,
		homepage.replace(
			"</body>",
			'<img src="/_astro/draft.webp" loading="lazy" alt=""></body>',
		),
	);
	await assert.rejects(
		verifyBuiltImages({ dist: fixture.dist, repoRoot: fixture.root }),
		/not bound to a manifest article source/u,
	);
});

test("requires exactly one eager high-priority homepage image", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	const homepagePath = path.join(fixture.dist, "index.html");
	const homepage = await readFile(homepagePath, "utf8");
	await writeFile(
		homepagePath,
		homepage.replace("</body>", `${pictureMarkup({ priority: true })}</body>`),
	);
	await assert.rejects(
		verifyBuiltImages({ dist: fixture.dist, repoRoot: fixture.root }),
		/exactly one initially loaded eager\/high-priority image/u,
	);
});

test("enforces derivative and total artifact budgets", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	await assert.rejects(
		verifyBuiltImages({
			dist: fixture.dist,
			repoRoot: fixture.root,
			limits: {
				cardBytes: 1,
				socialBytes: 1,
				distBytes: 1,
				initialJavaScriptGzipBytes: 1,
				homepageDesktopImageBytes: 1,
				homepageMobileImageBytes: 1,
			},
		}),
		/budget|exceeds/u,
	);
});
