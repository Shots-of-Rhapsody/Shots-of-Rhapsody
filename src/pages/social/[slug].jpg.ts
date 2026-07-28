import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { APIRoute, GetStaticPaths } from "astro";
import sharp from "sharp";
import { PUBLICATION_CATALOG as publicationCatalog } from "@/data/publication-catalog";
import firstPartyManifest from "../../../provenance/first-party/manifest.json";
import mediumManifest from "../../../provenance/medium/manifest.json";
import archiveManifest from "../../../provenance/tai-song/manifest.json";
import { getPublishedPostAssetPrefix } from "../../utils/content-path";
import {
	SOCIAL_IMAGE_MAX_WIDTH,
	SOCIAL_IMAGE_QUALITY,
} from "../../utils/image-policy";

const repositoryRoot = process.cwd();
const mediumArticles = (
	mediumManifest as unknown as {
		articles: Array<{
			slug: string;
			assets: Array<{
				role: "hero" | "body";
				path: string;
				sha256: string;
				mimeType: string;
				width: number;
				height: number;
				byteSize: number;
			}>;
		}>;
	}
).articles;
const firstPartyArticles = (
	firstPartyManifest as unknown as {
		articles: Array<{
			slug: string;
			assets: Array<{
				role: "hero" | "body";
				path: string;
				sha256: string;
				mimeType: string;
				width: number;
				height: number;
				byteSize: number;
			}>;
		}>;
	}
).articles;

function resolveImagePath(entry: (typeof publicationCatalog.entries)[number]) {
	if (entry.source === "tai-song") {
		const article = archiveManifest.articles.find(
			(article) => article.slug === entry.slug,
		);
		return article
			? { path: article.paths.image, ...article.image }
			: undefined;
	}
	if (entry.source === "medium")
		return mediumArticles
			.find((article) => article.slug === entry.slug)
			?.assets.find((asset) => asset.role === "hero");
	return firstPartyArticles
		.find((article) => article.slug === entry.slug)
		?.assets.find((asset) => asset.role === "hero");
}

const publicationImages = publicationCatalog.entries.map((entry) => {
	const image = resolveImagePath(entry);
	if (!image)
		throw new Error(`Publication catalog lacks a hero image for ${entry.slug}`);
	const expectedPrefix = getPublishedPostAssetPrefix(
		entry.masterFolder,
		entry.slug,
	);
	if (
		!image.path.startsWith(expectedPrefix) ||
		!/^[-a-z0-9]+\.(?:png|jpe?g|webp)$/u.test(
			image.path.slice(expectedPrefix.length),
		)
	)
		throw new Error(`Publication hero path is unsafe for ${entry.slug}`);
	return { slug: entry.slug, image };
});

if (
	new Set(publicationImages.map((article) => article.slug)).size !==
	publicationImages.length
)
	throw new Error("Social images require unique publication slugs");

export const getStaticPaths = (() =>
	publicationImages.map((article) => ({
		params: { slug: article.slug },
		props: article,
	}))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => {
	const image = props.image as (typeof publicationImages)[number]["image"];
	const imagePath = String(image.path);
	const absoluteImagePath = path.resolve(repositoryRoot, imagePath);
	const contentRoot = path.resolve(repositoryRoot, "src/content/posts");
	const relative = path.relative(contentRoot, absoluteImagePath);
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		throw new Error(`Social-image path escapes the content root: ${imagePath}`);
	if ((await lstat(absoluteImagePath)).isSymbolicLink())
		throw new Error(`Social-image source must not be a symlink: ${imagePath}`);
	const [realContentRoot, realImagePath] = await Promise.all([
		realpath(contentRoot),
		realpath(absoluteImagePath),
	]);
	const realRelative = path.relative(realContentRoot, realImagePath);
	if (
		realRelative === "" ||
		realRelative === ".." ||
		realRelative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(realRelative)
	)
		throw new Error(
			`Social-image source resolves outside content: ${imagePath}`,
		);

	const bytes = await readFile(realImagePath);
	const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	const metadata = await sharp(bytes).metadata();
	const expectedFormat =
		image.mimeType === "image/png"
			? "png"
			: image.mimeType === "image/webp"
				? "webp"
				: "jpeg";
	if (
		digest !== image.sha256 ||
		bytes.byteLength !== image.byteSize ||
		metadata.format !== expectedFormat ||
		metadata.width !== image.width ||
		metadata.height !== image.height
	)
		throw new Error(`Social-image source differs from evidence: ${imagePath}`);

	const jpeg = await sharp(bytes)
		.resize(SOCIAL_IMAGE_MAX_WIDTH, SOCIAL_IMAGE_MAX_WIDTH, {
			fit: "contain",
			background: "#efe8d5",
			withoutEnlargement: false,
		})
		.jpeg({ quality: SOCIAL_IMAGE_QUALITY, mozjpeg: true })
		.toBuffer();

	return new Response(new Uint8Array(jpeg), {
		headers: {
			"Cache-Control": "public, max-age=31536000, immutable",
			"Content-Length": String(jpeg.byteLength),
			"Content-Type": "image/jpeg",
		},
	});
};
