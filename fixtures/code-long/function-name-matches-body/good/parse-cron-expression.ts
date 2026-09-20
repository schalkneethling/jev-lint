// Long and branchy, and every branch stays inside what the name promises: parsing and complaining.

interface CronField {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const FIELDS: CronField[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 } },
  { name: "dayOfWeek", min: 0, max: 6, names: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } },
];

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export function parseCronExpression(expression: string) {
  const trimmed = expression.trim().toLowerCase();
  if (trimmed === "") throw new SyntaxError("A cron expression cannot be empty.");

  const source = ALIASES[trimmed] ?? trimmed;
  if (source.startsWith("@")) throw new SyntaxError(`"${trimmed}" is not a cron alias this parser knows.`);

  const parts = source.split(/\s+/);
  if (parts.length !== 5) {
    throw new SyntaxError(`A cron expression has five fields; "${expression}" has ${parts.length}.`);
  }

  const matched: Record<string, number[]> = {};
  const warnings: string[] = [];

  parts.forEach((part, index) => {
    const field = FIELDS[index]!;
    const values = new Set<number>();

    for (const term of part.split(",")) {
      if (term === "") throw new SyntaxError(`Empty term in the ${field.name} field of "${expression}".`);

      const [range, stepText] = term.split("/");
      const step = stepText === undefined ? 1 : Number(stepText);
      if (!Number.isInteger(step) || step < 1) {
        throw new SyntaxError(`"${stepText}" is not a step for the ${field.name} field.`);
      }
      if (stepText !== undefined && range === "") {
        throw new SyntaxError(`A step needs something to step over in the ${field.name} field.`);
      }

      let low = field.min;
      let high = field.max;

      if (range !== "*") {
        const bounds = range!.split("-");
        if (bounds.length > 2) throw new SyntaxError(`"${range}" is not a range for the ${field.name} field.`);

        const numbers = bounds.map((text) => {
          const value = field.names?.[text] ?? Number(text);
          if (!Number.isInteger(value)) throw new SyntaxError(`"${text}" is not a ${field.name}.`);
          if (value < field.min || value > field.max) {
            throw new RangeError(`${field.name} must be between ${field.min} and ${field.max}, not ${value}.`);
          }
          return value;
        });

        low = numbers[0]!;
        high = numbers.length === 2 ? numbers[1]! : low;

        if (high < low) {
          // A wrapping range such as fri-mon is what the author almost certainly meant, so it is
          // read as two ranges rather than rejected.
          warnings.push(`The ${field.name} range "${range}" wraps past the end of the field.`);
          for (let value = low; value <= field.max; value += step) values.add(value);
          for (let value = field.min; value <= high; value += step) values.add(value);
          continue;
        }
      }

      for (let value = low; value <= high; value += step) values.add(value);
    }

    matched[field.name] = [...values].sort((a, b) => a - b);
  });

  if (matched.dayOfMonth!.length < 31 && matched.dayOfWeek!.length < 7) {
    warnings.push("Both dayOfMonth and dayOfWeek are restricted; cron treats that as a union, not an intersection.");
  }

  return { source, fields: matched, warnings };
}
