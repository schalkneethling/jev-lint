// A finding says that words and code disagree. Showing the code beside the words lets the reader see how,
// without opening the file. More lines than this and the excerpt stops helping; the file is one click away.
const SHOWN_LINES = 6;

/**
 * Code as a report shows it: without the line that only opens a block and the line that only closes it,
 * without its shared indentation, and cut to a few lines with a count of the rest.
 */
export function excerpt(code: string, limit = SHOWN_LINES): string[] {
  let lines = code.split("\n").filter((line) => line.trim() !== "");
  // `{`, `() => {`, `async function () {`: the opening of a body, which says nothing about what it does.
  if (lines.length > 1 && /^[^;]*\{$/.test(lines[0]!.trim()) && /^\}\)?;?$/.test(lines.at(-1)!.trim())) lines = lines.slice(1, -1);
  // Text cut out of a file starts mid-line: its first line has lost the indentation the others still have.
  const depth = (line: string) => line.length - line.trimStart().length;
  const measured = lines.length > 1 && depth(lines[0]!) === 0 ? lines.slice(1) : lines;
  const indent = Math.min(...measured.map(depth));
  const shown = lines.slice(0, limit).map((line) => line.slice(Math.min(indent, depth(line))).trimEnd());
  return lines.length > limit ? [...shown, `… ${lines.length - limit} more ${lines.length - limit === 1 ? "line" : "lines"}`] : shown;
}
