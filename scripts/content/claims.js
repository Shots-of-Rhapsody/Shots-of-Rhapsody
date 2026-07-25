import {
	assertCanonicalUtc,
	assertHttpsUrl,
	assertOnlyKeys,
	assertPlainObject,
	assertSha256,
	assertSlug,
	assertString,
	MediumContractError,
} from "../medium/lib/contract.js";

const CLAIM_STATUSES = new Set([
	"supported",
	"qualified",
	"outdated",
	"unsupported",
]);

export function validateClaimReviews(value) {
	const root = assertPlainObject(value, "claim reviews");
	assertOnlyKeys(root, new Set(["version", "articles"]), "claim reviews");
	if (root.version !== 1)
		throw new MediumContractError("claim reviews version must equal 1");
	if (!Array.isArray(root.articles))
		throw new MediumContractError("claim reviews articles must be an array");

	const articles = root.articles.map((value, articleIndex) => {
		const label = `claim reviews articles[${articleIndex}]`;
		const article = assertPlainObject(value, label);
		assertOnlyKeys(
			article,
			new Set([
				"slug",
				"sourceSha256",
				"outputSha256",
				"reviewer",
				"reviewedAt",
				"outcome",
				"notes",
				"claims",
			]),
			label,
		);
		if (article.reviewer !== "Tai Song" || article.outcome !== "passed")
			throw new MediumContractError(`${label} lacks a passed Tai Song review`);
		if (!Array.isArray(article.claims))
			throw new MediumContractError(`${label}.claims must be an array`);
		const claims = article.claims.map((value, claimIndex) => {
			const claimLabel = `${label}.claims[${claimIndex}]`;
			const claim = assertPlainObject(value, claimLabel);
			assertOnlyKeys(
				claim,
				new Set([
					"id",
					"statementSha256",
					"material",
					"status",
					"sources",
					"notes",
				]),
				claimLabel,
			);
			if (typeof claim.material !== "boolean")
				throw new MediumContractError(`${claimLabel}.material must be boolean`);
			if (!CLAIM_STATUSES.has(claim.status))
				throw new MediumContractError(`${claimLabel}.status is unsupported`);
			if (!Array.isArray(claim.sources))
				throw new MediumContractError(`${claimLabel}.sources must be an array`);
			const sources = claim.sources.map((source, sourceIndex) =>
				assertHttpsUrl(
					source,
					`${claimLabel}.sources[${sourceIndex}]`,
				).toString(),
			);
			if (
				claim.material &&
				(claim.status === "outdated" || claim.status === "unsupported")
			) {
				throw new MediumContractError(
					`${claimLabel} contains an unresolved material claim`,
				);
			}
			if (
				(claim.status === "supported" || claim.status === "qualified") &&
				sources.length === 0
			) {
				throw new MediumContractError(
					`${claimLabel} requires at least one supporting source`,
				);
			}
			return {
				id: assertSlug(claim.id, `${claimLabel}.id`),
				statementSha256: assertSha256(
					claim.statementSha256,
					`${claimLabel}.statementSha256`,
				),
				material: claim.material,
				status: claim.status,
				sources,
				notes: assertString(claim.notes, `${claimLabel}.notes`),
			};
		});
		const claimIds = claims.map((claim) => claim.id);
		if (new Set(claimIds).size !== claimIds.length)
			throw new MediumContractError(`${label} repeats a claim id`);
		return {
			slug: assertSlug(article.slug, `${label}.slug`),
			sourceSha256: assertSha256(article.sourceSha256, `${label}.sourceSha256`),
			outputSha256: assertSha256(article.outputSha256, `${label}.outputSha256`),
			reviewer: "Tai Song",
			reviewedAt: assertCanonicalUtc(article.reviewedAt, `${label}.reviewedAt`),
			outcome: "passed",
			notes: assertString(article.notes, `${label}.notes`),
			claims,
		};
	});
	const slugs = articles.map((article) => article.slug);
	if (new Set(slugs).size !== slugs.length)
		throw new MediumContractError("claim reviews repeat an article slug");
	return articles;
}
