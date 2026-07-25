import {
	assertCanonicalUtc,
	assertNonEmptyString,
	assertOnlyKeys,
	assertPlainObject,
	assertSha256,
	assertSlug,
	MediumContractError,
} from "../medium/lib/contract.js";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export function validateContentSignoffsV2(value) {
	const root = assertPlainObject(value, "content signoffs");
	assertOnlyKeys(root, new Set(["version", "entries"]), "content signoffs");
	if (root.version !== 2)
		throw new MediumContractError("content signoffs version must equal 2");
	if (!Array.isArray(root.entries))
		throw new MediumContractError("content signoffs entries must be an array");

	const entries = root.entries.map((value, index) => {
		const label = `content signoffs entries[${index}]`;
		const entry = assertPlainObject(value, label);
		assertOnlyKeys(
			entry,
			new Set([
				"slug",
				"kind",
				"sourceSha256",
				"outputSha256",
				"assetSha256",
				"reviewer",
				"reviewedAt",
				"accuracy",
				"rights",
			]),
			label,
		);
		if (entry.kind !== "writing" && entry.kind !== "podcast")
			throw new MediumContractError(`${label}.kind is unsupported`);
		if (!Array.isArray(entry.assetSha256) || entry.assetSha256.length === 0)
			throw new MediumContractError(`${label}.assetSha256 must not be empty`);
		if (new Set(entry.assetSha256).size !== entry.assetSha256.length)
			throw new MediumContractError(
				`${label}.assetSha256 must contain unique digests`,
			);
		if (
			entry.reviewer !== "Tai Song" ||
			entry.accuracy !== "passed" ||
			entry.rights !== "passed"
		) {
			throw new MediumContractError(
				`${label} lacks genuine passed review evidence`,
			);
		}
		return {
			slug: assertSlug(entry.slug, `${label}.slug`),
			kind: entry.kind,
			sourceSha256: assertSha256(entry.sourceSha256, `${label}.sourceSha256`),
			outputSha256: assertSha256(entry.outputSha256, `${label}.outputSha256`),
			assetSha256: entry.assetSha256.map((digest, assetIndex) =>
				assertSha256(digest, `${label}.assetSha256[${assetIndex}]`),
			),
			reviewer: "Tai Song",
			reviewedAt: assertCanonicalUtc(entry.reviewedAt, `${label}.reviewedAt`),
			accuracy: "passed",
			rights: "passed",
		};
	});
	const identities = entries.map((entry) => `${entry.kind}:${entry.slug}`);
	if (new Set(identities).size !== identities.length)
		throw new MediumContractError("content signoffs repeat a work identity");
	return entries;
}

export function validatePresentationSignoffsV2(value) {
	const root = assertPlainObject(value, "presentation signoffs");
	assertOnlyKeys(
		root,
		new Set(["version", "releases"]),
		"presentation signoffs",
	);
	if (root.version !== 2)
		throw new MediumContractError("presentation signoffs version must equal 2");
	if (!Array.isArray(root.releases))
		throw new MediumContractError(
			"presentation signoffs releases must be an array",
		);
	const releases = root.releases.map((value, index) => {
		const label = `presentation signoffs releases[${index}]`;
		const release = assertPlainObject(value, label);
		assertOnlyKeys(
			release,
			new Set([
				"release",
				"reviewedCommit",
				"rendererSha256",
				"siteSha256",
				"reviewer",
				"reviewedAt",
				"responsive",
				"accessibility",
			]),
			label,
		);
		if (
			release.reviewer !== "Tai Song" ||
			release.responsive !== "passed" ||
			release.accessibility !== "passed"
		) {
			throw new MediumContractError(
				`${label} lacks genuine passed review evidence`,
			);
		}
		const reviewedCommit = assertNonEmptyString(
			release.reviewedCommit,
			`${label}.reviewedCommit`,
		);
		if (!COMMIT_PATTERN.test(reviewedCommit))
			throw new MediumContractError(
				`${label}.reviewedCommit must be a full commit SHA`,
			);
		return {
			release: assertNonEmptyString(release.release, `${label}.release`),
			reviewedCommit,
			rendererSha256: assertSha256(
				release.rendererSha256,
				`${label}.rendererSha256`,
			),
			siteSha256: assertSha256(release.siteSha256, `${label}.siteSha256`),
			reviewer: "Tai Song",
			reviewedAt: assertCanonicalUtc(release.reviewedAt, `${label}.reviewedAt`),
			responsive: "passed",
			accessibility: "passed",
		};
	});
	const names = releases.map((release) => release.release);
	if (new Set(names).size !== names.length)
		throw new MediumContractError("presentation signoffs repeat a release");
	return releases;
}

export function requirePresentationSignoffV2(value, expected) {
	const releases = validatePresentationSignoffsV2(value);
	const release = releases.find(
		(record) => record.release === expected.release,
	);
	if (!release)
		throw new MediumContractError(
			`presentation signoffs are missing ${expected.release}`,
		);
	for (const field of ["reviewedCommit", "rendererSha256", "siteSha256"]) {
		if (release[field] !== expected[field])
			throw new MediumContractError(
				`presentation signoff ${expected.release} has stale ${field}`,
			);
	}
	return release;
}
