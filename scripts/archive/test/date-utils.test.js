import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatDateToYYYYMMDD } from "../../../src/utils/date-utils.ts";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);
const manifest = JSON.parse(
	readFileSync(
		path.join(repositoryRoot, "provenance/tai-song/manifest.json"),
		"utf8",
	),
);
const articles = manifest.articles.map((article) => ({
	slug: article.slug,
	published: JSON.parse(
		readFileSync(path.join(repositoryRoot, article.paths.snapshot), "utf8"),
	).published,
}));

test("all eleven publication dates are invariant in UTC and Pacific time", () => {
	assert.equal(articles.length, 11);
	assert.equal(new Set(articles.map(({ slug }) => slug)).size, 11);

	const originalTimeZone = process.env.TZ;
	try {
		for (const timeZone of ["UTC", "America/Los_Angeles"]) {
			process.env.TZ = timeZone;
			for (const article of articles) {
				const published = new Date(article.published);
				const dateOnly = formatDateToYYYYMMDD(published);
				assert.equal(
					published.toISOString(),
					article.published,
					`${article.slug} must retain its source instant in ${timeZone}`,
				);
				assert.equal(
					dateOnly,
					article.published.slice(0, 10),
					`${article.slug} must retain its UTC date in ${timeZone}`,
				);
				assert.equal(dateOnly.slice(5), article.published.slice(5, 10));
				assert.equal(
					Number.parseInt(dateOnly.slice(0, 4), 10),
					Number.parseInt(article.published.slice(0, 4), 10),
				);
			}
		}
	} finally {
		if (originalTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = originalTimeZone;
	}
});

test("UTC year grouping does not cross the Pacific year boundary", () => {
	const originalTimeZone = process.env.TZ;
	try {
		process.env.TZ = "America/Los_Angeles";
		const boundary = new Date("2025-01-01T00:30:00.000Z");
		assert.equal(boundary.getFullYear(), 2024);
		const dateOnly = formatDateToYYYYMMDD(boundary);
		assert.equal(dateOnly, "2025-01-01");
		assert.equal(Number.parseInt(dateOnly.slice(0, 4), 10), 2025);
	} finally {
		if (originalTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = originalTimeZone;
	}
});
