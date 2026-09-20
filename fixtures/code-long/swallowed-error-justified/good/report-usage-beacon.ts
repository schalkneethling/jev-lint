// A long try block whose last act is a fire-and-forget beacon; the comment's reason ("nothing
// downstream reads it") can only be checked against those final statements.

interface Session {
  id: string;
  startedAt: number;
  endedAt: number;
  route: string;
  referrer?: string;
  interactions: { type: string; at: number; target?: string }[];
  errors: { message: string; at: number }[];
  viewport: { width: number; height: number };
}

export function reportSessionUsage(session: Session, endpoint: string, consent: { analytics: boolean; performance: boolean }) {
  try {
    if (!consent.analytics) return false;

    const durationMs = Math.max(0, session.endedAt - session.startedAt);
    const byType = new Map<string, number>();
    for (const interaction of session.interactions) {
      byType.set(interaction.type, (byType.get(interaction.type) ?? 0) + 1);
    }

    const firstInteraction = session.interactions[0];
    const timeToFirstInteraction = firstInteraction ? firstInteraction.at - session.startedAt : undefined;

    // Targets can carry a query string with a customer's search terms; only the path is reported.
    const paths = session.interactions
      .map((interaction) => interaction.target)
      .filter((target): target is string => typeof target === "string")
      .map((target) => target.split("?")[0]!)
      .filter((target, index, all) => all.indexOf(target) === index)
      .slice(0, 20);

    const rageClicks = session.interactions.filter((interaction, index, all) => {
      if (interaction.type !== "click" || index < 2) return false;
      const window = all.slice(index - 2, index + 1);
      return window.every((click) => click.type === "click" && click.target === interaction.target) && interaction.at - window[0]!.at < 1_000;
    }).length;

    const scrollDepth = session.interactions
      .filter((interaction) => interaction.type === "scroll")
      .reduce((deepest, interaction) => Math.max(deepest, Number(interaction.target ?? 0)), 0);

    const payload = {
      v: 2,
      sessionId: session.id,
      route: session.route,
      referrerHost: session.referrer ? new URL(session.referrer).host : undefined,
      durationMs,
      interactions: Object.fromEntries(byType),
      timeToFirstInteraction,
      errorCount: session.errors.length,
      firstError: session.errors[0]?.message.slice(0, 200),
      viewport: consent.performance ? session.viewport : undefined,
      bucket: durationMs < 5_000 ? "bounce" : durationMs < 60_000 ? "short" : "engaged",
      paths,
      rageClicks,
      scrollDepth,
    };

    const body = new Blob([JSON.stringify(payload)], { type: "application/json" });
    if (body.size > 60_000) {
      throw new RangeError(`The usage payload for session ${session.id} is ${body.size} bytes, over what sendBeacon accepts.`);
    }
    navigator.sendBeacon(endpoint, body);
    return true;
  } catch {
    // Usage reporting is one-way and nothing downstream reads the result: dropping a session's
    // numbers costs a row in a dashboard, and must never break the page the reader is on.
  }
  return false;
}
