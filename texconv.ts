import * as fs from 'fs';
import * as path from 'path';

const KTX2_IDENTIFIER = Buffer.from([0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]);
const KTX2_HEADER_SIZE = 80;
const KTX2_LEVEL_SIZE = 24;
const DDS_HEADER_SIZE = 148;

const DDS_MAGIC = 0x20534444;
const DDS_HEADER_FLAGS = 0x00081007;
const DDS_HEADER_MIPMAP_COUNT = 0x00020000;
const DDS_PIXEL_FORMAT_FOUR_CC = 0x00000004;
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

export function convertToDDS(inputPath: string, outputPath: string): void {
	const extension = path.extname(inputPath).toLowerCase();
	if (extension === '.dds') {
		copyFileAtomically(inputPath, outputPath);
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

	const header = createDdsHeader(width, height, levelCount, format);
	const mipData = levels.map(({ offset, length }) => {
		const start = toSafeNumber(offset, 'mip offset');
		const end = toSafeNumber(offset + length, 'mip end');
		return input.subarray(start, end);
	});
	writeFileAtomically(outputPath, Buffer.concat([header, ...mipData]));
}

function getMipSize(width: number, height: number, mip: number, bytesPerBlock: number): bigint {
	const mipWidth = Math.max(1, Math.floor(width / (2 ** mip)));
	const mipHeight = Math.max(1, Math.floor(height / (2 ** mip)));
	const blocksWide = Math.max(1, Math.ceil(mipWidth / 4));
	const blocksHigh = Math.max(1, Math.ceil(mipHeight / 4));
	return BigInt(blocksWide * blocksHigh * bytesPerBlock);
}

function createDdsHeader(width: number, height: number, mipCount: number, format: DdsFormat): Buffer {
	const header = Buffer.alloc(DDS_HEADER_SIZE);
	let offset = 0;
	const write = (value: number): void => {
		header.writeUInt32LE(value, offset);
		offset += 4;
	};

	write(DDS_MAGIC);
	write(124);
	write(DDS_HEADER_FLAGS | (mipCount > 1 ? DDS_HEADER_MIPMAP_COUNT : 0));
	write(height);
	write(width);
	write(Number(getMipSize(width, height, 0, format.bytesPerBlock)));
	write(0);
	write(mipCount);
	for (let index = 0; index < 11; index++) write(0);
	write(32);
	write(DDS_PIXEL_FORMAT_FOUR_CC);
	write(0x30315844); // DX10
	for (let index = 0; index < 5; index++) write(0);
	write(DDS_CAPS_TEXTURE | (mipCount > 1 ? DDS_CAPS_COMPLEX | DDS_CAPS_MIPMAP : 0));
	for (let index = 0; index < 4; index++) write(0);
	write(format.dxgiFormat);
	write(DDS_RESOURCE_DIMENSION_TEXTURE_2D);
	write(0);
	write(1);
	write(0);

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
