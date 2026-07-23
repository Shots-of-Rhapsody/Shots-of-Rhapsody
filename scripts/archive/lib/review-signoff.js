export const REVIEW_SIGNOFF_VERSION = 1;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PRIVATE_REFERENCE_PATTERNS = [
	/https?:\/\/[^\s"'<>]*proton[^\s"'<>]*/iu,
	/\.proton-import(?:[\\/]|\b)/iu,
	/(?:^|[\\/])raw[\\/][^\s"'<>]+/iu,
	/(?:file:\/\/|[a-z]:\\users\\)/iu,
];

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value, expectedKeys) {
	return (
		isPlainObject(value) &&
		Object.keys(value).length === expectedKeys.length &&
		expectedKeys.every((key) => Object.hasOwn(value, key))
	);
}

function containsPrivateReference(value) {
	if (typeof value === "string") {
		return PRIVATE_REFERENCE_PATTERNS.some((pattern) => pattern.test(value));
	}
	if (Array.isArray(value)) return value.some(containsPrivateReference);
	if (!isPlainObject(value)) return false;
	return Object.values(value).some(containsPrivateReference);
}

export function validateReviewSignoffs({ record, manifest, now = new Date() }) {
	const failures = [];
	if (!isPlainObject(record))
		return ["review signoff record must be an object"];
	if (!sameKeys(record, ["version", "articles"])) {
		failures.push("review signoff record has missing or unexpected fields");
	}
	if (record.version !== REVIEW_SIGNOFF_VERSION) {
		failures.push(
			`review signoff version must equal ${REVIEW_SIGNOFF_VERSION}`,
		);
	}
	if (containsPrivateReference(record)) {
		failures.push(
			"review signoff record contains a private or raw source path",
		);
	}

	const manifestArticles = Array.isArray(manifest?.articles)
		? manifest.articles
		: [];
	const expectedBySlug = new Map(
		manifestArticles.map((article) => [article.slug, article]),
	);
	if (!Array.isArray(record.articles)) {
		failures.push("review signoff articles must be an array");
		return failures;
	}
	if (record.articles.length !== manifestArticles.length) {
		failures.push(
			`human review has ${record.articles.length} signoffs but ${manifestArticles.length} manifest articles require review`,
		);
	}

	const articleKeys = [
		"slug",
		"snapshotSha256",
		"markdownSha256",
		"imageSha256",
		"reviewedCommit",
		"reviewer",
		"reviewedAt",
		"textAccuracy",
		"presentation",
		"notes",
	];
	const seen = new Set();
	const nowValue = now.valueOf();
	for (const [index, signoff] of record.articles.entries()) {
		const label = `review signoff ${index + 1}`;
		if (!sameKeys(signoff, articleKeys)) {
			failures.push(`${label} has missing or unexpected fields`);
			continue;
		}
		if (!SLUG_PATTERN.test(signoff.slug)) {
			failures.push(`${label} has an invalid slug`);
			continue;
		}
		if (seen.has(signoff.slug))
			failures.push(`${label} duplicates ${signoff.slug}`);
		seen.add(signoff.slug);
		const article = expectedBySlug.get(signoff.slug);
		if (!article) {
			failures.push(`${label} is not present in the manifest`);
			continue;
		}
		for (const [field, expected] of [
			["snapshotSha256", article.hashes?.snapshot],
			["markdownSha256", article.hashes?.markdown],
			["imageSha256", article.hashes?.image],
		]) {
			if (!SHA256_PATTERN.test(signoff[field]) || signoff[field] !== expected) {
				failures.push(`${label} ${field} differs from the manifest`);
			}
		}
		if (!COMMIT_PATTERN.test(signoff.reviewedCommit)) {
			failures.push(`${label} reviewedCommit must be a full lowercase Git SHA`);
		}
		if (signoff.reviewer !== "Tai Song") {
			failures.push(`${label} reviewer must be Tai Song`);
		}
		const reviewedAt = new Date(signoff.reviewedAt);
		if (
			typeof signoff.reviewedAt !== "string" ||
			Number.isNaN(reviewedAt.valueOf()) ||
			reviewedAt.toISOString() !== signoff.reviewedAt
		) {
			failures.push(`${label} reviewedAt must be a canonical UTC timestamp`);
		} else {
			if (reviewedAt.valueOf() > nowValue + 5 * 60 * 1000) {
				failures.push(`${label} is dated in the future`);
			}
		}
		if (signoff.textAccuracy !== "passed") {
			failures.push(`${label} textAccuracy is not passed`);
		}
		if (signoff.presentation !== "passed") {
			failures.push(`${label} presentation is not passed`);
		}
		if (typeof signoff.notes !== "string") {
			failures.push(`${label} notes must be a string`);
		}
	}
	for (const slug of expectedBySlug.keys()) {
		if (!seen.has(slug)) failures.push(`human review is missing ${slug}`);
	}
	return failures;
}

export function evaluateReviewSignoffs({
	record,
	manifest,
	requireSignoff = false,
	now = new Date(),
}) {
	const isPendingTemplate =
		sameKeys(record, ["version", "articles"]) &&
		record.version === REVIEW_SIGNOFF_VERSION &&
		Array.isArray(record.articles) &&
		record.articles.length === 0;
	const failures = validateReviewSignoffs({ record, manifest, now });

	if (isPendingTemplate && !requireSignoff) {
		return { status: "pending", failures: [] };
	}
	return {
		status: failures.length === 0 ? "complete" : "invalid",
		failures,
	};
}
