const localPort = Number(process.env.PLAYWRIGHT_PORT ?? 4387);
const localBaseURL = `http://127.0.0.1:${localPort}/Shots-of-Rhapsody/`;

function normalizeBaseURL(value: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("PLAYWRIGHT_BASE_URL must be an absolute URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("PLAYWRIGHT_BASE_URL must use HTTP or HTTPS");
	}
	url.hash = "";
	url.search = "";
	url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
	return url.toString();
}

export const hasExternalPlaywrightBaseURL = Boolean(
	process.env.PLAYWRIGHT_BASE_URL?.trim(),
);
export const playwrightBaseURL = normalizeBaseURL(
	process.env.PLAYWRIGHT_BASE_URL?.trim() || localBaseURL,
);
const normalizedPlaywrightBase = new URL(playwrightBaseURL);
export const playwrightOrigin = normalizedPlaywrightBase.origin;
export const playwrightBasePathname = normalizedPlaywrightBase.pathname;
export const playwrightPort = localPort;
