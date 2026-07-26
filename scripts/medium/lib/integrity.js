import { createHash } from "node:crypto";
import { inspectPng } from "../../archive/lib/integrity.js";
import { MediumContractError } from "./contract.js";

export function sha256(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function inspectJpeg(buffer, label) {
	if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
		throw new MediumContractError(`${label} does not have a JPEG signature`);
	}
	let offset = 2;
	while (offset < buffer.length) {
		while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
		if (offset >= buffer.length) break;
		const marker = buffer[offset];
		offset += 1;
		if (marker === 0xd9 || marker === 0xda) break;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (offset > buffer.length - 2) {
			throw new MediumContractError(`${label} has a truncated JPEG segment`);
		}
		const length = buffer.readUInt16BE(offset);
		if (length < 2 || offset > buffer.length - length) {
			throw new MediumContractError(`${label} has an invalid JPEG segment`);
		}
		const sofMarkers = new Set([
			0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
			0xcf,
		]);
		if (sofMarkers.has(marker)) {
			if (length < 7) {
				throw new MediumContractError(`${label} has an invalid JPEG frame`);
			}
			const height = buffer.readUInt16BE(offset + 3);
			const width = buffer.readUInt16BE(offset + 5);
			if (width === 0 || height === 0) {
				throw new MediumContractError(`${label} has zero JPEG dimensions`);
			}
			return { mimeType: "image/jpeg", width, height };
		}
		offset += length;
	}
	throw new MediumContractError(`${label} has no supported JPEG frame`);
}

function readUInt24LE(buffer, offset) {
	return (
		buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
	);
}

function inspectWebp(buffer, label) {
	if (
		buffer.length < 30 ||
		buffer.toString("ascii", 0, 4) !== "RIFF" ||
		buffer.toString("ascii", 8, 12) !== "WEBP" ||
		buffer.readUInt32LE(4) !== buffer.length - 8
	) {
		throw new MediumContractError(`${label} does not have a valid WebP header`);
	}
	const chunk = buffer.toString("ascii", 12, 16);
	const chunkLength = buffer.readUInt32LE(16);
	if (20 + chunkLength > buffer.length) {
		throw new MediumContractError(`${label} has a truncated WebP image chunk`);
	}
	let width;
	let height;
	if (chunk === "VP8X") {
		if (chunkLength < 10)
			throw new MediumContractError(`${label} has an invalid VP8X chunk`);
		width = readUInt24LE(buffer, 24) + 1;
		height = readUInt24LE(buffer, 27) + 1;
	} else if (chunk === "VP8L") {
		if (chunkLength < 5 || buffer[20] !== 0x2f) {
			throw new MediumContractError(`${label} has an invalid VP8L chunk`);
		}
		width = 1 + (((buffer[22] & 0x3f) << 8) | buffer[21]);
		height =
			1 + (((buffer[24] & 0x0f) << 10) | (buffer[23] << 2) | (buffer[22] >> 6));
	} else if (chunk === "VP8 ") {
		if (
			chunkLength < 10 ||
			buffer[23] !== 0x9d ||
			buffer[24] !== 0x01 ||
			buffer[25] !== 0x2a
		) {
			throw new MediumContractError(`${label} has an invalid VP8 chunk`);
		}
		width = buffer.readUInt16LE(26) & 0x3fff;
		height = buffer.readUInt16LE(28) & 0x3fff;
	} else {
		throw new MediumContractError(
			`${label} uses unsupported WebP chunk ${chunk}`,
		);
	}
	if (width === 0 || height === 0) {
		throw new MediumContractError(`${label} has zero WebP dimensions`);
	}
	return { mimeType: "image/webp", width, height };
}

export function inspectImage(buffer, label = "image") {
	if (!Buffer.isBuffer(buffer)) {
		throw new MediumContractError(`${label} must be read as bytes`);
	}
	if (
		buffer.length >= 8 &&
		buffer
			.subarray(0, 8)
			.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	) {
		try {
			return inspectPng(buffer, label);
		} catch (error) {
			throw new MediumContractError(error.message, { cause: error });
		}
	}
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
		return inspectJpeg(buffer, label);
	}
	if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF") {
		return inspectWebp(buffer, label);
	}
	throw new MediumContractError(
		`${label} must be an original PNG, JPEG, or WebP image`,
	);
}
