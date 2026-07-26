import { inflateRawSync } from "node:zlib";
import { MediumContractError } from "./contract.js";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_COUNT = 10_000;

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

function decodeUtf8(buffer, label) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch (error) {
		throw new MediumContractError(`${label} is not valid UTF-8`, {
			cause: error,
		});
	}
}

function decodeEntryName(buffer, flags, label) {
	if ((flags & 0x800) !== 0) return decodeUtf8(buffer, label);
	if (buffer.some((byte) => byte < 0x20 || byte > 0x7e)) {
		throw new MediumContractError(
			`${label} has no UTF-8 flag and must use printable ASCII bytes`,
		);
	}
	const decoded = buffer.toString("ascii");
	if (!Buffer.from(decoded, "ascii").equals(buffer)) {
		throw new MediumContractError(
			`${label} has an ambiguous legacy filename encoding`,
		);
	}
	return decoded;
}

function normalizedEntryName(name) {
	if (
		name.length === 0 ||
		name.includes("\0") ||
		name.includes("\\") ||
		name.startsWith("/") ||
		/^[A-Za-z]:/u.test(name)
	) {
		throw new MediumContractError(
			`ZIP entry has an unsafe path: ${JSON.stringify(name)}`,
		);
	}
	const segments = name.split("/");
	const isDirectory = segments.at(-1) === "";
	const meaningfulSegments = isDirectory ? segments.slice(0, -1) : segments;
	if (
		meaningfulSegments.length === 0 ||
		meaningfulSegments.some(
			(segment) => segment === "" || segment === "." || segment === "..",
		)
	) {
		throw new MediumContractError(
			`ZIP entry has a non-normalized path: ${JSON.stringify(name)}`,
		);
	}
	return { name: meaningfulSegments.join("/"), isDirectory };
}

function findEndRecord(buffer) {
	const minimumOffset = Math.max(0, buffer.length - 65_557);
	for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
		if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
			const commentLength = buffer.readUInt16LE(offset + 20);
			if (offset + 22 + commentLength === buffer.length) return offset;
		}
	}
	throw new MediumContractError(
		"Medium export is not a supported single-disk ZIP archive",
	);
}

function assertRange(buffer, offset, length, label) {
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		offset < 0 ||
		length < 0 ||
		offset > buffer.length - length
	) {
		throw new MediumContractError(`${label} is truncated or out of bounds`);
	}
}

function readEntry(buffer, centralEntry, centralOffset) {
	const {
		name,
		flags,
		method,
		crc,
		compressedSize,
		uncompressedSize,
		localOffset,
	} = centralEntry;
	assertRange(buffer, localOffset, 30, `ZIP local header for ${name}`);
	if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
		throw new MediumContractError(`ZIP local header is invalid for ${name}`);
	}
	const localFlags = buffer.readUInt16LE(localOffset + 6);
	const localMethod = buffer.readUInt16LE(localOffset + 8);
	const localNameLength = buffer.readUInt16LE(localOffset + 26);
	const localExtraLength = buffer.readUInt16LE(localOffset + 28);
	if (localFlags !== flags || localMethod !== method) {
		throw new MediumContractError(
			`ZIP local and central headers disagree for ${name}`,
		);
	}
	const localNameStart = localOffset + 30;
	assertRange(
		buffer,
		localNameStart,
		localNameLength + localExtraLength,
		`ZIP local metadata for ${name}`,
	);
	const localName = decodeEntryName(
		buffer.subarray(localNameStart, localNameStart + localNameLength),
		flags,
		`ZIP local filename for ${name}`,
	);
	if (localName !== name) {
		throw new MediumContractError(
			`ZIP local filename does not match its central entry for ${name}`,
		);
	}
	const dataStart = localNameStart + localNameLength + localExtraLength;
	assertRange(buffer, dataStart, compressedSize, `ZIP data for ${name}`);
	if (dataStart + compressedSize > centralOffset) {
		throw new MediumContractError(
			`ZIP data overlaps its central directory for ${name}`,
		);
	}
	const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
	let contents;
	try {
		if (method === 0) contents = Buffer.from(compressed);
		else if (method === 8)
			contents = inflateRawSync(compressed, {
				maxOutputLength: MAX_ENTRY_BYTES,
			});
		else {
			throw new MediumContractError(
				`ZIP entry ${name} uses unsupported compression method ${method}`,
			);
		}
	} catch (error) {
		if (error instanceof MediumContractError) throw error;
		throw new MediumContractError(
			`ZIP entry ${name} could not be decompressed`,
			{
				cause: error,
			},
		);
	}
	if (contents.length !== uncompressedSize) {
		throw new MediumContractError(
			`ZIP entry ${name} has an unexpected uncompressed size`,
		);
	}
	if (crc32(contents) !== crc) {
		throw new MediumContractError(`ZIP entry ${name} failed its CRC-32 check`);
	}
	return contents;
}

export function readZipEntries(buffer) {
	if (!Buffer.isBuffer(buffer)) {
		throw new MediumContractError("Medium export ZIP must be read as bytes");
	}
	if (buffer.length > MAX_ARCHIVE_BYTES) {
		throw new MediumContractError(
			`Medium export ZIP exceeds the ${MAX_ARCHIVE_BYTES}-byte safety limit`,
		);
	}
	if (buffer.length < 22) {
		throw new MediumContractError("Medium export ZIP is truncated");
	}
	const endOffset = findEndRecord(buffer);
	const diskNumber = buffer.readUInt16LE(endOffset + 4);
	const centralDisk = buffer.readUInt16LE(endOffset + 6);
	const diskEntryCount = buffer.readUInt16LE(endOffset + 8);
	const totalEntryCount = buffer.readUInt16LE(endOffset + 10);
	const centralSize = buffer.readUInt32LE(endOffset + 12);
	const centralOffset = buffer.readUInt32LE(endOffset + 16);
	if (
		diskNumber !== 0 ||
		centralDisk !== 0 ||
		diskEntryCount !== totalEntryCount
	) {
		throw new MediumContractError("Multi-disk ZIP archives are not supported");
	}
	if (
		totalEntryCount === 0xffff ||
		centralSize === 0xffffffff ||
		centralOffset === 0xffffffff
	) {
		throw new MediumContractError("ZIP64 Medium exports are not supported");
	}
	if (totalEntryCount > MAX_ENTRY_COUNT) {
		throw new MediumContractError(
			`Medium export contains more than ${MAX_ENTRY_COUNT} entries`,
		);
	}
	assertRange(buffer, centralOffset, centralSize, "ZIP central directory");
	if (centralOffset + centralSize !== endOffset) {
		throw new MediumContractError(
			"ZIP central directory has an unexpected layout",
		);
	}

	const entries = new Map();
	let cursor = centralOffset;
	let totalUncompressedBytes = 0;
	for (let index = 0; index < totalEntryCount; index += 1) {
		assertRange(buffer, cursor, 46, `ZIP central entry ${index}`);
		if (buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER) {
			throw new MediumContractError(`ZIP central entry ${index} is invalid`);
		}
		const flags = buffer.readUInt16LE(cursor + 8);
		const method = buffer.readUInt16LE(cursor + 10);
		const crc = buffer.readUInt32LE(cursor + 16);
		const compressedSize = buffer.readUInt32LE(cursor + 20);
		const uncompressedSize = buffer.readUInt32LE(cursor + 24);
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const diskStart = buffer.readUInt16LE(cursor + 34);
		const externalAttributes = buffer.readUInt32LE(cursor + 38);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const recordLength = 46 + nameLength + extraLength + commentLength;
		assertRange(buffer, cursor, recordLength, `ZIP central entry ${index}`);
		if ((flags & 0x1) !== 0) {
			throw new MediumContractError("Encrypted ZIP entries are not supported");
		}
		if (diskStart !== 0) {
			throw new MediumContractError("Multi-disk ZIP entries are not supported");
		}
		if (
			compressedSize === 0xffffffff ||
			uncompressedSize === 0xffffffff ||
			localOffset === 0xffffffff
		) {
			throw new MediumContractError("ZIP64 entries are not supported");
		}
		if (uncompressedSize > MAX_ENTRY_BYTES) {
			throw new MediumContractError(
				`ZIP entry ${index} exceeds the ${MAX_ENTRY_BYTES}-byte safety limit`,
			);
		}
		totalUncompressedBytes += uncompressedSize;
		if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
			throw new MediumContractError(
				`Medium export exceeds the ${MAX_TOTAL_UNCOMPRESSED_BYTES}-byte expanded safety limit`,
			);
		}
		const decodedName = decodeEntryName(
			buffer.subarray(cursor + 46, cursor + 46 + nameLength),
			flags,
			`ZIP filename ${index}`,
		);
		const { name, isDirectory } = normalizedEntryName(decodedName);
		const unixMode = externalAttributes >>> 16;
		if ((unixMode & 0o170000) === 0o120000) {
			throw new MediumContractError(`ZIP entry ${name} is a symbolic link`);
		}
		if (!isDirectory) {
			if (entries.has(name)) {
				throw new MediumContractError(`ZIP repeats entry ${name}`);
			}
			entries.set(
				name,
				readEntry(
					buffer,
					{
						name: decodedName,
						flags,
						method,
						crc,
						compressedSize,
						uncompressedSize,
						localOffset,
					},
					centralOffset,
				),
			);
		}
		cursor += recordLength;
	}
	if (cursor !== centralOffset + centralSize) {
		throw new MediumContractError(
			"ZIP central-directory entry count does not match its declared size",
		);
	}
	return entries;
}
