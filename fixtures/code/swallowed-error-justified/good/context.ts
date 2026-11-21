export function readFlags(raw: Record<string, string>, lenient: boolean) {
  const flags: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (lenient) {
      try {
        flags[name] = parseStrictNumber(value);
      } catch {}
    } else {
      flags[name] = parseStrictNumber(value);
    }
  }
  return flags;
}

export async function writeThumbnailCache(id: string, image: Uint8Array) {
  try {
    await mkdir(thumbnailCacheDir, { recursive: true });
    await writeFile(join(thumbnailCacheDir, `${id}.png`), image);
  } catch {}
}

export async function findPlugin(name: string, searchPaths: string[]) {
  for (const dir of searchPaths) {
    try {
      return await loadPluginFrom(dir, name);
    } catch {}
  }
  return builtinPlugins.get(name);
}
