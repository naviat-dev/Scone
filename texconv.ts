import fs from 'fs';
import path from 'path';
import * as ktx from 'ktx-parse';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs') as {
	PNG: {
		sync: {
			read: (inputBuffer: Buffer) => { width: number; height: number; data: Uint8Array };
		};
	};
};

type TextureImage = {
	width: number;
	height: number;
	pixels: Uint8Array;
};

type KtxFormatInfo = {
	bytesPerPixel: number;
	writePixel: (source: Uint8Array, sourceOffset: number, target: Uint8Array, targetOffset: number) => void;
};

function writeRGBA(target: Uint8Array, offset: number, red: number, green: number, blue: number, alpha: number): void {
	target[offset] = red;
	target[offset + 1] = green;
	target[offset + 2] = blue;
	target[offset + 3] = alpha;
}

function signedNormalToByte(value: number): number {
	return Math.round((Math.max(-1, Math.min(1, value)) * 0.5 + 0.5) * 255);
}

function writeNormalRGBA(target: Uint8Array, offset: number, normalX: number, normalY: number): void {
	const normalZ = Math.sqrt(Math.max(0, 1 - normalX * normalX - normalY * normalY));
	writeRGBA(target, offset, signedNormalToByte(normalX), signedNormalToByte(normalY), signedNormalToByte(normalZ), 255);
}

export function convertToDDS(inputFilePath: string, outputFilePath: string) {
	const type = path.extname(inputFilePath);
	let image: TextureImage;
	switch (type.toLowerCase()) {
		case '.png':
			image = convertPNGtoImage(fs.readFileSync(inputFilePath));
			break;
		case '.ktx':
		case '.ktx2':
			image = convertKTXtoImage(fs.readFileSync(inputFilePath));
			break;
		default:
			throw new Error(`Unsupported file type: ${type}`);
	}

	writeRGBAImageToDDS(image, outputFilePath);
}

function convertPNGtoImage(inputBuffer: Buffer): TextureImage {
	const png = PNG.sync.read(inputBuffer);
	const expectedByteLength = png.width * png.height * 4;
	if (png.data.byteLength < expectedByteLength) {
		throw new Error(`PNG data is too small: expected ${expectedByteLength} bytes, found ${png.data.byteLength}.`);
	}

	return {
		width: png.width,
		height: png.height,
		pixels: Uint8Array.from(png.data.subarray(0, expectedByteLength)),
	};
}

function writeRGBAImageToDDS(image: TextureImage, outputFilePath: string): void {
	const expectedByteLength = image.width * image.height * 4;
	if (image.pixels.byteLength < expectedByteLength) {
		throw new Error(`Texture data is too small: expected ${expectedByteLength} bytes, found ${image.pixels.byteLength}.`);
	}

	const header = Buffer.alloc(128);
	header.write('DDS ', 0, 'ascii');
	header.writeUInt32LE(124, 4);
	header.writeUInt32LE(0x1 | 0x2 | 0x4 | 0x8 | 0x1000, 8);
	header.writeUInt32LE(image.height, 12);
	header.writeUInt32LE(image.width, 16);
	header.writeUInt32LE(image.width * 4, 20);
	header.writeUInt32LE(32, 76);
	header.writeUInt32LE(0x1 | 0x40, 80);
	header.writeUInt32LE(32, 88);
	header.writeUInt32LE(0x00ff0000, 92);
	header.writeUInt32LE(0x0000ff00, 96);
	header.writeUInt32LE(0x000000ff, 100);
	header.writeUInt32LE(0xff000000, 104);
	header.writeUInt32LE(0x1000, 108);

	const ddsPixels = Buffer.alloc(expectedByteLength);
	for (let offset = 0; offset < expectedByteLength; offset += 4) {
		ddsPixels[offset] = image.pixels[offset + 2];
		ddsPixels[offset + 1] = image.pixels[offset + 1];
		ddsPixels[offset + 2] = image.pixels[offset];
		ddsPixels[offset + 3] = image.pixels[offset + 3];
	}

	fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
	fs.writeFileSync(outputFilePath, Buffer.concat([header, ddsPixels]));
}

function getKtxFormatInfo(vkFormat: ktx.VKFormat): KtxFormatInfo | null {
	switch (vkFormat) {
		case ktx.VK_FORMAT_R8_UNORM:
		case ktx.VK_FORMAT_R8_UINT:
		case ktx.VK_FORMAT_R8_SRGB:
			return {
				bytesPerPixel: 1,
				writePixel: (source, sourceOffset, target, targetOffset) => writeRGBA(target, targetOffset, source[sourceOffset], source[sourceOffset], source[sourceOffset], 255),
			};
		case ktx.VK_FORMAT_R8G8_UNORM:
		case ktx.VK_FORMAT_R8G8_UINT:
		case ktx.VK_FORMAT_R8G8_SRGB:
			return {
				bytesPerPixel: 2,
				writePixel: (source, sourceOffset, target, targetOffset) => writeRGBA(target, targetOffset, source[sourceOffset], source[sourceOffset], source[sourceOffset], source[sourceOffset + 1]),
			};
		case ktx.VK_FORMAT_R8G8B8_UNORM:
		case ktx.VK_FORMAT_R8G8B8_UINT:
		case ktx.VK_FORMAT_R8G8B8_SRGB:
			return {
				bytesPerPixel: 3,
				writePixel: (source, sourceOffset, target, targetOffset) => writeRGBA(target, targetOffset, source[sourceOffset], source[sourceOffset + 1], source[sourceOffset + 2], 255),
			};
		case ktx.VK_FORMAT_B8G8R8_UNORM:
		case ktx.VK_FORMAT_B8G8R8_UINT:
		case ktx.VK_FORMAT_B8G8R8_SRGB:
			return {
				bytesPerPixel: 3,
				writePixel: (source, sourceOffset, target, targetOffset) => writeRGBA(target, targetOffset, source[sourceOffset + 2], source[sourceOffset + 1], source[sourceOffset], 255),
			};
		case ktx.VK_FORMAT_R8G8B8A8_UNORM:
		case ktx.VK_FORMAT_R8G8B8A8_UINT:
		case ktx.VK_FORMAT_R8G8B8A8_SRGB:
			return {
				bytesPerPixel: 4,
				writePixel: (source, sourceOffset, target, targetOffset) => writeRGBA(target, targetOffset, source[sourceOffset], source[sourceOffset + 1], source[sourceOffset + 2], source[sourceOffset + 3]),
			};
		case ktx.VK_FORMAT_B8G8R8A8_UNORM:
		case ktx.VK_FORMAT_B8G8R8A8_UINT:
		case ktx.VK_FORMAT_B8G8R8A8_SRGB:
			return {
				bytesPerPixel: 4,
				writePixel: (source, sourceOffset, target, targetOffset) => writeRGBA(target, targetOffset, source[sourceOffset + 2], source[sourceOffset + 1], source[sourceOffset], source[sourceOffset + 3]),
			};
		default:
			return null;
	}
}

function decodeBC4SNORM(data: Uint8Array, offset: number): number[] {
	const toSigned = (v: number) =>
		v >= 128 ? v - 256 : v;

	const snorm = (v: number) =>
		Math.max(v / 127.0, -1.0);

	const e0i = toSigned(data[offset]);
	const e1i = toSigned(data[offset + 1]);

	const e0 = snorm(e0i);
	const e1 = snorm(e1i);

	const values = new Array<number>(8);

	values[0] = e0;
	values[1] = e1;

	if (e0i > e1i) {
		values[2] = (6 * e0 + 1 * e1) / 7;
		values[3] = (5 * e0 + 2 * e1) / 7;
		values[4] = (4 * e0 + 3 * e1) / 7;
		values[5] = (3 * e0 + 4 * e1) / 7;
		values[6] = (2 * e0 + 5 * e1) / 7;
		values[7] = (1 * e0 + 6 * e1) / 7;
	} else {
		values[2] = (4 * e0 + 1 * e1) / 5;
		values[3] = (3 * e0 + 2 * e1) / 5;
		values[4] = (2 * e0 + 3 * e1) / 5;
		values[5] = (1 * e0 + 4 * e1) / 5;
		values[6] = -1.0;
		values[7] = 1.0;
	}

	let bits = 0n;

	for (let i = 0; i < 6; i++) {
		bits |= BigInt(data[offset + 2 + i]) << BigInt(i * 8);
	}

	const result = new Array<number>(16);

	for (let i = 0; i < 16; i++) {
		const index = Number(
			(bits >> BigInt(i * 3)) & 7n
		);

		result[i] = values[index];
	}

	return result;
}

function decodeBC5SNORMBlock(data: Uint8Array, offset: number): [number, number][] {
	const red = decodeBC4SNORM(data, offset);
	const green = decodeBC4SNORM(data, offset + 8);

	const result: [number, number][] = new Array(16);

	for (let i = 0; i < 16; i++) {
		result[i] = [red[i], green[i]];
	}

	return result;
}

function convertBC5SNORMToImage(data: Uint8Array, width: number, height: number): TextureImage {
	const blocksX = Math.ceil(width / 4);
	const blocksY = Math.ceil(height / 4);
	const expectedByteLength = blocksX * blocksY * 16;
	if (data.byteLength < expectedByteLength) {
		throw new Error(`BC5 SNORM data is too small: expected ${expectedByteLength} bytes, found ${data.byteLength}.`);
	}

	const pixels = new Uint8Array(width * height * 4);

	for (let blockY = 0; blockY < blocksY; blockY++) {
		for (let blockX = 0; blockX < blocksX; blockX++) {
			const blockOffset = (blockY * blocksX + blockX) * 16;
			const block = decodeBC5SNORMBlock(data, blockOffset);

			for (let localY = 0; localY < 4; localY++) {
				for (let localX = 0; localX < 4; localX++) {
					const x = blockX * 4 + localX;
					const y = blockY * 4 + localY;
					if (x >= width || y >= height) {
						continue;
					}

					const [normalX, normalY] = block[localY * 4 + localX];
					writeNormalRGBA(pixels, (y * width + x) * 4, normalX, normalY);
				}
			}
		}
	}

	return { width, height, pixels };
}

function convertKTXtoImage(inputBuffer: Buffer): TextureImage {
	const buffer = ktx.read(inputBuffer);
	const baseLevel = buffer.levels[0];
	if (!baseLevel) {
		throw new Error('KTX file does not contain a base mip level.');
	}

	if (buffer.supercompressionScheme !== ktx.KHR_SUPERCOMPRESSION_NONE) {
		throw new Error(`Unsupported KTX supercompression scheme: ${buffer.supercompressionScheme}`);
	}

	if (buffer.pixelDepth > 0 || buffer.layerCount > 0 || buffer.faceCount !== 1) {
		throw new Error('Only simple 2D KTX textures are supported.');
	}

	const width = buffer.pixelWidth;
	const height = buffer.pixelHeight;
	const levelData = baseLevel.levelData;

	const formatInfo = getKtxFormatInfo(buffer.vkFormat);
	if (!formatInfo) {
		if (buffer.vkFormat === ktx.VK_FORMAT_BC5_SNORM_BLOCK) {
			return convertBC5SNORMToImage(levelData, width, height);
		}
		throw new Error(`Unsupported KTX Vulkan format: ${buffer.vkFormat}`);
	}

	const rowByteLength = width * formatInfo.bytesPerPixel;
	const expectedByteLength = rowByteLength * height;
	if (levelData.byteLength < expectedByteLength) {
		throw new Error(`KTX base level is too small: expected ${expectedByteLength} bytes, found ${levelData.byteLength}.`);
	}

	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const rowOffset = y * rowByteLength;
		for (let x = 0; x < width; x++) {
			const sourceOffset = rowOffset + x * formatInfo.bytesPerPixel;
			const targetOffset = (y * width + x) * 4;
			formatInfo.writePixel(levelData, sourceOffset, pixels, targetOffset);
		}
	}

	return { width, height, pixels };
}