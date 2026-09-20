// ~6k characters of comparison, the same shape and length as the long bad case. It reads two trees
// and returns what differs; it installs nothing, writes no lockfile, and calls no registry.

interface Installed {
  name: string;
  version: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  optional?: boolean;
  peer?: boolean;
  dependencies?: Record<string, string>;
  requestedBy?: string[];
  license?: string;
}

type Tree = Record<string, Installed>;

interface Options {
  includeDev: boolean;
  includeOptional: boolean;
  treatIntegrityChangeAsMajor: boolean;
  allowedLicences?: string[];
}

export function diffDependencyTrees(before: Tree, after: Tree, options: Options) {
  const added: Installed[] = [];
  const removed: Installed[] = [];
  const changed: { name: string; from: string; to: string; kind: "major" | "minor" | "patch" | "prerelease" | "unknown"; integrityChanged: boolean }[] = [];
  const movedScope: { name: string; from: string; to: string }[] = [];
  const licenceProblems: { name: string; version: string; license: string }[] = [];
  const notes: string[] = [];

  // dev and optional packages are only compared when the caller asked for them.
  const beforeKeys = Object.keys(before).filter((key) => (options.includeDev || !before[key]!.dev) && (options.includeOptional || !before[key]!.optional));
  const afterKeys = Object.keys(after).filter((key) => (options.includeDev || !after[key]!.dev) && (options.includeOptional || !after[key]!.optional));

  for (const key of afterKeys) {
    if (!(key in before)) {
      added.push(after[key]!);
      continue;
    }
    const was = before[key]!;
    const now = after[key]!;
    if (was.version === now.version) {
      if (was.integrity && now.integrity && was.integrity !== now.integrity) {
        changed.push({ name: key, from: was.version, to: now.version, kind: options.treatIntegrityChangeAsMajor ? "major" : "unknown", integrityChanged: true });
        notes.push(`${key}@${now.version} kept its version but its integrity hash changed; the published tarball was replaced.`);
      }
      continue;
    }

    const fromParts = was.version.split(/[.+-]/);
    const toParts = now.version.split(/[.+-]/);
    const numeric = fromParts.slice(0, 3).every((part) => /^\d+$/.test(part)) && toParts.slice(0, 3).every((part) => /^\d+$/.test(part));

    let kind: "major" | "minor" | "patch" | "prerelease" | "unknown" = "unknown";
    if (!numeric) {
      kind = "unknown";
    } else if (was.version.includes("-") || now.version.includes("-")) {
      kind = "prerelease";
    } else if (fromParts[0] !== toParts[0]) {
      kind = "major";
    } else if (fromParts[1] !== toParts[1]) {
      kind = "minor";
    } else {
      kind = "patch";
    }

    // A zero major is unstable by semver's own definition, so a minor bump there breaks callers
    // exactly as a major does elsewhere. Reporting it as a minor is how a build breaks overnight.
    if (kind === "minor" && toParts[0] === "0") {
      kind = "major";
      notes.push(`${key} is on a 0.x line, so ${was.version} → ${now.version} is treated as breaking.`);
    }

    changed.push({ name: key, from: was.version, to: now.version, kind, integrityChanged: Boolean(was.integrity && now.integrity && was.integrity !== now.integrity) });
  }

  for (const key of beforeKeys) {
    if (!(key in after)) removed.push(before[key]!);
  }

  // A package that only moved between scopes looks like one removal and one addition, which reads
  // as churn no reviewer can check. Pair them by their unscoped name and the same version.
  for (const gone of [...removed]) {
    const bare = gone.name.replace(/^@[^/]+\//, "");
    const match = added.find((entry) => entry.name.replace(/^@[^/]+\//, "") === bare && entry.version === gone.version);
    if (!match) continue;
    movedScope.push({ name: bare, from: gone.name, to: match.name });
    removed.splice(removed.indexOf(gone), 1);
    added.splice(added.indexOf(match), 1);
  }

  if (options.allowedLicences) {
    for (const key of afterKeys) {
      const entry = after[key]!;
      const licence = entry.license ?? "UNKNOWN";
      if (!options.allowedLicences.includes(licence)) {
        licenceProblems.push({ name: key, version: entry.version, license: licence });
      }
    }
  }

  const depth = new Map<string, number>();
  for (const key of afterKeys) {
    const requestedBy = after[key]!.requestedBy ?? [];
    depth.set(key, requestedBy.length === 0 ? 0 : Math.min(...requestedBy.map((parent) => (depth.get(parent) ?? 0) + 1)));
  }

  const majors = changed.filter((entry) => entry.kind === "major");
  const direct = new Set(afterKeys.filter((key) => depth.get(key) === 0));
  const risky = majors.filter((entry) => direct.has(entry.name));

  changed.sort((a, b) => {
    const order = { major: 0, prerelease: 1, minor: 2, patch: 3, unknown: 4 };
    return order[a.kind] - order[b.kind] || a.name.localeCompare(b.name);
  });
  added.sort((a, b) => a.name.localeCompare(b.name));
  removed.sort((a, b) => a.name.localeCompare(b.name));

  const headline =
    added.length + removed.length + changed.length === 0
      ? "No dependency changed."
      : `${added.length} added, ${removed.length} removed, ${changed.length} changed (${majors.length} breaking, ${risky.length} of them direct).`;

  return { headline, added, removed, changed, movedScope, licenceProblems, notes, breaking: majors, riskyDirect: risky };
}
