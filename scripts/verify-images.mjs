import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { parse } from "parse5";
import sharp from "sharp";
import {
	bodyImageOutputPath,
	responsiveBodyImageWidths,
} from "./medium/lib/render.js";

const DEFAULT_DIST = "dist";
const SITE_SOCIAL_IMAGE = "social/site.jpg";
const IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|svg|webp)$/iu;
const AUDIO_EXTENSION = /\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/iu;
const TEXT_EXTENSION = /\.(?:css|html|js|json|map|mjs|svg|txt|xml)$/iu;
const RESPONSIVE_WIDTHS = new Set([320, 480, 640, 960, 1024, 1280, 1600, 2048]);
const PODCAST_COVER_PATH = "media/podcast/shots-of-rhapsody-podcast-cover.png";
const PODCAST_COVER_SHA256 =
	"293125a3959b91fd3f263905c3f67e360fdb0f62d784653d10311486b0008c70";

const SVG_METADATA_PATTERNS = [
	["XML comments", /<!--/u],
	["SVG metadata", /<metadata(?:\s|>)/iu],
	["XMP packets", /<\?xpacket\b/iu],
	["RDF metadata", /<(?:rdf|xmp|dc|cc|photoshop|exif|tiff):/iu],
	[
		"metadata namespaces",
		/xmlns:(?:rdf|xmp|dc|cc|photoshop|exif|tiff|inkscape|sodipodi)\s*=/iu,
	],
	[
		"metadata namespace URIs",
		/(?:adobe:ns:meta|www\.w3\.org\/1999\/02\/22-rdf-syntax-ns|purl\.org\/dc\/elements|ns\.adobe\.com\/(?:xap|photoshop|exif|tiff))/iu,
	],
];

export const DEFAULT_IMAGE_LIMITS = Object.freeze({
	distBytes: 15 * 1024 * 1024,
	cardBytes: 200 * 1024,
	socialBytes: 500 * 1024,
	initialJavaScriptGzipBytes: 75 * 1024,
	homepageDesktopImageBytes: 1.25 * 1024 * 1024,
	homepageMobileImageBytes: 750 * 1024,
});

function normalizePath(value) {
	return value.replace(/\\/gu, "/");
}

async function walk(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(entryPath)));
		else if (entry.isFile()) files.push(entryPath);
		else {
			throw new Error(
				`Built output contains a non-regular entry: ${entryPath}`,
			);
		}
	}
	return files;
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

export function embeddedRasterMetadata(metadata) {
	const fields = [];
	if (metadata.exif !== undefined || metadata.orientation !== undefined)
		fields.push("EXIF");
	if (metadata.hasProfile === true || metadata.icc !== undefined)
		fields.push("ICC profile");
	if (metadata.iptc !== undefined) fields.push("IPTC");
	if (metadata.xmp !== undefined || metadata.xmpAsString !== undefined)
		fields.push("XMP");
	if (metadata.tifftagPhotoshop !== undefined)
		fields.push("Photoshop metadata");
	if (Array.isArray(metadata.comments) && metadata.comments.length > 0)
		fields.push("embedded comments/text");
	if (metadata.background !== undefined) fields.push("embedded background");
	if (metadata.gainMap !== undefined) fields.push("HDR gain map");
	return fields;
}

function fourCc(bytes, offset) {
	const value = bytes.toString("latin1", offset, offset + 4);
	return /^[\x20-\x7e]{4}$/u.test(value)
		? value
		: `0x${bytes.subarray(offset, offset + 4).toString("hex")}`;
}

function sameSequence(actual, expected) {
	return (
		actual.length === expected.length &&
		actual.every((value, index) => value === expected[index])
	);
}

function inspectWebpContainer(bytes, metadata) {
	if (
		bytes.byteLength < 20 ||
		bytes.toString("ascii", 0, 4) !== "RIFF" ||
		bytes.toString("ascii", 8, 12) !== "WEBP" ||
		bytes.readUInt32LE(4) !== bytes.byteLength - 8
	) {
		throw new Error("invalid WebP RIFF envelope");
	}
	const chunks = [];
	const failures = [];
	let offset = 12;
	while (offset < bytes.byteLength) {
		if (offset > bytes.byteLength - 8)
			throw new Error("truncated WebP chunk header");
		const type = fourCc(bytes, offset);
		const byteLength = bytes.readUInt32LE(offset + 4);
		const dataStart = offset + 8;
		const dataEnd = dataStart + byteLength;
		const paddedEnd = dataEnd + (byteLength % 2);
		if (dataEnd < dataStart || paddedEnd > bytes.byteLength)
			throw new Error(`truncated WebP ${type} chunk`);
		if (paddedEnd > dataEnd && bytes[dataEnd] !== 0)
			failures.push(`WebP ${type} chunk has nonzero padding`);
		chunks.push({ type, byteLength, dataStart, dataEnd });
		offset = paddedEnd;
	}
	if (chunks.length === 0 || offset !== bytes.byteLength)
		throw new Error("invalid WebP chunk table");

	const types = chunks.map((chunk) => chunk.type);
	const allowedTypes = new Set(["VP8 ", "VP8L", "VP8X", "ALPH"]);
	for (const type of types) {
		if (!allowedTypes.has(type)) failures.push(`WebP chunk ${type}`);
	}
	const simpleImage =
		sameSequence(types, ["VP8 "]) || sameSequence(types, ["VP8L"]);
	const alphaImage = sameSequence(types, ["VP8X", "ALPH", "VP8 "]);
	if (!simpleImage && !alphaImage)
		failures.push(`unexpected WebP chunk layout (${types.join(",")})`);
	if (alphaImage) {
		const extended = chunks[0];
		if (
			extended.byteLength !== 10 ||
			bytes[extended.dataStart] !== 0x10 ||
			bytes[extended.dataStart + 1] !== 0 ||
			bytes[extended.dataStart + 2] !== 0 ||
			bytes[extended.dataStart + 3] !== 0
		) {
			failures.push("WebP VP8X contains non-alpha feature flags");
		} else {
			const canvasWidth = 1 + bytes.readUIntLE(extended.dataStart + 4, 3);
			const canvasHeight = 1 + bytes.readUIntLE(extended.dataStart + 7, 3);
			if (canvasWidth !== metadata.width || canvasHeight !== metadata.height) {
				failures.push("WebP VP8X canvas differs from decoded dimensions");
			}
		}
	}
	return [...new Set(failures)];
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit += 1)
		crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

function crc32(bytes, start, end) {
	let crc = 0xffffffff;
	for (let offset = start; offset < end; offset += 1)
		crc = CRC32_TABLE[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function inspectPngContainer(bytes) {
	const signature = Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	]);
	if (
		bytes.byteLength < signature.byteLength + 12 ||
		!bytes.subarray(0, signature.byteLength).equals(signature)
	) {
		throw new Error("invalid PNG signature");
	}
	const chunks = [];
	const failures = [];
	let offset = signature.byteLength;
	while (offset < bytes.byteLength) {
		if (offset > bytes.byteLength - 12)
			throw new Error("truncated PNG chunk header");
		const byteLength = bytes.readUInt32BE(offset);
		const type = fourCc(bytes, offset + 4);
		const dataStart = offset + 8;
		const dataEnd = dataStart + byteLength;
		const chunkEnd = dataEnd + 4;
		if (dataEnd < dataStart || chunkEnd > bytes.byteLength)
			throw new Error(`truncated PNG ${type} chunk`);
		if (crc32(bytes, offset + 4, dataEnd) !== bytes.readUInt32BE(dataEnd))
			throw new Error(`PNG ${type} chunk has an invalid CRC`);
		chunks.push({ type, byteLength, dataStart, dataEnd });
		offset = chunkEnd;
	}
	if (offset !== bytes.byteLength) throw new Error("invalid PNG chunk table");
	const types = chunks.map((chunk) => chunk.type);
	for (const chunk of chunks) {
		if (["IHDR", "IDAT", "IEND"].includes(chunk.type)) continue;
		failures.push(`PNG chunk ${chunk.type}`);
	}
	const firstIdat = types.indexOf("IDAT");
	const lastIdat = types.lastIndexOf("IDAT");
	if (
		chunks[0]?.type !== "IHDR" ||
		chunks[0]?.byteLength !== 13 ||
		firstIdat !== 1 ||
		lastIdat < firstIdat ||
		types.slice(firstIdat, lastIdat + 1).some((type) => type !== "IDAT") ||
		chunks.at(-1)?.type !== "IEND" ||
		chunks.at(-1)?.byteLength !== 0 ||
		types.filter((type) => type === "IHDR").length !== 1 ||
		types.filter((type) => type === "IEND").length !== 1
	) {
		failures.push(`unexpected PNG chunk layout (${types.join(",")})`);
	}
	return [...new Set(failures)];
}

function jpegMarkerName(marker) {
	if (marker >= 0xe0 && marker <= 0xef) return `APP${marker - 0xe0}`;
	if (marker === 0xfe) return "COM";
	return `0x${marker.toString(16).padStart(2, "0")}`;
}

function isCompleteJpegHuffmanTable(bytes, start, end) {
	if (end - start < 17) return false;
	const selector = bytes[start];
	if (selector >> 4 > 1 || (selector & 0x0f) > 1) return false;
	let symbolCount = 0;
	for (let offset = start + 1; offset < start + 17; offset += 1)
		symbolCount += bytes[offset];
	return start + 17 + symbolCount === end;
}

function inspectJpegContainer(bytes, metadata) {
	if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
		throw new Error("invalid JPEG SOI marker");
	}
	const failures = [];
	const allowedSegments = new Set([0xc2, 0xc4, 0xdb, 0xda]);
	const markers = [];
	const quantizationTableIds = [];
	let offset = 2;
	let frameCount = 0;
	let scanCount = 0;
	let ended = false;
	while (offset < bytes.byteLength) {
		if (bytes[offset] !== 0xff)
			throw new Error("JPEG data appears outside an image scan");
		while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
		if (offset >= bytes.byteLength)
			throw new Error("JPEG ends inside a marker prefix");
		const marker = bytes[offset];
		offset += 1;
		markers.push(marker);
		if (marker === 0x00)
			throw new Error("JPEG has a stuffed byte outside an image scan");
		if (marker === 0xd9) {
			ended = true;
			break;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
			throw new Error("JPEG has a standalone marker outside an image scan");
		if (offset > bytes.byteLength - 2)
			throw new Error("truncated JPEG segment length");
		const byteLength = bytes.readUInt16BE(offset);
		if (byteLength < 2 || offset + byteLength > bytes.byteLength)
			throw new Error("invalid JPEG segment length");
		const dataStart = offset + 2;
		const dataEnd = offset + byteLength;
		if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)
			failures.push(`JPEG segment ${jpegMarkerName(marker)}`);
		else if (!allowedSegments.has(marker))
			failures.push(`JPEG segment ${jpegMarkerName(marker)}`);
		if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) frameCount += 1;
		if (marker === 0xdb) {
			const selector = bytes[dataStart];
			if (byteLength !== 67 || selector >> 4 !== 0 || (selector & 0x0f) > 1)
				failures.push("JPEG quantization table payload is unexpected");
			else quantizationTableIds.push(selector & 0x0f);
		}
		if (
			marker === 0xc4 &&
			!isCompleteJpegHuffmanTable(bytes, dataStart, dataEnd)
		)
			failures.push("JPEG Huffman table payload is unexpected");
		if (
			marker === 0xc2 &&
			(byteLength !== 17 ||
				bytes[dataStart] !== 8 ||
				bytes.readUInt16BE(dataStart + 1) !== metadata.height ||
				bytes.readUInt16BE(dataStart + 3) !== metadata.width ||
				bytes[dataStart + 5] !== 3)
		) {
			failures.push("JPEG frame payload differs from decoded dimensions");
		}
		offset += byteLength;
		if (marker !== 0xda) continue;
		scanCount += 1;
		while (offset < bytes.byteLength) {
			if (bytes[offset] !== 0xff) {
				offset += 1;
				continue;
			}
			const markerStart = offset;
			while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
			if (offset >= bytes.byteLength)
				throw new Error("JPEG ends inside scan marker prefix");
			const scanMarker = bytes[offset];
			if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
				offset += 1;
				continue;
			}
			offset = markerStart;
			break;
		}
	}
	if (!ended || offset !== bytes.byteLength)
		throw new Error("JPEG has no terminal EOI or contains trailing bytes");
	if (frameCount !== 1 || scanCount < 1)
		throw new Error("JPEG lacks exactly one frame and at least one image scan");
	const expectedPrefix = [0xdb, 0xdb, 0xc2, 0xc4, 0xc4, 0xda];
	const laterScans = markers.slice(expectedPrefix.length, -1);
	if (
		!markers
			.slice(0, expectedPrefix.length)
			.every((marker, index) => marker === expectedPrefix[index]) ||
		markers.at(-1) !== 0xd9 ||
		laterScans.length % 2 !== 0 ||
		laterScans.some(
			(marker, index) => marker !== (index % 2 === 0 ? 0xc4 : 0xda),
		) ||
		!sameSequence(quantizationTableIds, [0, 1])
	) {
		failures.push("unexpected JPEG codec-segment layout");
	}
	return [...new Set(failures)];
}

function parseIsoBoxes(bytes, start, end, label) {
	const boxes = [];
	let offset = start;
	while (offset < end) {
		if (offset > end - 8)
			throw new Error(`${label} has a truncated box header`);
		const byteLength = bytes.readUInt32BE(offset);
		const type = fourCc(bytes, offset + 4);
		if (byteLength < 8 || offset + byteLength > end)
			throw new Error(`${label} has an invalid ${type} box`);
		boxes.push({
			type,
			start: offset,
			dataStart: offset + 8,
			end: offset + byteLength,
		});
		offset += byteLength;
	}
	if (offset !== end) throw new Error(`${label} has an invalid box table`);
	return boxes;
}

function boxPayload(bytes, box) {
	return bytes.subarray(box.dataStart, box.end);
}

function inspectAvifContainer(bytes, metadata) {
	const failures = [];
	const top = parseIsoBoxes(bytes, 0, bytes.byteLength, "AVIF");
	const topTypes = top.map((box) => box.type);
	for (const type of topTypes) {
		if (type !== "ftyp" && type !== "meta" && type !== "mdat")
			failures.push(`AVIF top-level box ${type}`);
	}
	if (!sameSequence(topTypes, ["ftyp", "meta", "mdat"]))
		failures.push(`unexpected AVIF top-level layout (${topTypes.join(",")})`);
	const [fileType, meta, mediaData] = [
		top.find((box) => box.type === "ftyp"),
		top.find((box) => box.type === "meta"),
		top.find((box) => box.type === "mdat"),
	];
	if (!fileType || !meta || !mediaData) return [...new Set(failures)];
	const expectedFileType = Buffer.from(
		"61766966000000006d696631617669666d696166",
		"hex",
	);
	if (!boxPayload(bytes, fileType).equals(expectedFileType))
		failures.push(
			"AVIF ftyp brands or version differ from the approved encoder",
		);
	if (
		meta.end - meta.dataStart < 4 ||
		!bytes.subarray(meta.dataStart, meta.dataStart + 4).equals(Buffer.alloc(4))
	) {
		throw new Error("AVIF meta full-box header is invalid");
	}
	const metaChildren = parseIsoBoxes(
		bytes,
		meta.dataStart + 4,
		meta.end,
		"AVIF meta",
	);
	const metaTypes = metaChildren.map((box) => box.type);
	for (const type of metaTypes) {
		if (!["hdlr", "iloc", "iinf", "pitm", "iprp"].includes(type))
			failures.push(`AVIF meta box ${type}`);
	}
	if (!sameSequence(metaTypes, ["hdlr", "iloc", "iinf", "pitm", "iprp"]))
		failures.push(`unexpected AVIF meta layout (${metaTypes.join(",")})`);
	const child = Object.fromEntries(metaChildren.map((box) => [box.type, box]));
	if (!child.hdlr || !child.iloc || !child.iinf || !child.pitm || !child.iprp)
		return [...new Set(failures)];
	const expectedHandler = Buffer.from(
		"00000000000000007069637400000000000000000000000000",
		"hex",
	);
	if (!boxPayload(bytes, child.hdlr).equals(expectedHandler))
		failures.push("AVIF handler contains unexpected data");
	if (!boxPayload(bytes, child.pitm).equals(Buffer.from("000000000001", "hex")))
		failures.push("AVIF primary item differs from the approved encoder");

	const itemInfoPayload = boxPayload(bytes, child.iinf);
	if (
		itemInfoPayload.byteLength < 6 ||
		!itemInfoPayload.subarray(0, 6).equals(Buffer.from("000000000001", "hex"))
	) {
		failures.push("AVIF item information header is unexpected");
	} else {
		const itemEntries = parseIsoBoxes(
			bytes,
			child.iinf.dataStart + 6,
			child.iinf.end,
			"AVIF iinf",
		);
		if (
			itemEntries.length !== 1 ||
			itemEntries[0].type !== "infe" ||
			!boxPayload(bytes, itemEntries[0]).equals(
				Buffer.from("02000000000100006176303100", "hex"),
			)
		) {
			failures.push("AVIF contains an unexpected item or item description");
		}
	}

	const itemProperties = parseIsoBoxes(
		bytes,
		child.iprp.dataStart,
		child.iprp.end,
		"AVIF iprp",
	);
	const propertyContainerTypes = itemProperties.map((box) => box.type);
	if (!sameSequence(propertyContainerTypes, ["ipco", "ipma"]))
		failures.push(
			`unexpected AVIF property layout (${propertyContainerTypes.join(",")})`,
		);
	const propertyContainer = itemProperties.find((box) => box.type === "ipco");
	const propertyAssociations = itemProperties.find(
		(box) => box.type === "ipma",
	);
	if (propertyContainer && propertyAssociations) {
		const properties = parseIsoBoxes(
			bytes,
			propertyContainer.dataStart,
			propertyContainer.end,
			"AVIF ipco",
		);
		const propertyTypes = properties.map((box) => box.type);
		if (!sameSequence(propertyTypes, ["av1C", "ispe", "pixi"]))
			failures.push(
				`unexpected AVIF image properties (${propertyTypes.join(",")})`,
			);
		const codec = properties.find((box) => box.type === "av1C");
		const dimensions = properties.find((box) => box.type === "ispe");
		const pixelInformation = properties.find((box) => box.type === "pixi");
		if (!codec || boxPayload(bytes, codec).byteLength !== 4)
			failures.push("AVIF codec configuration is unexpected");
		if (
			!pixelInformation ||
			!boxPayload(bytes, pixelInformation).equals(
				Buffer.from("000000000108", "hex"),
			)
		) {
			failures.push("AVIF pixel information is unexpected");
		}
		if (!dimensions || boxPayload(bytes, dimensions).byteLength !== 12) {
			failures.push("AVIF dimensions property is unexpected");
		} else {
			const payload = boxPayload(bytes, dimensions);
			if (
				!payload.subarray(0, 4).equals(Buffer.alloc(4)) ||
				payload.readUInt32BE(4) !== metadata.width ||
				payload.readUInt32BE(8) !== metadata.height
			) {
				failures.push(
					"AVIF dimensions property differs from decoded dimensions",
				);
			}
		}
		if (
			!boxPayload(bytes, propertyAssociations).equals(
				Buffer.from("0000000000000001000103810203", "hex"),
			)
		) {
			failures.push("AVIF property associations are unexpected");
		}
	}

	const location = boxPayload(bytes, child.iloc);
	if (
		location.byteLength !== 26 ||
		!location
			.subarray(0, 12)
			.equals(Buffer.from("000000004440000100010000", "hex")) ||
		location.readUInt16BE(16) !== 1
	) {
		failures.push("AVIF item location is unexpected");
	} else {
		const baseOffset = location.readUInt32BE(12);
		const extentOffset = location.readUInt32BE(18);
		const extentLength = location.readUInt32BE(22);
		if (
			baseOffset + extentOffset !== mediaData.dataStart ||
			extentLength !== mediaData.end - mediaData.dataStart
		) {
			failures.push(
				"AVIF media payload is not exactly covered by its image extent",
			);
		}
	}
	return [...new Set(failures)];
}

export function embeddedRasterContainerMetadata(bytes, metadata) {
	if (!Buffer.isBuffer(bytes))
		throw new Error("raster image must be a byte buffer");
	if (metadata?.format === "webp") return inspectWebpContainer(bytes, metadata);
	if (metadata?.format === "png") return inspectPngContainer(bytes);
	if (metadata?.format === "jpeg") return inspectJpegContainer(bytes, metadata);
	if (metadata?.format === "heif") return inspectAvifContainer(bytes, metadata);
	return [`unsupported raster container ${metadata?.format ?? "unknown"}`];
}

export function embeddedSvgMetadata(source) {
	return SVG_METADATA_PATTERNS.filter(([, pattern]) =>
		pattern.test(source),
	).map(([label]) => label);
}

function attributes(node) {
	return Object.fromEntries(
		(node.attrs ?? []).map(({ name, value }) => [name, value]),
	);
}

function visit(node, callback) {
	callback(node);
	for (const child of node.childNodes ?? []) visit(child, callback);
}

function responsiveAssetPath(value) {
	try {
		const parsed = new URL(
			value.replace(/&amp;/gu, "&"),
			"https://build.invalid/",
		);
		if (parsed.origin !== "https://build.invalid") return undefined;
		const { pathname } = parsed;
		const marker = "/_astro/";
		const markerIndex = pathname.indexOf(marker);
		if (markerIndex < 0) return undefined;
		return `_astro/${decodeURIComponent(pathname.slice(markerIndex + marker.length))}`;
	} catch {
		return undefined;
	}
}

function responsivePathsFromNode(node) {
	const paths = new Set();
	visit(node, (descendant) => {
		if (descendant.tagName !== "source" && descendant.tagName !== "img") return;
		const nodeAttributes = attributes(descendant);
		for (const candidate of (nodeAttributes.srcset ?? "").split(",")) {
			const assetPath = responsiveAssetPath(candidate.trim().split(/\s+/u)[0]);
			if (assetPath) paths.add(assetPath);
		}
		const sourcePath = responsiveAssetPath(nodeAttributes.src ?? "");
		if (sourcePath) paths.add(sourcePath);
	});
	return paths;
}

function writingMediaPath(value) {
	try {
		const parsed = new URL(
			value.replace(/&amp;/gu, "&"),
			"https://build.invalid/",
		);
		if (parsed.origin !== "https://build.invalid") return undefined;
		const { pathname } = parsed;
		const marker = "/media/writing/";
		const markerIndex = pathname.indexOf(marker);
		if (markerIndex < 0) return undefined;
		return `media/writing/${decodeURIComponent(pathname.slice(markerIndex + marker.length))}`;
	} catch {
		return undefined;
	}
}

function writingMediaPathsFromNode(node) {
	const paths = new Set();
	visit(node, (descendant) => {
		if (descendant.tagName !== "source" && descendant.tagName !== "img") return;
		const nodeAttributes = attributes(descendant);
		for (const candidate of (nodeAttributes.srcset ?? "").split(",")) {
			const assetPath = writingMediaPath(candidate.trim().split(/\s+/u)[0]);
			if (assetPath) paths.add(assetPath);
		}
		const sourcePath = writingMediaPath(nodeAttributes.src ?? "");
		if (sourcePath) paths.add(sourcePath);
	});
	return paths;
}

function referencedFile(value, relativeToFile) {
	try {
		const pathname = decodeURIComponent(
			new URL(value, "https://build.invalid/").pathname,
		);
		for (const [relative, file] of relativeToFile) {
			if (pathname === `/${relative}` || pathname.endsWith(`/${relative}`)) {
				return file;
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

async function initialJavaScriptBytes(htmlDocuments, relativeToFile, failures) {
	let maximumBytes = 0;
	for (const [file, document] of htmlDocuments) {
		const scriptParts = [];
		const externalScripts = new Set();
		visit(document, (node) => {
			if (node.tagName !== "script") return;
			const nodeAttributes = attributes(node);
			if (
				nodeAttributes.type === "application/ld+json" ||
				nodeAttributes.type === "application/json"
			) {
				return;
			}
			if (nodeAttributes.src) {
				const scriptFile = referencedFile(nodeAttributes.src, relativeToFile);
				if (scriptFile) externalScripts.add(scriptFile);
				else if (!/^https?:/iu.test(nodeAttributes.src)) {
					failures.push(
						`initial script reference does not resolve in dist: ${nodeAttributes.src}`,
					);
				}
				return;
			}
			const source = (node.childNodes ?? [])
				.map((child) => child.value ?? "")
				.join("");
			if (source.trim()) scriptParts.push(Buffer.from(source));
		});
		for (const scriptFile of externalScripts) {
			scriptParts.push(await readFile(scriptFile));
		}
		const pageBytes = scriptParts.reduce(
			(total, bytes) => total + gzipSync(bytes).byteLength,
			0,
		);
		maximumBytes = Math.max(maximumBytes, pageBytes);
		if (!Number.isFinite(pageBytes)) {
			failures.push(`could not measure initial JavaScript for ${file}`);
		}
	}
	return maximumBytes;
}

async function homepageInitialImageBytes(
	homeDocument,
	relativeToFile,
	failures,
) {
	if (!homeDocument) {
		failures.push("homepage HTML is missing for initial image verification");
		return 0;
	}
	const initialImages = [];
	visit(homeDocument, (node) => {
		if (node.tagName !== "img") return;
		const nodeAttributes = attributes(node);
		if (
			nodeAttributes.loading !== "lazy" ||
			nodeAttributes.fetchpriority === "high"
		) {
			initialImages.push({ node, attributes: nodeAttributes });
		}
	});
	const eagerImages = initialImages.filter(
		(image) => image.attributes.loading === "eager",
	);
	const priorityImages = initialImages.filter(
		(image) => image.attributes.fetchpriority === "high",
	);
	if (
		initialImages.length !== 1 ||
		eagerImages.length !== 1 ||
		priorityImages.length !== 1 ||
		eagerImages[0]?.node !== priorityImages[0]?.node
	) {
		failures.push(
			`homepage must have exactly one initially loaded eager/high-priority image (initial=${initialImages.length}, eager=${eagerImages.length}, high=${priorityImages.length})`,
		);
	}

	let worstCaseBytes = 0;
	for (const { node, attributes: imageAttributes } of initialImages) {
		const candidateGroups = [];
		const picture =
			node.parentNode?.tagName === "picture" ? node.parentNode : undefined;
		if (picture) {
			for (const child of picture.childNodes ?? []) {
				if (child.tagName !== "source") continue;
				const sourceAttributes = attributes(child);
				candidateGroups.push(
					sourceAttributes.srcset ?? sourceAttributes.src ?? "",
				);
			}
		}
		candidateGroups.push(imageAttributes.srcset ?? imageAttributes.src ?? "");

		let imageWorstCaseBytes = 0;
		for (const candidates of candidateGroups) {
			let groupWorstCaseBytes = 0;
			for (const candidate of candidates.split(",")) {
				const candidateUrl = candidate.trim().split(/\s+/u)[0];
				if (!candidateUrl) continue;
				const candidateFile = referencedFile(candidateUrl, relativeToFile);
				if (!candidateFile) {
					failures.push(
						`homepage initial image candidate does not resolve in dist: ${candidateUrl}`,
					);
					continue;
				}
				groupWorstCaseBytes = Math.max(
					groupWorstCaseBytes,
					(await stat(candidateFile)).size,
				);
			}
			imageWorstCaseBytes = Math.max(imageWorstCaseBytes, groupWorstCaseBytes);
		}
		worstCaseBytes += imageWorstCaseBytes;
	}
	return worstCaseBytes;
}

function parseArguments(argv) {
	const options = { dist: DEFAULT_DIST, repoRoot: process.cwd() };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--dist" || argument === "--repo-root") {
			const value = argv[index + 1];
			if (!value) throw new Error(`${argument} requires a value`);
			options[argument === "--dist" ? "dist" : "repoRoot"] = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}
	return options;
}

export async function inspectBuiltImages({
	dist = DEFAULT_DIST,
	repoRoot: repoRootValue = process.cwd(),
	files: providedFiles,
	limits: limitOverrides = {},
} = {}) {
	const distRoot = path.resolve(dist);
	const repoRoot = path.resolve(repoRootValue);
	const limits = { ...DEFAULT_IMAGE_LIMITS, ...limitOverrides };
	const failures = [];
	const files = providedFiles ?? (await walk(distRoot));
	const readJson = async (...segments) =>
		JSON.parse(await readFile(path.join(repoRoot, ...segments), "utf8"));
	const [archiveManifest, mediumManifest, firstPartyManifest, catalog] =
		await Promise.all([
			readJson("provenance", "tai-song", "manifest.json"),
			readJson("provenance", "medium", "manifest.json"),
			readJson("provenance", "first-party", "manifest.json"),
			readJson("provenance", "publication-catalog.json"),
		]);
	const archiveBySlug = new Map(
		(archiveManifest.articles ?? []).map((article) => [article.slug, article]),
	);
	const mediumBySlug = new Map(
		(mediumManifest.articles ?? []).map((article) => [article.slug, article]),
	);
	const firstPartyBySlug = new Map(
		(firstPartyManifest.articles ?? []).map((article) => [
			article.slug,
			article,
		]),
	);
	const articles = (catalog.entries ?? []).map((entry) => {
		let source;
		if (entry.source === "tai-song") source = archiveBySlug.get(entry.slug);
		else if (entry.source === "medium") source = mediumBySlug.get(entry.slug);
		else if (entry.source === "first-party")
			source = firstPartyBySlug.get(entry.slug);
		else failures.push(`publication source is unsupported for ${entry.slug}`);
		const assets =
			entry.source === "tai-song"
				? source
					? [
							{
								id: "hero",
								role: "hero",
								path: source.paths?.image,
								...source.image,
							},
						]
					: []
				: (source?.assets ?? []).map((asset) => ({
						...asset,
						id: asset.id ?? path.basename(asset.path, path.extname(asset.path)),
					}));
		const image = assets.find((asset) => asset.role === "hero");
		if (!source || !image)
			failures.push(`publication image evidence is missing for ${entry.slug}`);
		return { slug: entry.slug, image, assets };
	});
	const slugs = articles.map((article) => article.slug);
	if (articles.length < 11 || new Set(slugs).size !== articles.length)
		failures.push(
			"image publication catalog must contain at least eleven unique slugs",
		);

	const originalHashes = new Set(
		[
			...(archiveManifest.articles ?? []).map((article) => article.image),
			...(mediumManifest.articles ?? []).flatMap(
				(article) => article.assets ?? [],
			),
			...(firstPartyManifest.articles ?? []).flatMap(
				(article) => article.assets ?? [],
			),
		]
			.map((image) => String(image?.sha256 ?? "").replace(/^sha256:/u, ""))
			.filter(Boolean),
	);
	const expectedSocialImages = new Set(
		slugs.map((slug) => `social/${slug}.jpg`),
	);
	const expectedBodyImages = new Map();
	const bodyAssetsById = new Map();
	for (const article of articles) {
		if (
			!article.image ||
			!Number.isSafeInteger(article.image.width) ||
			article.image.width <= 0 ||
			!Number.isSafeInteger(article.image.height) ||
			article.image.height <= 0
		) {
			failures.push(
				`publication hero dimensions are invalid for ${article.slug}`,
			);
		}
		for (const asset of article.assets.filter(
			(asset) => asset.role === "body",
		)) {
			const stableId = `${article.slug}/${asset.id}`;
			if (bodyAssetsById.has(stableId))
				failures.push(`publication body image ID is duplicated: ${stableId}`);
			bodyAssetsById.set(stableId, asset);
			for (const width of responsiveBodyImageWidths(asset.width)) {
				for (const format of ["avif", "webp"]) {
					const relative = bodyImageOutputPath(
						article.slug,
						asset.id,
						width,
						format,
					);
					if (expectedBodyImages.has(relative)) {
						failures.push(
							`publication body image path is duplicated: ${relative}`,
						);
					}
					expectedBodyImages.set(relative, {
						width,
						ratio: asset.width / asset.height,
						stableId,
					});
				}
			}
		}
	}
	const relativeByFile = new Map(
		files.map((file) => [file, normalizePath(path.relative(distRoot, file))]),
	);
	const relativeToFile = new Map(
		[...relativeByFile].map(([file, relative]) => [relative, file]),
	);
	const imageFiles = files.filter((file) => IMAGE_EXTENSION.test(file));
	const emittedImages = imageFiles.map((file) => relativeByFile.get(file));
	const emittedImageSet = new Set(emittedImages);

	const textParts = [];
	const htmlDocuments = new Map();
	for (const file of files) {
		if (!TEXT_EXTENSION.test(file) || IMAGE_EXTENSION.test(file)) continue;
		try {
			const text = await readFile(file, "utf8");
			textParts.push(text);
			if (file.endsWith(".html")) htmlDocuments.set(file, parse(text));
		} catch {
			failures.push(
				`built image reference source could not be read: ${relativeByFile.get(file)}`,
			);
		}
	}
	const referenceCorpus = textParts.join("\n");
	const manifestSlugSet = new Set(slugs);
	const manifestResponsiveImages = new Set();
	const responsiveImageOwners = new Map();
	const sourceAspectRatios = new Map(
		articles.map((article) => [
			article.slug,
			article.image?.width > 0 && article.image?.height > 0
				? article.image.width / article.image.height
				: undefined,
		]),
	);
	sourceAspectRatios.set("podcast-cover", 1);
	const bindResponsiveImage = (assetPath, slug) => {
		manifestResponsiveImages.add(assetPath);
		const owners = responsiveImageOwners.get(assetPath) ?? new Set();
		owners.add(slug);
		responsiveImageOwners.set(assetPath, owners);
	};
	const heroSlugs = new Set();
	const bodyMarkerCounts = new Map();
	const renderedBodyImages = new Set();
	let podcastArtworkMarkers = 0;
	const podcastRouteFile = path.join(
		distRoot,
		"podcast",
		"modular-ethics",
		"index.html",
	);
	const podcastPublished = htmlDocuments.has(podcastRouteFile);
	for (const [file, document] of htmlDocuments) {
		const relative = relativeByFile.get(file);
		const articleMatch = relative.match(/^posts\/([^/]+)\/index\.html$/u);
		visit(document, (node) => {
			const nodeAttributes = attributes(node);
			const writingAssetId = nodeAttributes["data-writing-asset-id"];
			if (writingAssetId) {
				bodyMarkerCounts.set(
					writingAssetId,
					(bodyMarkerCounts.get(writingAssetId) ?? 0) + 1,
				);
				if (!bodyAssetsById.has(writingAssetId)) {
					failures.push(
						`rendered body image lacks publication evidence: ${writingAssetId}`,
					);
				} else {
					const [approvedSlug] = writingAssetId.split("/");
					if (articleMatch?.[1] !== approvedSlug) {
						failures.push(
							`body image is rendered outside its approved article: ${writingAssetId}`,
						);
					}
					const renderedPaths = writingMediaPathsFromNode(node);
					if (renderedPaths.size === 0) {
						failures.push(
							`body image has no same-origin responsive sources: ${writingAssetId}`,
						);
					}
					for (const assetPath of renderedPaths) {
						if (expectedBodyImages.get(assetPath)?.stableId !== writingAssetId)
							failures.push(
								`body image path is not bound to its approved asset: ${assetPath}`,
							);
						else renderedBodyImages.add(assetPath);
					}
				}
			}
			const podcastArtwork = nodeAttributes["data-podcast-artwork"];
			if (podcastArtwork !== undefined) {
				if (podcastArtwork !== `sha256:${PODCAST_COVER_SHA256}`) {
					failures.push("podcast artwork marker has an unapproved digest");
					return;
				}
				podcastArtworkMarkers += 1;
				if (file !== podcastRouteFile) {
					failures.push(
						"podcast artwork is rendered outside its episode route",
					);
				}
				const responsivePaths = responsivePathsFromNode(node);
				if (responsivePaths.size === 0) {
					failures.push(
						"podcast artwork has no same-origin responsive sources",
					);
				}
				for (const assetPath of responsivePaths) {
					bindResponsiveImage(assetPath, "podcast-cover");
				}
			}
			const editorialSlug = nodeAttributes["data-editorial-slug"];
			if (editorialSlug) {
				if (!manifestSlugSet.has(editorialSlug)) {
					failures.push(
						`responsive editorial image is bound to a non-manifest slug: ${editorialSlug}`,
					);
				} else {
					const responsivePaths = responsivePathsFromNode(node);
					if (responsivePaths.size === 0) {
						failures.push(
							`editorial image has no same-origin responsive sources: ${editorialSlug}`,
						);
					}
					for (const assetPath of responsivePaths) {
						bindResponsiveImage(assetPath, editorialSlug);
					}
				}
			}
			if (
				articleMatch &&
				manifestSlugSet.has(articleMatch[1]) &&
				nodeAttributes["data-image-variant"] === "hero"
			) {
				heroSlugs.add(articleMatch[1]);
				const responsivePaths = responsivePathsFromNode(node);
				if (responsivePaths.size === 0) {
					failures.push(
						`article hero has no same-origin responsive sources: ${articleMatch[1]}`,
					);
				}
				for (const assetPath of responsivePaths) {
					bindResponsiveImage(assetPath, articleMatch[1]);
				}
			}
		});
	}
	for (const slug of slugs) {
		if (!heroSlugs.has(slug)) {
			failures.push(
				`manifest article hero is missing from built HTML: ${slug}`,
			);
		}
	}
	for (const stableId of bodyAssetsById.keys()) {
		if (bodyMarkerCounts.get(stableId) !== 1) {
			failures.push(
				`approved body image must render exactly once: ${stableId} (rendered ${bodyMarkerCounts.get(stableId) ?? 0})`,
			);
		}
	}
	for (const relative of expectedBodyImages.keys()) {
		if (!renderedBodyImages.has(relative)) {
			failures.push(`responsive body image is not rendered: ${relative}`);
		}
	}
	if (podcastPublished && podcastArtworkMarkers !== 1) {
		failures.push(
			`published podcast must render one approved artwork marker (rendered ${podcastArtworkMarkers})`,
		);
	}
	if (!podcastPublished && podcastArtworkMarkers !== 0) {
		failures.push(
			"draft podcast artwork was rendered without an episode route",
		);
	}

	let totalDistBytes = 0;
	let distBytes = 0;
	let responsiveBytes = 0;
	let socialBytes = 0;
	for (const file of files) {
		const fileStat = await stat(file);
		totalDistBytes += fileStat.size;
		if (!AUDIO_EXTENSION.test(file)) distBytes += fileStat.size;
	}
	const initialJavaScriptGzipBytes = await initialJavaScriptBytes(
		htmlDocuments,
		relativeToFile,
		failures,
	);
	const homepageInitialImageBytesValue = await homepageInitialImageBytes(
		htmlDocuments.get(path.join(distRoot, "index.html")),
		relativeToFile,
		failures,
	);
	if (distBytes > limits.distBytes) {
		failures.push(
			`non-audio built artifact is ${distBytes} bytes; budget is ${limits.distBytes} bytes`,
		);
	}
	if (initialJavaScriptGzipBytes > limits.initialJavaScriptGzipBytes) {
		failures.push(
			`compressed JavaScript is ${initialJavaScriptGzipBytes} bytes; budget is ${limits.initialJavaScriptGzipBytes} bytes`,
		);
	}
	if (homepageInitialImageBytesValue > limits.homepageDesktopImageBytes) {
		failures.push(
			`homepage initial desktop images are ${homepageInitialImageBytesValue} bytes; budget is ${limits.homepageDesktopImageBytes} bytes`,
		);
	}
	if (homepageInitialImageBytesValue > limits.homepageMobileImageBytes) {
		failures.push(
			`homepage initial mobile images are ${homepageInitialImageBytesValue} bytes; budget is ${limits.homepageMobileImageBytes} bytes`,
		);
	}

	for (const file of imageFiles) {
		const relative = relativeByFile.get(file);
		const bytes = await readFile(file);
		const fileHash = sha256(bytes);
		if (originalHashes.has(fileHash)) {
			failures.push(`archival original image leaked into dist: ${relative}`);
		}
		if (!referenceCorpus.includes(path.basename(file))) {
			failures.push(`built image is not referenced by any output: ${relative}`);
		}

		if (relative.endsWith(".svg")) {
			const embeddedMetadata = embeddedSvgMetadata(bytes.toString("utf8"));
			if (embeddedMetadata.length > 0) {
				failures.push(
					`built SVG contains embedded metadata: ${relative} (${embeddedMetadata.join(", ")})`,
				);
			}
			if (relative === "mark.svg") continue;
		}

		let metadata;
		try {
			metadata = await sharp(bytes).metadata();
		} catch {
			failures.push(`built raster image could not be decoded: ${relative}`);
			continue;
		}
		const embeddedMetadata = embeddedRasterMetadata(metadata);
		if (embeddedMetadata.length > 0) {
			failures.push(
				`built raster image contains embedded metadata: ${relative} (${embeddedMetadata.join(", ")})`,
			);
		}
		try {
			const containerMetadata = embeddedRasterContainerMetadata(
				bytes,
				metadata,
			);
			if (containerMetadata.length > 0) {
				failures.push(
					`built raster container contains unexpected payload: ${relative} (${containerMetadata.join(", ")})`,
				);
			}
		} catch {
			failures.push(
				`built raster container could not be validated: ${relative}`,
			);
			continue;
		}

		if (relative === PODCAST_COVER_PATH) {
			if (
				fileHash !== PODCAST_COVER_SHA256 ||
				metadata.format !== "png" ||
				metadata.width !== 3000 ||
				metadata.height !== 3000 ||
				metadata.hasAlpha === true ||
				metadata.space !== "srgb"
			) {
				failures.push(
					`podcast cover differs from approved evidence: ${relative}`,
				);
			}
			if (!podcastPublished) {
				failures.push(`draft podcast cover leaked into dist: ${relative}`);
			}
			continue;
		}
		if (relative === SITE_SOCIAL_IMAGE) {
			socialBytes += bytes.byteLength;
			if (
				metadata.format !== "jpeg" ||
				metadata.width !== 1200 ||
				metadata.height !== 630
			) {
				failures.push(`site social image must be 1200x630 JPEG: ${relative}`);
			}
			if (bytes.byteLength > limits.socialBytes) {
				failures.push(
					`site social image exceeds ${limits.socialBytes} bytes: ${relative} (${bytes.byteLength})`,
				);
			}
			continue;
		}
		if (expectedSocialImages.has(relative)) {
			socialBytes += bytes.byteLength;
			if (
				metadata.format !== "jpeg" ||
				metadata.width !== 1200 ||
				metadata.height !== 1200
			) {
				failures.push(`social image must be 1200x1200 JPEG: ${relative}`);
			}
			if (bytes.byteLength > limits.socialBytes) {
				failures.push(
					`social image exceeds ${limits.socialBytes} bytes: ${relative} (${bytes.byteLength})`,
				);
			}
			continue;
		}
		if (expectedBodyImages.has(relative)) {
			const expected = expectedBodyImages.get(relative);
			const expectedFormat = relative.endsWith(".avif") ? "heif" : "webp";
			const actualRatio = metadata.width / metadata.height;
			if (
				metadata.format !== expectedFormat ||
				metadata.width !== expected.width ||
				!metadata.height ||
				Math.abs(actualRatio - expected.ratio) > 1 / metadata.height
			) {
				failures.push(
					`responsive body image differs from its approved source: ${relative}`,
				);
			}
			responsiveBytes += bytes.byteLength;
			continue;
		}

		if (!/^_astro\/[^/]+\.(?:avif|webp)$/u.test(relative)) {
			failures.push(`image is outside the publication allowlist: ${relative}`);
			continue;
		}
		if (!manifestResponsiveImages.has(relative)) {
			failures.push(
				`responsive image is not bound to a manifest article source: ${relative}`,
			);
		}
		responsiveBytes += bytes.byteLength;
		const formatMatchesExtension = relative.endsWith(".avif")
			? metadata.format === "heif"
			: metadata.format === "webp";
		if (
			!formatMatchesExtension ||
			!RESPONSIVE_WIDTHS.has(metadata.width) ||
			!metadata.height
		) {
			failures.push(
				`responsive image has an unexpected format or dimensions: ${relative}`,
			);
		}
		const actualRatio = metadata.width / metadata.height;
		const owners = [...(responsiveImageOwners.get(relative) ?? [])];
		const ownerRatios = owners.map((slug) => sourceAspectRatios.get(slug));
		if (
			owners.length === 0 ||
			ownerRatios.some((ratio) => !Number.isFinite(ratio)) ||
			ownerRatios.some(
				(ratio) => Math.abs(actualRatio - ratio) > 1 / metadata.height,
			)
		)
			failures.push(
				`responsive image aspect ratio differs from its approved source: ${relative}`,
			);
		if (metadata.width <= 640 && bytes.byteLength > limits.cardBytes) {
			failures.push(
				`card-sized image exceeds ${limits.cardBytes} bytes: ${relative} (${bytes.byteLength})`,
			);
		}
	}

	for (const relative of expectedSocialImages) {
		if (!emittedImageSet.has(relative)) {
			failures.push(`required social image is missing: ${relative}`);
		}
	}
	for (const relative of expectedBodyImages.keys()) {
		if (!emittedImageSet.has(relative)) {
			failures.push(`required responsive body image is missing: ${relative}`);
		}
	}
	for (const relative of manifestResponsiveImages) {
		if (!emittedImageSet.has(relative)) {
			failures.push(`referenced responsive image is missing: ${relative}`);
		}
	}
	if (podcastPublished && !emittedImageSet.has(PODCAST_COVER_PATH)) {
		failures.push(`published podcast cover is missing: ${PODCAST_COVER_PATH}`);
	}
	if (!podcastPublished && emittedImageSet.has(PODCAST_COVER_PATH)) {
		failures.push(`draft podcast cover is present: ${PODCAST_COVER_PATH}`);
	}
	if (!emittedImageSet.has(SITE_SOCIAL_IMAGE)) {
		failures.push(
			`required site social image is missing: ${SITE_SOCIAL_IMAGE}`,
		);
	}
	if (!emittedImageSet.has("mark.svg")) {
		failures.push("vector project mark is missing: mark.svg");
	}
	if (!imageFiles.some((file) => file.endsWith(".avif"))) {
		failures.push("no responsive AVIF images were emitted");
	}
	if (!imageFiles.some((file) => file.endsWith(".webp"))) {
		failures.push("no responsive WebP fallback images were emitted");
	}

	return {
		failures,
		stats: {
			distBytes,
			totalDistBytes,
			imageCount: imageFiles.length,
			responsiveBytes,
			socialBytes,
			initialJavaScriptGzipBytes,
			homepageInitialImageBytes: homepageInitialImageBytesValue,
		},
	};
}

export async function verifyBuiltImages(options = {}) {
	const result = await inspectBuiltImages(options);
	if (result.failures.length > 0) {
		throw new Error(
			`Built-image verification failed:\n- ${result.failures.join("\n- ")}`,
		);
	}
	return result.stats;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	try {
		const stats = await verifyBuiltImages(
			parseArguments(process.argv.slice(2)),
		);
		console.log(
			`Built-image verification passed: ${stats.imageCount} images, ${stats.distBytes} non-audio bytes, ${stats.initialJavaScriptGzipBytes} compressed JavaScript bytes`,
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
