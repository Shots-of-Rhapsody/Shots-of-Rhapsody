function slugifyPathSegment(segment: string): string {
	return segment
		.normalize("NFKD")
		.replace(/\p{Mark}/gu, "")
		.toLocaleLowerCase("en-US")
		.replace(/[’']/g, "")
		.replace(/[^\p{Letter}\p{Number}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Preserve Fuwari's historical routes while using Astro's Content Layer API.
 * Directory index files map to the directory name and an explicit frontmatter
 * slug wins unchanged (apart from surrounding whitespace and slashes).
 */
export function generateContentId(
	entry: string,
	data: Record<string, unknown>,
): string {
	const explicitSlug =
		typeof data.slug === "string"
			? data.slug.trim().replace(/^\/+|\/+$/g, "")
			: "";
	if (explicitSlug) return explicitSlug;

	const entryPath = entry
		.replace(/\\/g, "/")
		.replace(/\.(?:md|mdx)$/i, "")
		.replace(/\/index$/i, "");
	const id = entryPath
		.split("/")
		.filter(Boolean)
		.map(slugifyPathSegment)
		.filter(Boolean)
		.join("/");
	if (!id) throw new Error(`Unable to generate a content ID for ${entry}`);
	return id;
}
