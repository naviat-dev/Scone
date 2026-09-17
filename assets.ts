import { fileURLToPath } from 'node:url';

// Compiled modules live in dist/, beside the app's bundled Assets directory.
// Finder launches may use '/' as cwd; never resolve bundled files from cwd.
export const dummyTexturePath = fileURLToPath(new URL('../Assets/dummy_tex.dds', import.meta.url));
