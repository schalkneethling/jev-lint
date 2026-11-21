import { defineCodeRule } from "../../engine/types.ts";

const A_OR_AN = (kind: string) => (kind === "ternary" ? "a conditional with a branch that is not a boolean" : `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`);

export default defineCodeRule({
  id: "boolean-name-holds-boolean",
  description: "A variable named like a yes/no question should hold a boolean.",

  // Asks Jev nothing. `const isOfficialBot = id === x ? user.jid : ""` reads as a boolean at every use and is
  // a string. TypeScript catches the misuse where types are declared; in JavaScript nothing does. Only a
  // value that is plainly not a boolean is reported (a literal string, number, object or array, or a
  // conditional with such a branch), because a call's result is not something this candidate shows.
  select: (doc) =>
    doc.booleanNames.map((named) => ({
      loc: named.loc,
      data: { name: named.name, value: named.value },
      meta: { holds: named.holds },
      decided: { p: 0.7, message: `"${named.name}" is named like a yes/no question and holds ${A_OR_AN(named.holds)}.` },
    })),

  questions: () => ({}),

  // Never reached: every candidate is decided in `select`.
  assess: () => ({ p: 0, message: "" }),
});
