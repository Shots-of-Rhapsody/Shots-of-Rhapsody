function joinUrl(...parts: string[]): string {
	const joined = parts.join("/");
	return joined.replace(/\/+/g, "/");
}

export function getPostUrlBySlug(slug: string): string {
	return url(`/posts/${slug}/`);
}

export function getSiteRootUrl(site: URL): URL {
	return new URL(url("/"), site);
}

export function getAbsolutePostUrlBySlug(slug: string, site: URL): URL {
	return new URL(getPostUrlBySlug(slug), site);
}

export function getRssUrl(site: URL): URL {
	return new URL(url("/rss.xml"), site);
}

export function getTagUrl(tag: string): string {
	if (!tag) return url("/archive/");
	return url(`/archive/?tag=${encodeURIComponent(tag.trim())}`);
}

export function getCategoryUrl(category: string | null): string {
	if (
		!category ||
		category.trim() === "" ||
		category.trim().toLowerCase() === "uncategorized"
	)
		return url("/archive/?uncategorized=true");
	return url(`/archive/?category=${encodeURIComponent(category.trim())}`);
}

export function url(path: string) {
	return joinUrl("", import.meta.env.BASE_URL, path);
}
