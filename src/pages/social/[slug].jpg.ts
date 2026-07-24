import path from "node:path";
import type { APIRoute, GetStaticPaths } from "astro";
import sharp from "sharp";
import manifest from "../../../provenance/tai-song/manifest.json";
import {
	SOCIAL_IMAGE_MAX_WIDTH,
	SOCIAL_IMAGE_QUALITY,
} from "../../utils/image-policy";

const EXPECTED_SOCIAL_IMAGE_COUNT = 11;
const repositoryRoot = process.cwd();

if (
	manifest.articles.length !== EXPECTED_SOCIAL_IMAGE_COUNT ||
	new Set(manifest.articles.map((article) => article.slug)).size !==
		EXPECTED_SOCIAL_IMAGE_COUNT
) {
	throw new Error(
		`Social images require exactly ${EXPECTED_SOCIAL_IMAGE_COUNT} unique manifest articles`,
	);
}

export const getStaticPaths = (() =>
	manifest.articles.map((article) => ({
		params: { slug: article.slug },
		props: { imagePath: article.paths.image, slug: article.slug },
	}))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => {
	const imagePath = String(props.imagePath);
	const slug = String(props.slug);
	const expectedPath = `src/content/posts/${slug}/hero-original.png`;
	if (imagePath !== expectedPath) {
		throw new Error(
			`Manifest social-image path mismatch for ${slug}: ${imagePath}`,
		);
	}

	const absoluteImagePath = path.resolve(repositoryRoot, imagePath);
	const contentRoot = path.resolve(repositoryRoot, "src/content/posts");
	if (!absoluteImagePath.startsWith(`${contentRoot}${path.sep}`)) {
		throw new Error(`Social-image path escapes the content root: ${imagePath}`);
	}

	const jpeg = await sharp(absoluteImagePath)
		.resize(SOCIAL_IMAGE_MAX_WIDTH, SOCIAL_IMAGE_MAX_WIDTH, {
			fit: "contain",
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
