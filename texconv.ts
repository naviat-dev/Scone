import * as fs from 'fs';
import * as path from 'path';
import { decodeBC1, decodeBC2, decodeBC3, decodeBC7, decodeDXT2, decodeDXT4 } from 'tex-decoder';

const KTX2_IDENTIFIER = Buffer.from([0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]);
const KTX2_HEADER_SIZE = 80;
const KTX2_LEVEL_SIZE = 24;
const DDS_HEADER_SIZE = 148;
const LEGACY_DDS_HEADER_SIZE = 128;

const DDS_MAGIC = 0x20534444;
const DDS_HEADER_FLAGS = 0x00001007;
const DDS_HEADER_LINEAR_SIZE = 0x00080000;
const DDS_HEADER_MIPMAP_COUNT = 0x00020000;
const DDS_HEADER_PITCH = 0x00000008;
const DDS_PIXEL_FORMAT_FOUR_CC = 0x00000004;
const DDS_PIXEL_FORMAT_RGBA = 0x00000041;
const DDS_CAPS_COMPLEX = 0x00000008;
const DDS_CAPS_TEXTURE = 0x00001000;
const DDS_CAPS_MIPMAP = 0x00400000;
const DDS_RESOURCE_DIMENSION_TEXTURE_2D = 3;

type DdsFormat = {
	dxgiFormat: number;
	bytesPerBlock: number;
};

type KtxLevel = {
	offset: bigint;
	length: bigint;
};

const DDS_FORMATS = new Map<number, DdsFormat>([
	[131, { dxgiFormat: 71, bytesPerBlock: 8 }],  // BC1_RGB_UNORM -> BC1_UNORM
	[132, { dxgiFormat: 72, bytesPerBlock: 8 }],  // BC1_RGB_SRGB -> BC1_UNORM_SRGB
	[133, { dxgiFormat: 71, bytesPerBlock: 8 }],  // BC1_RGBA_UNORM -> BC1_UNORM
	[134, { dxgiFormat: 72, bytesPerBlock: 8 }],  // BC1_RGBA_SRGB -> BC1_UNORM_SRGB
	[135, { dxgiFormat: 74, bytesPerBlock: 16 }], // BC2_UNORM
	[136, { dxgiFormat: 75, bytesPerBlock: 16 }], // BC2_UNORM_SRGB
	[137, { dxgiFormat: 77, bytesPerBlock: 16 }], // BC3_UNORM
	[138, { dxgiFormat: 78, bytesPerBlock: 16 }], // BC3_UNORM_SRGB
	[139, { dxgiFormat: 80, bytesPerBlock: 8 }],  // BC4_UNORM
	[140, { dxgiFormat: 81, bytesPerBlock: 8 }],  // BC4_SNORM
	[141, { dxgiFormat: 83, bytesPerBlock: 16 }], // BC5_UNORM
	[142, { dxgiFormat: 84, bytesPerBlock: 16 }], // BC5_SNORM
	[145, { dxgiFormat: 98, bytesPerBlock: 16 }], // BC7_UNORM
	[146, { dxgiFormat: 99, bytesPerBlock: 16 }], // BC7_UNORM_SRGB
]);

export function convertToDDS(inputPath: string, outputPath: string, maxSize: number = 2048): void {
	if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > 16384) {
		throw new Error('Maximum texture size must be a whole number from 1 to 16384.');
	}
	const extension = path.extname(inputPath).toLowerCase();
	if (extension === '.dds') {
		convertDds(inputPath, outputPath, maxSize);
		return;
	}
	if (extension !== '.ktx2') {
		throw new Error(`Unsupported texture format: ${extension || '(none)'}`);
	}

	const input = fs.readFileSync(inputPath);
	if (input.length < KTX2_HEADER_SIZE || !input.subarray(0, KTX2_IDENTIFIER.length).equals(KTX2_IDENTIFIER)) {
		throw new Error(`Not a valid KTX2 file: ${inputPath}`);
	}

	const vkFormat = input.readUInt32LE(12);
	const typeSize = input.readUInt32LE(16);
	const width = input.readUInt32LE(20);
	const height = input.readUInt32LE(24);
	const depth = input.readUInt32LE(28);
	const layerCount = input.readUInt32LE(32);
	const faceCount = input.readUInt32LE(36);
	const declaredLevelCount = input.readUInt32LE(40);
	const supercompressionScheme = input.readUInt32LE(44);
	const levelCount = declaredLevelCount || 1;
	const format = DDS_FORMATS.get(vkFormat);

	if (!format) {
		throw new Error(`Unsupported KTX2 Vulkan format ${vkFormat}: ${inputPath}`);
	}
	if (typeSize !== 1 || width === 0 || height === 0) {
		throw new Error(`KTX2 has invalid dimensions or type size: ${inputPath}`);
	}
	if (depth !== 0 || layerCount > 1 || faceCount !== 1) {
		throw new Error(`Only single 2D KTX2 textures are supported: ${inputPath}`);
	}
	if (supercompressionScheme !== 0) {
		throw new Error(`KTX2 supercompression scheme ${supercompressionScheme} is not supported: ${inputPath}`);
	}
	if (levelCount > 32 || KTX2_HEADER_SIZE + levelCount * KTX2_LEVEL_SIZE > input.length) {
		throw new Error(`KTX2 has an invalid mip level index: ${inputPath}`);
	}

	const levels: KtxLevel[] = [];
	for (let mip = 0; mip < levelCount; mip++) {
		const indexOffset = KTX2_HEADER_SIZE + mip * KTX2_LEVEL_SIZE;
		const offset = input.readBigUInt64LE(indexOffset);
		const length = input.readBigUInt64LE(indexOffset + 8);
		const uncompressedLength = input.readBigUInt64LE(indexOffset + 16);
		const expectedLength = getMipSize(width, height, mip, format.bytesPerBlock);

		if (length !== expectedLength || uncompressedLength !== expectedLength) {
			throw new Error(
				`KTX2 mip ${mip} contains ${length} bytes; expected ${expectedLength} for ${width}x${height}, format ${vkFormat}: ${inputPath}`,
			);
		}
		if (offset > BigInt(input.length) || length > BigInt(input.length) - offset) {
			throw new Error(`KTX2 mip ${mip} extends beyond the file: ${inputPath}`);
		}
		levels.push({ offset, length });
	}

	const mipData = levels.map(({ offset, length }) => {
		const start = toSafeNumber(offset, 'mip offset');
		const end = toSafeNumber(offset + length, 'mip end');
		return input.subarray(start, end);
	});
	writeCompressedTexture(outputPath, width, height, mipData, format, maxSize);
}

function getMipSize(width: number, height: number, mip: number, bytesPerBlock: number): bigint {
	const mipWidth = Math.max(1, Math.floor(width / (2 ** mip)));
	const mipHeight = Math.max(1, Math.floor(height / (2 ** mip)));
	const blocksWide = Math.max(1, Math.ceil(mipWidth / 4));
	const blocksHigh = Math.max(1, Math.ceil(mipHeight / 4));
	return BigInt(blocksWide * blocksHigh * bytesPerBlock);
}

function createCompressedDdsHeader(width: number, height: number, mipCount: number, format: DdsFormat): Buffer {
	const fourCc = legacyFourCc(format.dxgiFormat);
	if (!fourCc) throw new Error(`No legacy DDS header for DXGI format ${format.dxgiFormat}`);
	const header = Buffer.alloc(LEGACY_DDS_HEADER_SIZE);
	let offset = 0;
	const write = (value: number): void => {
		header.writeUInt32LE(value, offset);
		offset += 4;
	};

	write(DDS_MAGIC);
	write(124);
	write(DDS_HEADER_FLAGS | DDS_HEADER_LINEAR_SIZE | (mipCount > 1 ? DDS_HEADER_MIPMAP_COUNT : 0));
	write(height);
	write(width);
	write(Number(getMipSize(width, height, 0, format.bytesPerBlock)));
	write(0);
	write(mipCount);
	for (let index = 0; index < 11; index++) write(0);
	write(32);
	write(DDS_PIXEL_FORMAT_FOUR_CC);
	write(Buffer.from(fourCc).readUInt32LE(0));
	for (let index = 0; index < 5; index++) write(0);
	write(DDS_CAPS_TEXTURE | (mipCount > 1 ? DDS_CAPS_COMPLEX | DDS_CAPS_MIPMAP : 0));
	for (let index = 0; index < 4; index++) write(0);
	return header;
}

function convertDds(inputPath: string, outputPath: string, maxSize: number): void {
	const input = fs.readFileSync(inputPath);
	if (input.length < LEGACY_DDS_HEADER_SIZE || input.readUInt32LE(0) !== DDS_MAGIC || input.readUInt32LE(4) !== 124) {
		throw new Error(`Not a valid DDS file: ${inputPath}`);
	}

	const height = input.readUInt32LE(12);
	const width = input.readUInt32LE(16);
	const mipCount = input.readUInt32LE(28) || 1;
	const fourCc = input.toString('ascii', 84, 88);
	const hasDx10Header = fourCc === 'DX10';
	if (width === 0 || height === 0 || mipCount > 32) {
		throw new Error(`DDS has invalid dimensions or mip count: ${inputPath}`);
	}
	if (input.readUInt32LE(112) !== 0 || input.readUInt32LE(24) > 1) {
		throw new Error(`Only single 2D DDS textures are supported: ${inputPath}`);
	}
	if (hasDx10Header) {
		if (input.length < DDS_HEADER_SIZE) throw new Error(`Truncated DDS DX10 header: ${inputPath}`);
		const resourceDimension = input.readUInt32LE(132);
		const arraySize = input.readUInt32LE(140);
		if (resourceDimension !== DDS_RESOURCE_DIMENSION_TEXTURE_2D || arraySize !== 1 || (input.readUInt32LE(136) & 4)) {
			throw new Error(`Only single 2D DDS textures are supported: ${inputPath}`);
		}
	}
	const legacyFormats: Record<string, number> = {
		DXT1: 71, DXT2: 74, DXT3: 74, DXT4: 77, DXT5: 77,
		ATI1: 80, BC4U: 80, BC4S: 81, ATI2: 83, BC5U: 83, BC5S: 84,
	};
	const dxgiFormat = hasDx10Header ? input.readUInt32LE(128) : legacyFormats[fourCc];
	const format = [...DDS_FORMATS.values()].find((candidate) => candidate.dxgiFormat === dxgiFormat);
	if (!format) {
		if (!hasDx10Header && Math.max(width, height) <= maxSize) {
			copyFileAtomically(inputPath, outputPath);
			return;
		}
		writeUncompressedDds(input, outputPath, width, height, mipCount, maxSize, hasDx10Header);
		return;
	}

	let offset = hasDx10Header ? DDS_HEADER_SIZE : LEGACY_DDS_HEADER_SIZE;
	const mipData: Buffer[] = [];
	for (let mip = 0; mip < mipCount; mip++) {
		const length = toSafeNumber(getMipSize(width, height, mip, format.bytesPerBlock), 'DDS mip length');
		if (offset + length > input.length) {
			throw new Error(`DDS mip ${mip} extends beyond the file: ${inputPath}`);
		}
		mipData.push(input.subarray(offset, offset + length));
		offset += length;
	}
	writeCompressedTexture(outputPath, width, height, mipData, format, maxSize, fourCc);
}

function legacyFourCc(dxgiFormat: number): string | undefined {
	if (dxgiFormat === 71 || dxgiFormat === 72) return 'DXT1';
	if (dxgiFormat === 74 || dxgiFormat === 75) return 'DXT3';
	if (dxgiFormat === 77 || dxgiFormat === 78) return 'DXT5';
	return undefined;
}

function mipDimension(size: number, mip: number): number {
	return Math.max(1, Math.floor(size / (2 ** mip)));
}

function firstCappedMip(width: number, height: number, count: number, maxSize: number): number {
	let mip = 0;
	while (mip < count - 1 && Math.max(mipDimension(width, mip), mipDimension(height, mip)) > maxSize) mip++;
	return mip;
}

function writeCompressedTexture(
	outputPath: string, width: number, height: number, mips: Buffer[], format: DdsFormat, maxSize: number, sourceFourCc?: string,
): void {
	const first = firstCappedMip(width, height, mips.length, maxSize);
	width = mipDimension(width, first);
	height = mipDimension(height, first);
	mips = mips.slice(first);
	const needsResize = Math.max(width, height) > maxSize;
	if (legacyFourCc(format.dxgiFormat) && !needsResize) {
		// Compressed blocks (including sRGB variants) are unchanged. Legacy DDS cannot encode the sRGB tag.
		const header = createCompressedDdsHeader(width, height, mips.length, format);
		if (sourceFourCc === 'DXT2' || sourceFourCc === 'DXT4') header.write(sourceFourCc, 84, 'ascii');
		writeFileAtomically(outputPath, Buffer.concat([header, ...mips]));
		return;
	}
	const decode = (data: Buffer, w: number, h: number): Buffer => decodeCompressedMip(data, w, h, format.dxgiFormat, sourceFourCc);
	if (needsResize) {
		writeResizedRgba(outputPath, decode(mips[0], width, height), width, height, maxSize);
		return;
	}
	const decoded = mips.map((data, mip) => decode(data, mipDimension(width, mip), mipDimension(height, mip)));
	writeFileAtomically(outputPath, Buffer.concat([createRgba8DdsHeader(width, height, decoded.length), ...decoded]));
}

function decodeCompressedMip(data: Buffer, width: number, height: number, format: number, fourCc?: string): Buffer {
	if (format >= 80 && format <= 84) {
		return decodeBcChannels(data, width, height, format === 81 || format === 84, format >= 83);
	}
	const decoder = fourCc === 'DXT2' ? decodeDXT2 : fourCc === 'DXT4' ? decodeDXT4
		: format === 71 || format === 72 ? decodeBC1
			: format === 74 || format === 75 ? decodeBC2
				: format === 77 || format === 78 ? decodeBC3 : decodeBC7;
	// Some decoders require complete 4x4 blocks, including the final sub-4x4 mip.
	const paddedWidth = Math.ceil(width / 4) * 4;
	const paddedHeight = Math.ceil(height / 4) * 4;
	const rgba = decoder(data, paddedWidth, paddedHeight);
	const bgra = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const source = (y * paddedWidth + x) * 4;
			const target = (y * width + x) * 4;
			bgra[target] = rgba[source + 2];
			bgra[target + 1] = rgba[source + 1];
			bgra[target + 2] = rgba[source];
			bgra[target + 3] = rgba[source + 3];
		}
	}
	return bgra;
}

function resizeBgra(data: Buffer, width: number, height: number, newWidth: number, newHeight: number): Buffer {
	const output = Buffer.alloc(newWidth * newHeight * 4);
	// Area averaging avoids aliasing and keeps all source pixels for non-power-of-two dimensions.
	for (let y = 0; y < newHeight; y++) {
		const top = y * height / newHeight;
		const bottom = (y + 1) * height / newHeight;
		for (let x = 0; x < newWidth; x++) {
			const left = x * width / newWidth;
			const right = (x + 1) * width / newWidth;
			const sums = [0, 0, 0, 0];
			let weight = 0;
			for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
				for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
					const area = (Math.min(right, sx + 1) - Math.max(left, sx)) * (Math.min(bottom, sy + 1) - Math.max(top, sy));
					const offset = (sy * width + sx) * 4;
					for (let channel = 0; channel < 4; channel++) sums[channel] += data[offset + channel] * area;
					weight += area;
				}
			}
			for (let channel = 0; channel < 4; channel++) output[(y * newWidth + x) * 4 + channel] = Math.round(sums[channel] / weight);
		}
	}
	return output;
}

function writeResizedRgba(outputPath: string, data: Buffer, width: number, height: number, maxSize: number): void {
	const scale = Math.min(1, maxSize / Math.max(width, height));
	const newWidth = Math.max(1, Math.floor(width * scale));
	const newHeight = Math.max(1, Math.floor(height * scale));
	const mips = [resizeBgra(data, width, height, newWidth, newHeight)];
	width = newWidth;
	height = newHeight;
	while (width > 1 || height > 1) {
		const nextWidth = mipDimension(width, 1);
		const nextHeight = mipDimension(height, 1);
		mips.push(resizeBgra(mips[mips.length - 1], width, height, nextWidth, nextHeight));
		width = nextWidth;
		height = nextHeight;
	}
	writeFileAtomically(outputPath, Buffer.concat([createRgba8DdsHeader(newWidth, newHeight, mips.length), ...mips]));
}

function writeUncompressedDds(
	input: Buffer, outputPath: string, width: number, height: number, mipCount: number, maxSize: number, dx10: boolean,
): void {
	let bits = input.readUInt32LE(88);
	let masks = [92, 96, 100, 104].map((offset) => input.readUInt32LE(offset));
	if (dx10) {
		const format = input.readUInt32LE(128);
		if (![28, 29, 87, 88, 91, 93].includes(format)) throw new Error(`Unsupported DDS DXGI format ${format}`);
		bits = 32;
		masks = format === 28 || format === 29
			? [0x000000FF, 0x0000FF00, 0x00FF0000, 0xFF000000]
			: [0x00FF0000, 0x0000FF00, 0x000000FF, format === 88 || format === 93 ? 0 : 0xFF000000];
	} else if ((input.readUInt32LE(80) & 0x40) === 0 || ![16, 24, 32].includes(bits)) {
		throw new Error('Cannot resize unsupported DDS pixel format');
	}
	const bytes = bits / 8;
	const first = firstCappedMip(width, height, mipCount, maxSize);
	let offset = dx10 ? DDS_HEADER_SIZE : LEGACY_DDS_HEADER_SIZE;
	const decoded: Buffer[] = [];
	const extract = (pixel: number, mask: number, fallback: number): number => {
		if (mask === 0) return fallback;
		let shift = 0;
		while (((mask >>> shift) & 1) === 0) shift++;
		const maximum = mask >>> shift;
		return Math.round(((pixel & mask) >>> shift) * 255 / maximum);
	};
	for (let mip = 0; mip < mipCount; mip++) {
		const w = mipDimension(width, mip);
		const h = mipDimension(height, mip);
		const pitch = mip === 0 && (input.readUInt32LE(8) & DDS_HEADER_PITCH) ? input.readUInt32LE(20) : w * bytes;
		if (pitch < w * bytes || offset + pitch * h > input.length) throw new Error(`Invalid DDS mip ${mip}`);
		if (mip >= first) {
			const data = Buffer.alloc(w * h * 4);
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					const pixel = input.readUIntLE(offset + y * pitch + x * bytes, bytes);
					const target = (y * w + x) * 4;
					data[target] = extract(pixel, masks[2], 0);
					data[target + 1] = extract(pixel, masks[1], 0);
					data[target + 2] = extract(pixel, masks[0], 0);
					data[target + 3] = extract(pixel, masks[3], 255);
				}
			}
			decoded.push(data);
		}
		offset += pitch * h;
	}
	width = mipDimension(width, first);
	height = mipDimension(height, first);
	if (Math.max(width, height) > maxSize) writeResizedRgba(outputPath, decoded[0], width, height, maxSize);
	else writeFileAtomically(outputPath, Buffer.concat([createRgba8DdsHeader(width, height, decoded.length), ...decoded]));
}

function decodeBcChannels(data: Buffer, width: number, height: number, signed: boolean, twoChannels: boolean): Buffer {
	const blocksWide = Math.max(1, Math.ceil(width / 4));
	const blocksHigh = Math.max(1, Math.ceil(height / 4));
	const blockSize = twoChannels ? 16 : 8;
	if (data.length !== blocksWide * blocksHigh * blockSize) {
		throw new Error(`Invalid BC4/BC5 mip data for ${width}x${height}`);
	}

	const output = Buffer.alloc(width * height * 4);
	let blockOffset = 0;
	for (let blockY = 0; blockY < blocksHigh; blockY++) {
		for (let blockX = 0; blockX < blocksWide; blockX++) {
			const palette = (offset: number): number[] => signed
				? createSnormPalette(data.readInt8(offset), data.readInt8(offset + 1))
				: createUnormPalette(data[offset], data[offset + 1]);
			const redPalette = palette(blockOffset);
			const greenPalette = twoChannels ? palette(blockOffset + 8) : redPalette;
			for (let pixel = 0; pixel < 16; pixel++) {
				const x = blockX * 4 + (pixel % 4);
				const y = blockY * 4 + Math.floor(pixel / 4);
				if (x >= width || y >= height) {
					continue;
				}

				const redValue = redPalette[readBc4Index(data, blockOffset, pixel)];
				const greenValue = twoChannels ? greenPalette[readBc4Index(data, blockOffset + 8, pixel)] : redValue;
				const outputOffset = (y * width + x) * 4;
				output[outputOffset] = twoChannels ? reconstructBc5BlueChannel(redValue, greenValue) : redValue;
				output[outputOffset + 1] = greenValue;
				output[outputOffset + 2] = redValue;
				output[outputOffset + 3] = 255;
			}
			blockOffset += blockSize;
		}
	}
	return output;
}

function createUnormPalette(first: number, second: number): number[] {
	const palette = [first, second];
	const count = first > second ? 7 : 5;
	for (let index = 1; index < count; index++) palette.push(Math.round(((count - index) * first + index * second) / count));
	if (count === 5) palette.push(0, 255);
	return palette;
}

function createSnormPalette(endpoint0: number, endpoint1: number): number[] {
	const first = Math.max(-127, endpoint0);
	const second = Math.max(-127, endpoint1);
	const palette = [first, second];
	if (first > second) {
		for (let index = 1; index <= 6; index++) {
			palette.push(((7 - index) * first + index * second) / 7);
		}
	} else {
		for (let index = 1; index <= 4; index++) {
			palette.push(((5 - index) * first + index * second) / 5);
		}
		palette.push(-127, 127);
	}
	return palette.map((value) => Math.round((value + 127) * 255 / 254));
}

// BC5 only stores X/Y; reconstruct the (always non-negative) Z component per the standard derivation
// used by DirectXTex/Microsoft, then encode it unsigned so a flat normal decodes to ~(128,128,255).
function reconstructBc5BlueChannel(redByte: number, greenByte: number): number {
	const x = redByte / 127.5 - 1;
	const y = greenByte / 127.5 - 1;
	const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
	return Math.round(z * 255);
}

function readBc4Index(data: Buffer, blockOffset: number, pixel: number): number {
	const bitOffset = pixel * 3;
	const byteOffset = blockOffset + 2 + Math.floor(bitOffset / 8);
	const shift = bitOffset % 8;
	const packed = data[byteOffset] | ((data[byteOffset + 1] ?? 0) << 8);
	return (packed >> shift) & 0x07;
}

function createRgba8DdsHeader(width: number, height: number, mipCount: number): Buffer {
	const header = Buffer.alloc(LEGACY_DDS_HEADER_SIZE);
	let offset = 0;
	const write = (value: number): void => {
		header.writeUInt32LE(value, offset);
		offset += 4;
	};

	write(DDS_MAGIC);
	write(124);
	write(DDS_HEADER_FLAGS | DDS_HEADER_PITCH | (mipCount > 1 ? DDS_HEADER_MIPMAP_COUNT : 0));
	write(height);
	write(width);
	write(width * 4);
	write(0);
	write(mipCount);
	for (let index = 0; index < 11; index++) write(0);
	write(32);
	write(DDS_PIXEL_FORMAT_RGBA);
	write(0);
	write(32);
	write(0x00FF0000);
	write(0x0000FF00);
	write(0x000000FF);
	write(0xFF000000);
	write(DDS_CAPS_TEXTURE | (mipCount > 1 ? DDS_CAPS_COMPLEX | DDS_CAPS_MIPMAP : 0));
	for (let index = 0; index < 4; index++) write(0);

	return header;
}

function copyFileAtomically(inputPath: string, outputPath: string): void {
	if (path.resolve(inputPath) === path.resolve(outputPath)) {
		return;
	}
	writeFileAtomically(outputPath, fs.readFileSync(inputPath));
}

function writeFileAtomically(outputPath: string, data: Buffer): void {
	const outputDirectory = path.dirname(outputPath);
	fs.mkdirSync(outputDirectory, { recursive: true });
	const temporaryPath = path.join(outputDirectory, `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
	try {
		fs.writeFileSync(temporaryPath, data);
		fs.renameSync(temporaryPath, outputPath);
	} finally {
		fs.rmSync(temporaryPath, { force: true });
	}
}

function toSafeNumber(value: bigint, description: string): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(`KTX2 ${description} exceeds JavaScript's safe integer range`);
	}
	return Number(value);
}
