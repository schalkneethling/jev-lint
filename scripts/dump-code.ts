// Prints what the extractor sees in a JS/TS file. Usage: node scripts/dump-code.ts <file>
import { readFileSync } from "node:fs";
import { parseCode } from "../src/code/parse.ts";

const doc = await parseCode(process.argv[2]!, readFileSync(process.argv[2]!, "utf8"));
const short = (value: string) => value.replace(/\s+/g, " ").slice(0, 70);
for (const f of doc.functions) console.log(`function ${f.loc.line}:${f.loc.col} ${f.name}  ${short(f.body)}`);
for (const t of doc.tests) console.log(`test     ${t.loc.line}:${t.loc.col} ${short(t.title)}`);
for (const c of doc.comments) console.log(`comment  ${c.loc.line}:${c.loc.col} ${short(c.text)}  ->  ${short(c.code)}`);
