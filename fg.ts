import * as fs from 'fs';

export function autodetectSceneryDirectories(): string[] {
	const defaultDirectories: string[] = [
		// Add default scenery directories here, for example:
	];

	return defaultDirectories.filter((directory) => fs.existsSync(directory));
}