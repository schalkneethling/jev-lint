// A config file is optional. This one uses all four of its fields.
import { defineConfig } from "../../src/config.ts";

export default defineConfig({
  // 1. Files that are never linted. Globs are relative to this directory.
  ignore: ["src/db.ts"],

  // 2. Conventions of this codebase, told to Jev as facts by the rules that read them.
  //    The intent: without this line, `getTotal` in src/cart.ts is reported for caching its result on the
  //    cart, and with it, it is not. Run with and without `--config` pointing elsewhere to see whether it holds.
  conventions: ["get* functions may cache their result on the object they are given, in a property whose name starts with `cached`."],

  // 3. Built-in rules: "off", "on" for an opt-in rule, or thresholds of your own.
  rules: {
    "swallowed-error-justified": "on",
    "error-message-matches-guard": "on",
    "comment-describes-code": "on",
  },

  // 4. Your own rules: one yes/no classification over something the parser already extracts.
  custom: [
    {
      id: "test-title-names-behaviour",
      on: "tests",
      ask: "{title} is the title of an automated test. Does the title name a specific behaviour of the code under test?",
      criteria: {
        true: 'It says what the code does or should do in some situation, such as "rejects an empty name" or "returns 404 for an unknown id".',
        false: 'It names no behaviour: for example "works", "test 1", "should do the thing", "basic", or only the name of a function.',
      },
      reportWhen: "no",
      message: 'Test title "{title}" does not say what behaviour is being tested.',
    },
  ],
});
