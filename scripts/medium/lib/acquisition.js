import {
	MEDIUM_EXPORT_CANDIDATE_COUNT,
	MEDIUM_RELEASE_ESSAY_COUNT,
	parseApprovedMediumTitleFile,
} from "./assets.js";
import {
	assertCanonicalUtc,
	assertHttpsUrl,
	assertInteger,
	assertNonEmptyString,
	assertOnlyKeys,
	assertPlainObject,
	assertSha256,
	assertSlug,
	getMediumPaths,
	MEDIUM_HERO_CAPTURE_FILE,
	MEDIUM_HERO_MAX_LEDGER_BYTES,
	MEDIUM_HERO_MAX_OUTPUT_BYTES,
	MEDIUM_HERO_MAX_SOURCE_BYTES,
	MediumContractError,
	serializeJson,
} from "./contract.js";
import { readBoundedRegularFileInside } from "./fs-safety.js";
import { sha256 } from "./integrity.js";

const ACQUISITION_METHOD = "logged-in Medium article page via pageAssets";
const CAPTURE_KIND = "highest-observed-medium-responsive-derivative";
const CAPTURE_POLICY = Object.freeze({
	rawCaptureUse: "ignored-verification-evidence-only",
	websiteInput: "sanitized-copy-only",
	highestObservedResponsiveCandidate: "resize:fit:4800/format:webp",
	viewportCssPixels: Object.freeze({ width: 4800, height: 3000 }),
	claim:
		"These are the highest responsive bytes observed on each article page, not claimed to be the original upload bytes.",
});

function parseCanonicalJson(buffer, label, { indentation = "  " } = {}) {
	let value;
	try {
		value = JSON.parse(buffer.toString("utf8"));
	} catch (error) {
		throw new MediumContractError(`${label} is not valid UTF-8 JSON`, {
			cause: error,
		});
	}
	const canonical =
		indentation === "  "
			? serializeJson(value)
			: `${JSON.stringify(value, null, indentation)}\n`;
	if (!buffer.equals(Buffer.from(canonical, "utf8"))) {
		throw new MediumContractError(
			`${label} must use canonical JSON formatting`,
		);
	}
	return value;
}

function boundedPositiveInteger(value, label, maximum) {
	const integer = assertInteger(value, label, { positive: true });
	if (integer > maximum) {
		throw new MediumContractError(`${label} exceeds ${maximum}`);
	}
	return integer;
}

function validateImageRecord(value, label, { maximumBytes }) {
	const image = assertPlainObject(value, label);
	assertOnlyKeys(
		image,
		new Set(["sha256", "mimeType", "byteSize", "width", "height"]),
		label,
	);
	if (image.mimeType !== "image/webp") {
		throw new MediumContractError(`${label}.mimeType must equal image/webp`);
	}
	const width = boundedPositiveInteger(image.width, `${label}.width`, 100_000);
	const height = boundedPositiveInteger(
		image.height,
		`${label}.height`,
		100_000,
	);
	if (width * height > 100_000_000) {
		throw new MediumContractError(`${label} exceeds the decoded-pixel limit`);
	}
	return {
		sha256: assertSha256(image.sha256, `${label}.sha256`),
		mimeType: "image/webp",
		byteSize: boundedPositiveInteger(
			image.byteSize,
			`${label}.byteSize`,
			maximumBytes,
		),
		width,
		height,
	};
}

function validatePixelRecord(value, label) {
	const pixels = assertPlainObject(value, label);
	assertOnlyKeys(
		pixels,
		new Set(["sha256", "colourspace", "channels", "depth"]),
		label,
	);
	if (
		pixels.colourspace !== "srgb" ||
		pixels.channels !== 4 ||
		pixels.depth !== "uchar"
	) {
		throw new MediumContractError(
			`${label} must identify decoded sRGB RGBA uchar pixels`,
		);
	}
	return {
		sha256: assertSha256(pixels.sha256, `${label}.sha256`),
		colourspace: "srgb",
		channels: 4,
		depth: "uchar",
	};
}

function expectedCanonicalUrl(slug, storyId) {
	return `https://medium.com/@ShotsOfRhapsody/${slug}-${storyId}`;
}

function expectedObservedUrl(heroImageId) {
	return `https://miro.medium.com/v2/resize:fit:4800/format:webp/${heroImageId}`;
}

function validateIdentityFields(value, label, title) {
	const slug = assertSlug(value.slug, `${label}.slug`);
	if (value.title !== title) {
		throw new MediumContractError(
			`${label}.title differs from the approved order`,
		);
	}
	if (
		typeof value.storyId !== "string" ||
		!/^[0-9a-f]{12}$/u.test(value.storyId)
	) {
		throw new MediumContractError(
			`${label}.storyId must be 12 lowercase hex digits`,
		);
	}
	const heroImageId = assertNonEmptyString(
		value.heroImageId,
		`${label}.heroImageId`,
	);
	if (!/^1\*[A-Za-z0-9_-]+@2x\.(?:jpe?g|png|webp)$/u.test(heroImageId)) {
		throw new MediumContractError(`${label}.heroImageId has an unsafe shape`);
	}
	const canonicalUrl = assertHttpsUrl(
		value.canonicalUrl,
		`${label}.canonicalUrl`,
		{ hostname: "medium.com" },
	).toString();
	if (canonicalUrl !== expectedCanonicalUrl(slug, value.storyId)) {
		throw new MediumContractError(
			`${label}.canonicalUrl does not bind its slug and story ID`,
		);
	}
	const observedUrl = assertHttpsUrl(
		value.observedUrl,
		`${label}.observedUrl`,
		{ hostname: "miro.medium.com" },
	).toString();
	if (observedUrl !== expectedObservedUrl(heroImageId)) {
		throw new MediumContractError(
			`${label}.observedUrl does not bind the fixed responsive candidate and hero image ID`,
		);
	}
	return {
		slug,
		title,
		storyId: value.storyId,
		heroImageId,
		canonicalUrl,
		observedUrl,
	};
}

function assertUniqueItems(items) {
	for (const field of [
		"slug",
		"storyId",
		"heroImageId",
		"canonicalUrl",
		"observedUrl",
	]) {
		const values = items.map((item) => item[field]);
		if (new Set(values).size !== values.length) {
			throw new MediumContractError(
				`Medium hero asset ledger repeats ${field}`,
			);
		}
	}
}

export function validateMediumHeroAssetLedger(value, approvedAllowlist) {
	const allowlist = parseApprovedMediumTitleFile(
		serializeJson(approvedAllowlist),
		{
			expectedCount: MEDIUM_RELEASE_ESSAY_COUNT,
			expectedCandidateCount: MEDIUM_EXPORT_CANDIDATE_COUNT,
		},
	);
	const ledger = assertPlainObject(value, "Medium hero asset ledger");
	assertOnlyKeys(
		ledger,
		new Set([
			"schemaVersion",
			"state",
			"captureKind",
			"originalUploadClaimed",
			"acquisitionManifestSha256",
			"exportSha256",
			"candidateSetSha256",
			"itemCount",
			"items",
		]),
		"Medium hero asset ledger",
	);
	if (
		ledger.schemaVersion !== 1 ||
		ledger.state !== "captured-site-ready" ||
		ledger.captureKind !== CAPTURE_KIND ||
		ledger.originalUploadClaimed !== false
	) {
		throw new MediumContractError(
			"Medium hero asset ledger state or capture policy is invalid",
		);
	}
	if (
		ledger.exportSha256 !== allowlist.exportSha256 ||
		ledger.candidateSetSha256 !== allowlist.candidateSetSha256
	) {
		throw new MediumContractError(
			"Medium hero asset ledger differs from the approved export binding",
		);
	}
	if (
		ledger.itemCount !== allowlist.expectedCount ||
		!Array.isArray(ledger.items) ||
		ledger.items.length !== allowlist.expectedCount
	) {
		throw new MediumContractError(
			`Medium hero asset ledger must contain exactly ${allowlist.expectedCount} items`,
		);
	}
	const items = ledger.items.map((itemValue, index) => {
		const label = `Medium hero asset ledger items[${index}]`;
		const item = assertPlainObject(itemValue, label);
		assertOnlyKeys(
			item,
			new Set([
				"slug",
				"title",
				"storyId",
				"heroImageId",
				"canonicalUrl",
				"observedUrl",
				"capture",
				"siteReady",
				"pixels",
			]),
			label,
		);
		const identity = validateIdentityFields(
			item,
			label,
			allowlist.titles[index],
		);
		const capture = validateImageRecord(item.capture, `${label}.capture`, {
			maximumBytes: MEDIUM_HERO_MAX_SOURCE_BYTES,
		});
		const siteReady = validateImageRecord(
			item.siteReady,
			`${label}.siteReady`,
			{ maximumBytes: MEDIUM_HERO_MAX_OUTPUT_BYTES },
		);
		if (
			capture.width !== siteReady.width ||
			capture.height !== siteReady.height
		) {
			throw new MediumContractError(
				`${label} capture and site-ready dimensions differ`,
			);
		}
		return {
			...identity,
			capture,
			siteReady,
			pixels: validatePixelRecord(item.pixels, `${label}.pixels`),
		};
	});
	assertUniqueItems(items);
	return {
		schemaVersion: 1,
		state: "captured-site-ready",
		captureKind: CAPTURE_KIND,
		originalUploadClaimed: false,
		acquisitionManifestSha256: assertSha256(
			ledger.acquisitionManifestSha256,
			"Medium hero asset ledger acquisitionManifestSha256",
		),
		exportSha256: allowlist.exportSha256,
		candidateSetSha256: allowlist.candidateSetSha256,
		itemCount: items.length,
		items,
		bySlug: new Map(items.map((item) => [item.slug, item])),
	};
}

function validateCapturePolicy(value) {
	const policy = assertPlainObject(
		value,
		"Medium hero acquisition capturePolicy",
	);
	assertOnlyKeys(
		policy,
		new Set([
			"rawCaptureUse",
			"websiteInput",
			"highestObservedResponsiveCandidate",
			"viewportCssPixels",
			"claim",
		]),
		"Medium hero acquisition capturePolicy",
	);
	const viewport = assertPlainObject(
		policy.viewportCssPixels,
		"Medium hero acquisition viewportCssPixels",
	);
	assertOnlyKeys(
		viewport,
		new Set(["width", "height"]),
		"Medium hero acquisition viewportCssPixels",
	);
	if (
		policy.rawCaptureUse !== CAPTURE_POLICY.rawCaptureUse ||
		policy.websiteInput !== CAPTURE_POLICY.websiteInput ||
		policy.highestObservedResponsiveCandidate !==
			CAPTURE_POLICY.highestObservedResponsiveCandidate ||
		policy.claim !== CAPTURE_POLICY.claim ||
		viewport.width !== CAPTURE_POLICY.viewportCssPixels.width ||
		viewport.height !== CAPTURE_POLICY.viewportCssPixels.height
	) {
		throw new MediumContractError(
			"Medium hero acquisition capturePolicy differs from the reviewed capture contract",
		);
	}
}

export function validateMediumHeroAcquisition(
	value,
	{ assetLedger, acquisitionManifestSha256 } = {},
) {
	const acquisition = assertPlainObject(
		value,
		"Medium hero acquisition ledger",
	);
	assertOnlyKeys(
		acquisition,
		new Set([
			"schemaVersion",
			"state",
			"captureMethod",
			"capturePolicy",
			"export",
			"itemCount",
			"items",
		]),
		"Medium hero acquisition ledger",
	);
	if (
		acquisition.schemaVersion !== 1 ||
		acquisition.state !== "captured-unreviewed" ||
		acquisition.captureMethod !== ACQUISITION_METHOD
	) {
		throw new MediumContractError(
			"Medium hero acquisition ledger state or method is invalid",
		);
	}
	validateCapturePolicy(acquisition.capturePolicy);
	const exportRecord = assertPlainObject(
		acquisition.export,
		"Medium hero acquisition export",
	);
	assertOnlyKeys(
		exportRecord,
		new Set(["sha256", "candidateSetSha256"]),
		"Medium hero acquisition export",
	);
	if (
		exportRecord.sha256 !== assetLedger.exportSha256 ||
		exportRecord.candidateSetSha256 !== assetLedger.candidateSetSha256
	) {
		throw new MediumContractError(
			"Medium hero acquisition export hashes differ from the durable asset ledger",
		);
	}
	if (acquisitionManifestSha256 !== assetLedger.acquisitionManifestSha256) {
		throw new MediumContractError(
			"Medium hero acquisition manifest SHA-256 differs from the durable asset ledger",
		);
	}
	if (
		acquisition.itemCount !== assetLedger.itemCount ||
		!Array.isArray(acquisition.items) ||
		acquisition.items.length !== assetLedger.itemCount
	) {
		throw new MediumContractError(
			`Medium hero acquisition ledger must contain exactly ${assetLedger.itemCount} items`,
		);
	}
	const items = acquisition.items.map((itemValue, index) => {
		const label = `Medium hero acquisition items[${index}]`;
		const item = assertPlainObject(itemValue, label);
		assertOnlyKeys(
			item,
			new Set([
				"slug",
				"storyId",
				"approvedExportTitle",
				"currentMediumTitle",
				"canonicalUrl",
				"heroImageId",
				"observedUrl",
				"contentType",
				"width",
				"height",
				"byteSize",
				"sha256",
				"localPath",
				"capturedAt",
			]),
			label,
		);
		const expected = assetLedger.items[index];
		const identity = validateIdentityFields(
			{
				...item,
				title: item.approvedExportTitle,
			},
			label,
			expected.title,
		);
		assertNonEmptyString(
			item.currentMediumTitle,
			`${label}.currentMediumTitle`,
		);
		assertCanonicalUtc(item.capturedAt, `${label}.capturedAt`);
		const expectedLocalPath = `.medium-import/raw/assets/${expected.slug}/${MEDIUM_HERO_CAPTURE_FILE}`;
		if (
			identity.slug !== expected.slug ||
			identity.storyId !== expected.storyId ||
			identity.heroImageId !== expected.heroImageId ||
			identity.canonicalUrl !== expected.canonicalUrl ||
			identity.observedUrl !== expected.observedUrl ||
			item.contentType !== expected.capture.mimeType ||
			item.width !== expected.capture.width ||
			item.height !== expected.capture.height ||
			item.byteSize !== expected.capture.byteSize ||
			item.sha256 !== expected.capture.sha256 ||
			item.localPath !== expectedLocalPath
		) {
			throw new MediumContractError(
				`${label} differs from its durable identity, path, or capture evidence`,
			);
		}
		return {
			...item,
			canonicalUrl: identity.canonicalUrl,
			observedUrl: identity.observedUrl,
		};
	});
	for (const field of [
		"slug",
		"storyId",
		"heroImageId",
		"canonicalUrl",
		"observedUrl",
		"localPath",
	]) {
		const values = items.map((item) => item[field]);
		if (new Set(values).size !== values.length) {
			throw new MediumContractError(
				`Medium hero acquisition ledger repeats ${field}`,
			);
		}
	}
	return {
		...acquisition,
		export: { ...exportRecord },
		items,
		bySlug: new Map(items.map((item) => [item.slug, item])),
	};
}

async function loadApprovedAllowlist(repoRoot) {
	const paths = getMediumPaths(repoRoot);
	const buffer = await readBoundedRegularFileInside({
		root: paths.root,
		filePath: paths.approvedTitlesPath,
		label: "Committed Medium title allowlist",
		maxBytes: 64 * 1024,
	});
	return parseApprovedMediumTitleFile(buffer.toString("utf8"));
}

export async function loadMediumHeroAssetLedger(repoRoot) {
	const paths = getMediumPaths(repoRoot);
	const [approvedAllowlist, buffer] = await Promise.all([
		loadApprovedAllowlist(repoRoot),
		readBoundedRegularFileInside({
			root: paths.root,
			filePath: paths.heroAssetLedgerPath,
			label: "Committed Medium hero asset ledger",
			maxBytes: MEDIUM_HERO_MAX_LEDGER_BYTES,
		}),
	]);
	const value = parseCanonicalJson(
		buffer,
		"Committed Medium hero asset ledger",
		{
			indentation: "\t",
		},
	);
	return {
		buffer,
		value,
		...validateMediumHeroAssetLedger(value, approvedAllowlist),
	};
}

export async function loadMediumHeroAcquisition(repoRoot) {
	const paths = getMediumPaths(repoRoot);
	const [assetLedger, buffer] = await Promise.all([
		loadMediumHeroAssetLedger(repoRoot),
		readBoundedRegularFileInside({
			root: paths.importRoot,
			filePath: paths.acquisitionResultsPath,
			label: "Ignored Medium hero acquisition ledger",
			maxBytes: MEDIUM_HERO_MAX_LEDGER_BYTES,
		}),
	]);
	const value = parseCanonicalJson(
		buffer,
		"Ignored Medium hero acquisition ledger",
	);
	const acquisitionManifestSha256 = sha256(buffer);
	return {
		assetLedger,
		buffer,
		value,
		acquisitionManifestSha256,
		...validateMediumHeroAcquisition(value, {
			assetLedger,
			acquisitionManifestSha256,
		}),
	};
}

export function mediumHeroBinding(loaded, slugValue) {
	const slug = assertSlug(slugValue);
	const asset = loaded.assetLedger.bySlug.get(slug);
	const acquisition = loaded.bySlug.get(slug);
	if (!asset || !acquisition) {
		throw new MediumContractError(
			`Medium hero acquisition has no approved binding for ${slug}`,
		);
	}
	return {
		acquisitionManifestSha256: loaded.acquisitionManifestSha256,
		exportSha256: loaded.assetLedger.exportSha256,
		candidateSetSha256: loaded.assetLedger.candidateSetSha256,
		asset,
		acquisition,
	};
}
