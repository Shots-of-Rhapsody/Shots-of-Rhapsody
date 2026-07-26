import { SOCIAL_IMAGE_MAX_WIDTH } from "./image-policy";
import { url } from "./url-utils";

export interface SocialImage {
	url: string;
	mimeType: "image/jpeg";
	width: number;
	height: number;
}

export function isExternalImage(src: string): boolean {
	return /^(?:https?:|data:)/i.test(src);
}

export function isPublicImage(src: string): boolean {
	return src.startsWith("/");
}

export function withBasePath(src: string): string {
	const basePath = import.meta.env.BASE_URL;
	if (src === basePath || src.startsWith(`${basePath.replace(/\/$/, "")}/`)) {
		return src;
	}
	return url(src);
}

export function getSocialImage(slug: string, site: URL): SocialImage {
	return {
		url: new URL(url(`/social/${slug}.jpg`), site).toString(),
		mimeType: "image/jpeg",
		width: SOCIAL_IMAGE_MAX_WIDTH,
		height: SOCIAL_IMAGE_MAX_WIDTH,
	};
}
