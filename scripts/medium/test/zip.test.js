import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { readZipEntries } from "../lib/zip.js";

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit += 1)
		crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry({
	name = "posts/story.html",
	contents = Buffer.from("<h1>Story</h1>"),
	method = 0,
	externalAttributes = 0,
	declaredCrc = crc32(contents),
	declaredSize = contents.length,
} = {}) {
	const nameBytes = Buffer.from(name, "utf8");
	const compressed = method === 8 ? deflateRawSync(contents) : contents;
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(0x800, 6);
	local.writeUInt16LE(method, 8);
	local.writeUInt32LE(declaredCrc, 14);
	local.writeUInt32LE(compressed.length, 18);
	local.writeUInt32LE(declaredSize, 22);
	local.writeUInt16LE(nameBytes.length, 26);

	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(0x800, 8);
	central.writeUInt16LE(method, 10);
	central.writeUInt32LE(declaredCrc, 16);
	central.writeUInt32LE(compressed.length, 20);
	central.writeUInt32LE(declaredSize, 24);
	central.writeUInt16LE(nameBytes.length, 28);
	central.writeUInt32LE(externalAttributes >>> 0, 38);

	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + nameBytes.length, 12);
	end.writeUInt32LE(local.length + nameBytes.length + compressed.length, 16);

	return Buffer.concat([local, nameBytes, compressed, central, nameBytes, end]);
}

test("ZIP reader accepts one bounded UTF-8 entry", () => {
	const entries = readZipEntries(zipEntry());
	assert.equal(entries.get("posts/story.html").toString(), "<h1>Story</h1>");
});

test("ZIP reader rejects traversal, links, and corrupt bytes", () => {
	assert.throws(
		() => readZipEntries(zipEntry({ name: "posts/../escape.html" })),
		/unsafe|non-normalized/u,
	);
	assert.throws(
		() =>
			readZipEntries(zipEntry({ externalAttributes: (0o120777 << 16) >>> 0 })),
		/symbolic link/u,
	);
	assert.throws(() => readZipEntries(zipEntry({ declaredCrc: 0 })), /CRC-32/u);
});

test("ZIP reader caps declared and actual expansion", () => {
	assert.throws(
		() => readZipEntries(zipEntry({ declaredSize: 33 * 1024 * 1024 })),
		/safety limit/u,
	);
	const expanded = Buffer.alloc(33 * 1024 * 1024, 0x61);
	assert.throws(
		() =>
			readZipEntries(
				zipEntry({ contents: expanded, method: 8, declaredSize: 1 }),
			),
		/could not be decompressed|unexpected uncompressed size/u,
	);
});
