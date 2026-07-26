import { IS_PUBLIC_REVIEW } from "../data/build-mode.ts";

export const CARD_IMAGE_WIDTHS = IS_PUBLIC_REVIEW
	? ([320, 640] as const)
	: ([320, 480, 640] as const);
export const HERO_IMAGE_WIDTHS = IS_PUBLIC_REVIEW
	? ([640, 1280] as const)
	: ([640, 960, 1280, 1600, 2048] as const);

export const CARD_IMAGE_SIZES =
	"(max-width: 671px) calc(100vw - 2rem), (max-width: 1216px) 22vw, 17rem";
export const FEATURED_IMAGE_SIZES =
	"(max-width: 767px) calc(100vw - 2rem), (max-width: 991px) calc(50vw - 1.5rem), (max-width: 1280px) calc((100vw - 4rem) / 3), 25rem";
export const CONTINUATION_IMAGE_SIZES =
	"(max-width: 671px) calc(100vw - 2rem), (max-width: 1216px) 38vw, 29rem";
export const HERO_IMAGE_SIZES =
	"(max-width: 767px) calc(100vw - 5rem), (max-width: 1280px) calc(100vw - 8rem), 71rem";

export const DISPLAY_IMAGE_QUALITY = 40;
export const SOCIAL_IMAGE_QUALITY = IS_PUBLIC_REVIEW ? 50 : 65;
export const SOCIAL_IMAGE_MAX_WIDTH = 1200;

export const MAX_DIST_BYTES = 15 * 1024 * 1024;
export const MAX_CARD_IMAGE_BYTES = 200 * 1024;
export const MAX_SOCIAL_IMAGE_BYTES = 500 * 1024;

export type ResponsiveImageVariant =
	| "card"
	| "featured"
	| "hero"
	| "continuation";

export function responsiveImageWidths(
	variant: ResponsiveImageVariant,
): number[] {
	return variant === "hero" ? [...HERO_IMAGE_WIDTHS] : [...CARD_IMAGE_WIDTHS];
}

export function responsiveImageSizes(variant: ResponsiveImageVariant): string {
	switch (variant) {
		case "hero":
			return HERO_IMAGE_SIZES;
		case "featured":
			return FEATURED_IMAGE_SIZES;
		case "continuation":
			return CONTINUATION_IMAGE_SIZES;
		default:
			return CARD_IMAGE_SIZES;
	}
}
