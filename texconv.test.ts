import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { convertToDDS } from './texconv.js';

const identifier = Buffer.from([0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]);

function blocks(width: number, height: number, block: Buffer): Buffer {
	return Buffer.concat(Array.from({ length: Math.ceil(width / 4) * Math.ceil(height / 4) }, () => block));
}

function ktx(format: number, width: number, height: number, mips: Buffer[]): Buffer {
	const header = Buffer.alloc(80 + 24 * mips.length);
	identifier.copy(header);
	header.writeUInt32LE(format, 12);
	header.writeUInt32LE(1, 16);
	header.writeUInt32LE(width, 20);
	header.writeUInt32LE(height, 24);
	header.writeUInt32LE(1, 36);
	header.writeUInt32LE(mips.length, 40);
	// KTX2 often stores the smallest mip first, unlike DDS.
	let offset = header.length;
	for (let mip = mips.length - 1; mip >= 0; mip--) {
		header.writeBigUInt64LE(BigInt(offset), 80 + mip * 24);
		header.writeBigUInt64LE(BigInt(mips[mip].length), 88 + mip * 24);
		header.writeBigUInt64LE(BigInt(mips[mip].length), 96 + mip * 24);
		offset += mips[mip].length;
	}
	return Buffer.concat([header, ...mips.slice().reverse()]);
}

function dds(width: number, height: number, mips: Buffer[], fourCc: string, dxgi?: number): Buffer {
	const header = Buffer.alloc(dxgi === undefined ? 128 : 148);
	header.write('DDS ', 0);
	header.writeUInt32LE(124, 4);
	header.writeUInt32LE(0x81007 | (mips.length > 1 ? 0x20000 : 0), 8);
	header.writeUInt32LE(height, 12);
	header.writeUInt32LE(width, 16);
	header.writeUInt32LE(mips[0].length, 20);
	header.writeUInt32LE(mips.length, 28);
	header.writeUInt32LE(32, 76);
	header.writeUInt32LE(4, 80);
	header.write(dxgi === undefined ? fourCc : 'DX10', 84);
	header.writeUInt32LE(0x1000 | (mips.length > 1 ? 0x400008 : 0), 108);
	if (dxgi !== undefined) {
		header.writeUInt32LE(dxgi, 128);
		header.writeUInt32LE(3, 132);
		header.writeUInt32LE(1, 140);
	}
	return Buffer.concat([header, ...mips]);
}

function convert(input: Buffer, extension: string, cap: number = 2048): Buffer {
	const root = fs.mkdtempSync(path.join(tmpdir(), 'scone-texture-'));
	try {
		const source = path.join(root, `source.${extension}`);
		const output = path.join(root, 'nested', 'output.dds');
		fs.writeFileSync(source, input);
		convertToDDS(source, output, cap);
		assert.deepEqual(fs.readdirSync(path.dirname(output)), ['output.dds']);
		return fs.readFileSync(output);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function assertDimensions(data: Buffer, width: number, height: number, mips: number): void {
	assert.equal(data.readUInt32LE(16), width);
	assert.equal(data.readUInt32LE(12), height);
	assert.equal(data.readUInt32LE(28), mips);
	assert.equal(data.readUInt32LE(4), 124);
	assert.equal(data.readUInt32LE(76), 32);
}

const redBc1 = Buffer.from([0x00, 0xF8, 0, 0, 0, 0, 0, 0]);

for (const [vk, dxgi, fourCc, size] of [
	[131, 71, 'DXT1', 8], [132, 72, 'DXT1', 8], [133, 71, 'DXT1', 8], [134, 72, 'DXT1', 8],
	[135, 74, 'DXT3', 16], [136, 75, 'DXT3', 16], [137, 77, 'DXT5', 16], [138, 78, 'DXT5', 16],
] as const) {
	test(`KTX2 format ${vk} and DX10 DDS ${dxgi} export legacy ${fourCc}, preserving compressed pixels`, () => {
		const mips = [Buffer.alloc(size * 4, 21), Buffer.alloc(size, 42), Buffer.alloc(size, 63)];
		for (const [input, extension] of [[ktx(vk, 8, 8, mips), 'ktx2'], [dds(8, 8, mips, '', dxgi), 'dds']] as const) {
			const result = convert(input, extension, 4);
			assertDimensions(result, 4, 4, 2);
			assert.equal(result.toString('ascii', 84, 88), fourCc);
			assert.equal(result.readUInt32LE(20), size);
			assert.equal(result.readUInt32LE(8), 0xA1007);
			assert.equal(result.readUInt32LE(108), 0x401008);
			assert.deepEqual(result.subarray(128), Buffer.concat(mips.slice(1)));
		}
	});
}

test('cap retains rectangular mip dimensions and never upscales', () => {
	const mips = [blocks(16, 4, redBc1), blocks(8, 2, redBc1), blocks(4, 1, redBc1)];
	const input = ktx(131, 16, 4, mips);
	assertDimensions(convert(input, 'ktx2', 8), 8, 2, 2);
	assertDimensions(convert(input, 'ktx2', 32), 16, 4, 3);
	assertDimensions(convert(dds(16, 4, mips, 'DXT1'), 'dds', 8), 8, 2, 2);
});

test('short mip chains decode, resize and generate legacy BGRA mips', () => {
	for (const extension of ['ktx2', 'dds']) {
		const mip = blocks(9, 5, redBc1);
		const input = extension === 'ktx2' ? ktx(131, 9, 5, [mip]) : dds(9, 5, [mip], 'DXT1');
		const output = convert(input, extension, 4);
		assertDimensions(output, 4, 2, 3);
		assert.equal(output.readUInt32LE(80), 0x41);
		assert.equal(output.readUInt32LE(92), 0x00FF0000);
		assert.equal(output.length, 128 + (8 + 2 + 1) * 4);
		for (let offset = 128; offset < output.length; offset += 4) {
			assert.deepEqual([...output.subarray(offset, offset + 4)], [0, 0, 255, 255]);
		}
	}
});

function redBc7(alpha: number = 127): Buffer {
	const block = Buffer.alloc(16);
	let bit = 0;
	const write = (value: number, count: number): void => {
		for (let index = 0; index < count; index++, bit++) block[Math.floor(bit / 8)] |= ((value >> index) & 1) << (bit % 8);
	};
	write(64, 7); // Mode 6: two RGBA endpoints, 7 bits per component and endpoint p-bits.
	for (const component of [127, 0, 0, alpha]) { write(component, 7); write(component, 7); }
	write(1, 1); write(1, 1);
	// All interpolation indices are zero; both endpoints equal (255, 1, 1, 255).
	return block;
}

for (const [vk, dxgi] of [[145, 98], [146, 99]]) {
	test(`BC7 ${vk} decodes to legacy BGRA with alpha and sub-block mips`, () => {
		const mips = [blocks(5, 3, redBc7()), redBc7(), redBc7()];
		for (const [input, extension] of [[ktx(vk, 5, 3, mips), 'ktx2'], [dds(5, 3, mips, '', dxgi), 'dds']] as const) {
			const output = convert(input, extension);
			assertDimensions(output, 5, 3, 3);
			assert.equal(output.readUInt32LE(84), 0);
			assert.equal(output.length, 128 + (15 + 2 + 1) * 4);
			for (let offset = 128; offset < output.length; offset += 4) {
				assert.deepEqual([...output.subarray(offset, offset + 4)], [1, 1, 255, 255]);
			}
			assertDimensions(convert(input, extension, 1), 1, 1, 1);
		}
	});
}

test('BC5 signed normal maps retain reconstructed blue channel and are capped', () => {
	const flat = Buffer.alloc(16);
	const mips = [blocks(8, 4, flat), flat, flat];
	for (const [input, extension] of [[ktx(142, 8, 4, mips), 'ktx2'], [dds(8, 4, mips, 'BC5S'), 'dds'], [dds(8, 4, mips, '', 84), 'dds']] as const) {
		const output = convert(input, extension, 4);
		assertDimensions(output, 4, 2, 2);
		assert.equal(output.readUInt32LE(84), 0);
		assert.deepEqual([...output.subarray(128, 132)], [255, 128, 128, 255]);
	}
	assertDimensions(convert(ktx(142, 8, 4, [mips[0]]), 'ktx2', 2), 2, 1, 2);
});

test('BC2, BC3 and BC7 resizing preserves non-opaque alpha', () => {
	const bc2 = Buffer.concat([Buffer.alloc(8, 0x22), redBc1]);
	const bc3 = Buffer.concat([Buffer.from([34, 34, 0, 0, 0, 0, 0, 0]), redBc1]);
	for (const [vk, block, alpha] of [[135, bc2, 34], [137, bc3, 34], [145, redBc7(63), 127]] as const) {
		const result = convert(ktx(vk, 4, 4, [block]), 'ktx2', 2);
		assertDimensions(result, 2, 2, 2);
		for (let offset = 128; offset < result.length; offset += 4) assert.equal(result[offset + 3], alpha);
	}
});

test('BC7 interpolation indices preserve pixel order', () => {
	const block = Buffer.alloc(16);
	let bit = 0;
	const write = (value: number, count: number): void => {
		for (let index = 0; index < count; index++, bit++) block[Math.floor(bit / 8)] |= ((value >> index) & 1) << (bit % 8);
	};
	write(64, 7);
	for (const component of [127, 0, 0, 0, 0, 127, 127, 127]) write(component, 7);
	write(0, 1); write(0, 1);
	write(0, 3); // The anchor pixel omits the high index bit.
	for (let pixel = 1; pixel < 16; pixel++) write(pixel, 4);
	assert.equal(bit, 128);
	const output = convert(ktx(145, 4, 4, [block]), 'ktx2');
	const weights = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
	for (let pixel = 0; pixel < 16; pixel++) {
		assert.deepEqual([...output.subarray(128 + pixel * 4, 132 + pixel * 4)], [
			Math.floor((weights[pixel] * 254 + 32) / 64), 0,
			Math.floor(((64 - weights[pixel]) * 254 + 32) / 64), 254,
		]);
	}
});

test('BC4 unsigned/signed and BC5 unsigned avoid DX10 headers', () => {
	for (const [vk, bytes] of [[139, 8], [140, 8], [141, 16]]) {
		const output = convert(ktx(vk, 4, 4, [Buffer.alloc(bytes)]), 'ktx2');
		assertDimensions(output, 4, 4, 1);
		assert.equal(output.readUInt32LE(80), 0x41);
		assert.equal(output.length, 192);
	}
});

function rgbaDds(width: number, height: number, mips: Buffer[]): Buffer {
	const input = dds(width, height, mips, '');
	input.writeUInt32LE(0x100F | (mips.length > 1 ? 0x20000 : 0), 8);
	input.writeUInt32LE(width * 4, 20);
	input.writeUInt32LE(0x41, 80);
	input.writeUInt32LE(32, 88);
	[0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000].forEach((mask, index) => input.writeUInt32LE(mask, 92 + index * 4));
	return input;
}

test('uncompressed DDS caps using existing mips or area-averaged fallback, retaining alpha', () => {
	const mips = [Buffer.alloc(8 * 4 * 4, 180), Buffer.alloc(4 * 2 * 4, 60)];
	const input = rgbaDds(8, 4, mips);
	assert.deepEqual(convert(input, 'dds', 8), input);
	const output = convert(input, 'dds', 4);
	assertDimensions(output, 4, 2, 1);
	assert.deepEqual(output.subarray(128), mips[1]);
	const resized = convert(rgbaDds(8, 4, [mips[0]]), 'dds', 3);
	assertDimensions(resized, 3, 1, 2);
	assert.deepEqual(resized.subarray(128), Buffer.alloc(16, 180));
	const averaged = convert(rgbaDds(2, 1, [Buffer.from([0, 0, 0, 0, 200, 100, 50, 200])]), 'dds', 1);
	assert.deepEqual([...averaged.subarray(128)], [100, 50, 25, 100]);
});

test('DX10 RGBA8 is rewritten with legacy channel masks', () => {
	const output = convert(dds(1, 1, [Buffer.from([255, 20, 10, 40])], '', 28), 'dds');
	assertDimensions(output, 1, 1, 1);
	assert.deepEqual([...output.subarray(128)], [10, 20, 255, 40]);
});

test('invalid caps and malformed texture payloads fail explicitly', () => {
	for (const cap of [0, -1, NaN, Infinity, 1.5, 16385]) {
		assert.throws(() => convert(ktx(131, 4, 4, [redBc1]), 'ktx2', cap), /Maximum texture size/);
	}
	const truncated = ktx(131, 4, 4, [redBc1]).subarray(0, 108);
	assert.throws(() => convert(truncated, 'ktx2'), /extends beyond/);
	const supercompressed = ktx(131, 4, 4, [redBc1]);
	supercompressed.writeUInt32LE(2, 44);
	assert.throws(() => convert(supercompressed, 'ktx2'), /supercompression/);
	assert.throws(() => convert(dds(4, 4, [redBc1], '', 71).subarray(0, 140), 'dds'), /Truncated DDS DX10/);
	assert.throws(() => convert(dds(4, 4, [redBc1], 'DXT1').subarray(0, 130), 'dds'), /extends beyond/);
});

test('DDS conversion supports in-place writes', () => {
	const root = fs.mkdtempSync(path.join(tmpdir(), 'scone-texture-inplace-'));
	try {
		const filename = path.join(root, 'image.dds');
		fs.writeFileSync(filename, dds(4, 4, [redBc1], '', 71));
		convertToDDS(filename, filename, 4);
		assert.equal(fs.readFileSync(filename).toString('ascii', 84, 88), 'DXT1');
		assert.deepEqual(fs.readdirSync(root), ['image.dds']);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});