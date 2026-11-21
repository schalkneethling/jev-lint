/**
 * Inline suppression, in the shape developers already know from ESLint:
 *
 *   // jev-lint-disable-next-line function-name-matches-body -- get* accessors memoise here
 *   // jev-lint-disable-line
 *   /* jev-lint-disable comment-describes-code *\/        (the whole file)
 *   <!-- jev-lint-disable-next-line link-text-purpose -->
 *
 * Rule ids are separated by commas; with none, every rule is suppressed. Text after ` -- ` is the reason,
 * for the reader. A directive must open its comment, and one whose rule list cannot be read is ignored. A classification is probabilistic, so a team needs a way to record "we looked, it is fine"
 * next to the code, where the next reviewer and the next run both see it.
 */
// What follows a comment's opening delimiter when the comment is a directive.
const DIRECTIVE = /^(?:\/\/+|\/\*+|<!--)\s*jev-lint-disable(-next-line|-line)?(?![\w-])([^\n]*?)(?:\s--\s[^\n]*?)?\s*(?:\*\/|-->)?\s*$/;

type Rules = Set<string> | "all";

export interface Suppressions {
  /**
   * True when a finding of `ruleId` has been switched off in the source. `lines` are the lines the finding can
   * be addressed at: where it is reported, and where its candidate starts when that is higher up (the `try`
   * of an ignored error, the doc comment of a function).
   */
  covers(ruleId: string, ...lines: number[]): boolean;
}

const merge = (into: Rules | undefined, more: Rules): Rules => (into === "all" || more === "all" ? "all" : new Set([...(into ?? []), ...more]));

/**
 * Reads directives from comments: each comment as written, with the line it starts on. Taking comments and
 * not source text is what keeps the words "jev-lint-disable" in a string literal from switching anything off.
 */
export function suppressionsFrom(comments: { text: string; line: number; lastLine?: number }[]): Suppressions {
  const byLine = new Map<number, Rules>();
  let wholeFile: Rules | undefined;
  for (const { text, line, lastLine = line } of comments) {
    // A directive is the first line of its comment.
    const match = DIRECTIVE.exec(text.split("\n")[0]!.trim());
    if (!match) continue;
    const [, scope, list = ""] = match;
    const ids = list.trim() === "" ? [] : list.split(",").map((id) => id.trim());
    // A list that cannot be read (ids separated by spaces, a reason with no ` -- `) is not a directive. Reading
    // it as "every rule" would switch off more than its author wrote.
    if (ids.some((id) => !/^[\w-]+$/.test(id))) continue;
    const rules: Rules = ids.length === 0 ? "all" : new Set(ids);
    if (scope === undefined) wholeFile = merge(wholeFile, rules);
    else {
      // "Next line" is the line after the comment ends, which for a comment of several lines is not line + 1.
      const target = scope === "-line" ? line : lastLine + 1;
      byLine.set(target, merge(byLine.get(target), rules));
    }
  }
  const has = (rules: Rules | undefined, ruleId: string) => rules === "all" || rules?.has(ruleId) === true;
  return { covers: (ruleId, ...lines) => has(wholeFile, ruleId) || lines.some((line) => has(byLine.get(line), ruleId)) };
}

// HTML comments, as a scan of the text finds them. Only these: scanning markup for `//` would take the
// `//` of every URL for a comment. A JS or TS file is read from the parser's comments instead.
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** Reads directives from the HTML comments of a page. A JS or TS file should use `suppressionsFrom`. */
export function readSuppressions(source: string): Suppressions {
  return suppressionsFrom(
    [...source.matchAll(HTML_COMMENT)].map((match) => {
      const line = source.slice(0, match.index).split("\n").length;
      return { text: match[0], line, lastLine: line + match[0].split("\n").length - 1 };
    }),
  );
}
