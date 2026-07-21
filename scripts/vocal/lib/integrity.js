import { createHash } from "node:crypto";
import { ContractError } from "./contract.js";

const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit += 1) {
		crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return crc >>> 0;
});

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export function sha256(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function inspectPng(buffer, label = "PNG") {
	if (!Buffer.isBuffer(buffer)) {
		throw new ContractError(`${label} must be read as bytes`);
	}
	if (buffer.length < 57 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
		throw new ContractError(`${label} does not have a valid PNG signature`);
	}
	let offset = 8;
	let width;
	let height;
	let sawIdat = false;
	let sawIend = false;
	let chunkIndex = 0;
	while (offset < buffer.length) {
		if (buffer.length - offset < 12) {
			throw new ContractError(`${label} has a truncated PNG chunk header`);
		}
		const length = buffer.readUInt32BE(offset);
		if (length > buffer.length - offset - 12) {
			throw new ContractError(`${label} has a truncated PNG chunk`);
		}
		const typeStart = offset + 4;
		const dataStart = offset + 8;
		const crcOffset = dataStart + length;
		const type = buffer.toString("ascii", typeStart, dataStart);
		if (!/^[A-Za-z]{4}$/.test(type)) {
			throw new ContractError(`${label} has an invalid PNG chunk type`);
		}
		const expectedCrc = buffer.readUInt32BE(crcOffset);
		const actualCrc = crc32(buffer.subarray(typeStart, crcOffset));
		if (actualCrc !== expectedCrc) {
			throw new ContractError(`${label} has an invalid ${type} chunk checksum`);
		}

		if (chunkIndex === 0) {
			if (type !== "IHDR" || length !== 13) {
				throw new ContractError(
					`${label} does not begin with a valid IHDR chunk`,
				);
			}
			width = buffer.readUInt32BE(dataStart);
			height = buffer.readUInt32BE(dataStart + 4);
			if (width === 0 || height === 0) {
				throw new ContractError(`${label} has invalid zero dimensions`);
			}
			const bitDepth = buffer[dataStart + 8];
			const colorType = buffer[dataStart + 9];
			const validDepths = new Map([
				[0, new Set([1, 2, 4, 8, 16])],
				[2, new Set([8, 16])],
				[3, new Set([1, 2, 4, 8])],
				[4, new Set([8, 16])],
				[6, new Set([8, 16])],
			]);
			if (!validDepths.get(colorType)?.has(bitDepth)) {
				throw new ContractError(
					`${label} has an invalid PNG color type/bit depth`,
				);
			}
			if (
				buffer[dataStart + 10] !== 0 ||
				buffer[dataStart + 11] !== 0 ||
				!new Set([0, 1]).has(buffer[dataStart + 12])
			) {
				throw new ContractError(`${label} has unsupported PNG header methods`);
			}
		} else if (type === "IHDR") {
			throw new ContractError(`${label} repeats its IHDR chunk`);
		}

		if (type === "IDAT") sawIdat = true;
		if (type === "IEND") {
			if (length !== 0)
				throw new ContractError(`${label} has an invalid IEND chunk`);
			sawIend = true;
			if (crcOffset + 4 !== buffer.length) {
				throw new ContractError(`${label} has bytes after its IEND chunk`);
			}
		}
		offset = crcOffset + 4;
		chunkIndex += 1;
	}
	if (!sawIdat || !sawIend) {
		throw new ContractError(`${label} must contain IDAT and IEND chunks`);
	}
	return { width, height };
}
