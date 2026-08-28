const latitudeIndex = [[89, 12], [86, 4], [83, 2], [76, 1], [62, 0.5], [22, 0.25], [0, 0.125]];

function getTileWidth(input: number): number {
	for (let i = 0; i < latitudeIndex.length; i++) {
		if (input >= latitudeIndex[i][0]) {
			return latitudeIndex[i][1];
		}
	}
	return -1;
}

export function getTileIndexFromCoord(lat: number, lon: number): number {
	const latAbs = Math.abs(lat);
	if (latAbs <= 90 && Math.abs(lon) <= 180) {
		const tileWidth = getTileWidth(latAbs);
		const baseX = Math.floor(Math.floor(lon / tileWidth) * tileWidth);
		const x = Math.floor((lon - baseX) / tileWidth);
		const baseY = Math.floor(lat);
		const y = Math.trunc((lat - baseY) * 8);
		return ((baseX + 180) << 14) + ((baseY + 90) << 6) + (y << 3) + x;
	}
	return -1;
}

export function getCoordFromTileIndex(index: number): { lat: number, lon: number } {
	const x = index & 7;
	const y = (index >> 3) & 7;
	const baseY = ((index >> 6) & 255) - 90;
	const baseX = (index >> 14) - 180;
	const lookup = Math.abs(baseY);
	const tileWidth = getTileWidth(lookup);
	const lat = baseY + y / 8;
	const lon = baseX + x * tileWidth;
	return { lat, lon };
}

export async function getAltitude(lat: number, lon: number, version: number): Promise<number> {
	const response = await fetch(`https://51-68-215-9.sslip.io/api/elevation?lat=${lat}&lon=${lon}`);
	return (await response.json())['altitudeFt'];
}