const INVALID_WINDOWS_NAME_RUN = /[<>:"/\\|?*]+/gu;
const WINDOWS_RESERVED_STEM =
	/^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;
const PROTON_PLACEHOLDER_EXTENSION = ".protondoc";
const MAX_WINDOWS_COMPONENT_UTF16_UNITS = 255;

export class ProtonNameError extends Error {
	constructor(message) {
		super(message);
		this.name = "ProtonNameError";
	}
}

export function hasControlOrBidi(value) {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			(codePoint >= 0 && codePoint <= 0x1f) ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			(codePoint >= 0x202a && codePoint <= 0x202e) ||
			(codePoint >= 0x2066 && codePoint <= 0x2069)
		) {
			return true;
		}
	}
	return false;
}

function assertString(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		throw new ProtonNameError(`${label} must be a non-empty string`);
	}
	return value;
}

export function assertMasterFolder(value, label = "masterFolder") {
	if (value !== "fiction" && value !== "nonfiction") {
		throw new ProtonNameError(`${label} must be fiction or nonfiction`);
	}
	return value;
}

function validateWindowsComponent(value, label) {
	if (value === "." || value === "..") {
		throw new ProtonNameError(`${label} cannot be a relative path marker`);
	}
	if (hasControlOrBidi(value)) {
		throw new ProtonNameError(`${label} contains a control character`);
	}
	if (WINDOWS_RESERVED_STEM.test(value)) {
		throw new ProtonNameError(`${label} uses a Windows-reserved name`);
	}
	if (
		value.length + PROTON_PLACEHOLDER_EXTENSION.length >
		MAX_WINDOWS_COMPONENT_UTF16_UNITS
	) {
		throw new ProtonNameError(
			`${label} is too long for a Windows Proton Docs placeholder`,
		);
	}
	return value;
}

export function windowsSafeCloudName(articleTitle) {
	const source = assertString(articleTitle, "articleTitle").normalize("NFC");
	if (hasControlOrBidi(source)) {
		throw new ProtonNameError("articleTitle contains a control character");
	}
	const cloudName = source
		.replace(INVALID_WINDOWS_NAME_RUN, " - ")
		.replace(/\s+/gu, " ")
		.trim()
		.replace(/(?:\s*-\s*){2,}/gu, " - ")
		.replace(/[ .-]+$/gu, "");
	if (cloudName.length === 0) {
		throw new ProtonNameError(
			"articleTitle has no Windows-compatible filename characters",
		);
	}
	return validateWindowsComponent(cloudName, "cloudName");
}

export function windowsNameKey(value) {
	const normalized = assertString(value, "cloudName")
		.normalize("NFC")
		.replace(/[ .]+$/gu, "");
	if (normalized.length === 0) {
		throw new ProtonNameError(
			"cloudName has no Windows-distinguishable characters",
		);
	}
	return validateWindowsComponent(normalized, "cloudName").toUpperCase();
}

export function assignWindowsSafeCloudNames(records) {
	if (!Array.isArray(records)) {
		throw new ProtonNameError("records must be an array");
	}
	const slugs = new Set();
	const prepared = records.map((record, index) => {
		if (
			record === null ||
			typeof record !== "object" ||
			Array.isArray(record)
		) {
			throw new ProtonNameError(`records[${index}] must be an object`);
		}
		const masterFolder = assertMasterFolder(
			record.masterFolder,
			`records[${index}].masterFolder`,
		);
		const slug = assertString(record.slug, `records[${index}].slug`);
		if (slugs.has(slug)) {
			throw new ProtonNameError(`records repeats slug ${slug}`);
		}
		slugs.add(slug);
		const cloudName = windowsSafeCloudName(record.articleTitle);
		return {
			index,
			record: { ...record, masterFolder },
			slug,
			cloudName,
			groupKey: `${masterFolder}\u0000${windowsNameKey(cloudName)}`,
		};
	});
	const groups = new Map();
	for (const item of prepared) {
		const group = groups.get(item.groupKey) ?? [];
		group.push(item);
		groups.set(item.groupKey, group);
	}
	const occupied = new Set(groups.keys());
	const result = new Array(prepared.length);
	for (const group of groups.values()) {
		group.sort((left, right) => left.slug.localeCompare(right.slug, "en"));
		for (const [position, item] of group.entries()) {
			let cloudName = item.cloudName;
			if (position > 0) {
				if (!/^[a-z0-9][a-z0-9-]*$/u.test(item.slug) || item.slug.length < 8) {
					throw new ProtonNameError(
						`records[${item.index}].slug cannot resolve a cloud-name collision`,
					);
				}
				cloudName = validateWindowsComponent(
					`${cloudName} - ${item.slug.slice(0, 8)}`,
					"collision-resolved cloudName",
				);
				const candidateKey = `${item.record.masterFolder}\u0000${windowsNameKey(cloudName)}`;
				if (occupied.has(candidateKey)) {
					throw new ProtonNameError(
						`records[${item.index}] still collides after adding its slug suffix`,
					);
				}
				occupied.add(candidateKey);
			}
			result[item.index] = { ...item.record, cloudName };
		}
	}
	return result;
}
