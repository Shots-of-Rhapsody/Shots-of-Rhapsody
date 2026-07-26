import {
	assertOnlyKeys,
	assertPlainObject,
	assertSha256,
	assertSlug,
	MediumContractError,
} from "./contract.js";

export function buildPendingMediumReviewScaffold(manifestValue) {
	const manifest = assertPlainObject(manifestValue, "Medium manifest");
	assertOnlyKeys(
		manifest,
		new Set([
			"schemaVersion",
			"state",
			"authority",
			"author",
			"inventoryPath",
			"inventorySha256",
			"presentationSetVersion",
			"presentationSetSha256",
			"articles",
			"bySlug",
		]),
		"Medium manifest",
	);
	if (manifest.state !== "active" || !Array.isArray(manifest.articles)) {
		throw new MediumContractError(
			"Pending Medium review scaffolds require an active imported manifest",
		);
	}
	const articles = manifest.articles.map((article, index) => {
		const label = `Medium manifest articles[${index}]`;
		const slug = assertSlug(article.slug, `${label}.slug`);
		if (!Array.isArray(article.assets) || article.assets.length === 0) {
			throw new MediumContractError(`${label}.assets must not be empty`);
		}
		const assetSha256 = article.assets
			.map((asset, assetIndex) =>
				assertSha256(asset.sha256, `${label}.assets[${assetIndex}].sha256`),
			)
			.sort();
		if (new Set(assetSha256).size !== assetSha256.length) {
			throw new MediumContractError(`${label}.assets repeat a hash`);
		}
		const sourceSha256 = assertSha256(
			article.hashes?.rawSource,
			`${label}.hashes.rawSource`,
		);
		const outputSha256 = assertSha256(
			article.hashes?.markdown,
			`${label}.hashes.markdown`,
		);
		return {
			slug,
			sourceSha256,
			outputSha256,
			assetSha256,
			claimReview: {
				reviewer: null,
				reviewedAt: null,
				outcome: "pending",
				notes: "",
				claims: [],
				noMaterialClaimsRationale: null,
			},
			contentSignoff: {
				kind: "writing",
				reviewer: null,
				reviewedAt: null,
				accuracy: "pending",
				rights: "pending",
			},
		};
	});
	if (
		new Set(articles.map((article) => article.slug)).size !== articles.length
	) {
		throw new MediumContractError(
			"Pending Medium review scaffolds repeat a slug",
		);
	}
	return {
		schemaVersion: 1,
		state: "pending-human-review",
		inventorySha256: assertSha256(
			manifest.inventorySha256,
			"Medium manifest inventorySha256",
		),
		presentationSetSha256: assertSha256(
			manifest.presentationSetSha256,
			"Medium manifest presentationSetSha256",
		),
		articleCount: articles.length,
		articles,
	};
}
