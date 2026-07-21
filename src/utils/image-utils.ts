import path from "node:path";
import type { ImageMetadata } from "astro";
import { url } from "./url-utils";

const localImageModules = import.meta.glob<ImageMetadata>(
	"../**/*.{avif,gif,jpeg,jpg,png,svg,webp}",
	{ import: "default" },
);

export function isExternalImage(src: string): boolean {
	return /^(?:https?:|data:)/i.test(src);
}

export function isPublicImage(src: string): boolean {
	return src.startsWith("/");
}

export function getLocalImageModulePath(src: string, basePath = "/"): string {
	return path.normalize(path.join("../", basePath, src)).replace(/\\/g, "/");
}

export async function loadLocalImage(
	src: string,
	basePath = "/",
): Promise<ImageMetadata> {
	const modulePath = getLocalImageModulePath(src, basePath);
	const loader = localImageModules[modulePath];
	if (!loader) {
		throw new Error(
			`Image file not found: ${modulePath.replace(/^\.\.\//, "src/")}`,
		);
	}
	return loader();
}

function withBasePath(src: string): string {
	const basePath = import.meta.env.BASE_URL;
	if (src === basePath || src.startsWith(`${basePath.replace(/\/$/, "")}/`)) {
		return src;
	}
	return url(src);
}

export async function getAbsoluteImageUrl(
	src: string,
	basePath: string,
	site: URL,
): Promise<string | undefined> {
	if (!src || src.startsWith("data:")) return undefined;
	if (/^https?:/i.test(src)) return src;
	if (isPublicImage(src)) return new URL(withBasePath(src), site).toString();

	const image = await loadLocalImage(src, basePath);
	return new URL(withBasePath(image.src), site).toString();
}
