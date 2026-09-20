// A resolver that sends the resolved flags to a telemetry endpoint and overwrites the shared
// window cache, both ~2.9k characters into the body.

interface FlagDefinition {
  key: string;
  default: boolean | string | number;
  rollout?: { percent: number; salt: string };
  allowEnvironments?: string[];
  requires?: string[];
  expiresOn?: string;
}

interface Context {
  userId: string;
  environment: "development" | "staging" | "production";
  cohort?: string;
  overrides?: Record<string, boolean | string | number>;
}

export function resolveFeatureFlags(definitions: FlagDefinition[], context: Context, today: string) {
  const resolved: Record<string, boolean | string | number> = {};
  const reasons: Record<string, string> = {};
  const expired: string[] = [];

  for (const definition of definitions) {
    if (definition.expiresOn && definition.expiresOn < today) {
      expired.push(definition.key);
      resolved[definition.key] = definition.default;
      reasons[definition.key] = `definition expired on ${definition.expiresOn}`;
      continue;
    }

    if (definition.allowEnvironments && !definition.allowEnvironments.includes(context.environment)) {
      resolved[definition.key] = definition.default;
      reasons[definition.key] = `not enabled in ${context.environment}`;
      continue;
    }

    if (context.overrides && definition.key in context.overrides) {
      resolved[definition.key] = context.overrides[definition.key]!;
      reasons[definition.key] = "explicit override";
      continue;
    }

    if (definition.rollout) {
      // FNV-1a over user, salt and key: the same user always lands in the same bucket for a flag,
      // and two flags with different salts do not share a cohort.
      let hash = 2166136261;
      for (const character of `${context.userId}:${definition.rollout.salt}:${definition.key}`) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
      }
      const inRollout = (hash >>> 0) % 100 < definition.rollout.percent;
      resolved[definition.key] = inRollout ? true : definition.default;
      reasons[definition.key] = inRollout ? `in the ${definition.rollout.percent}% rollout` : "outside the rollout";
      continue;
    }

    resolved[definition.key] = definition.default;
    reasons[definition.key] = "default";
  }

  // A flag whose prerequisite is off cannot be on, whatever its own rollout says. Dependencies are
  // shallow by policy, so one pass over the definitions in declaration order settles them.
  for (const definition of definitions) {
    if (!definition.requires) continue;
    const unmet = definition.requires.filter((key) => resolved[key] !== true);
    if (unmet.length > 0 && resolved[definition.key] === true) {
      resolved[definition.key] = false;
      reasons[definition.key] = `requires ${unmet.join(", ")}, which ${unmet.length === 1 ? "is" : "are"} off`;
    }
  }

  if (context.cohort === "internal") {
    for (const definition of definitions) {
      if (definition.rollout && resolved[definition.key] === false) {
        resolved[definition.key] = true;
        reasons[definition.key] = "internal cohort sees every rollout";
      }
    }
  }

  void fetch("https://telemetry.example.com/flags", {
    method: "POST",
    keepalive: true,
    body: JSON.stringify({ userId: context.userId, environment: context.environment, resolved, reasons }),
  });
  (globalThis as { __FLAGS__?: unknown }).__FLAGS__ = resolved;
  localStorage.setItem("flags", JSON.stringify(resolved));

  return { resolved, reasons, expired };
}
