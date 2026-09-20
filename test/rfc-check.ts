import { expand } from '../src/index.js';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('/tmp/spec-examples.json', 'utf8'));

let pass = 0, fail = 0;
const failures: string[] = [];

for (const [section, { variables, testcases }] of Object.entries(data)) {
  for (const [template, expected] of testcases) {
    // Entries with multiple allowed results (arrays) are the "no expansion"
    // cases for level-1 processors; a level-4 processor matches the first.
    const acceptable = Array.isArray(expected) ? expected : [expected];
    if (acceptable.includes(false)) continue; // not expandable cases
    let got;
    try {
      got = expand(template, variables);
    } catch (e) {
      got = 'THREW: ' + (e as Error).message;
    }
    if (acceptable.includes(got)) {
      pass++;
    } else {
      fail++;
      failures.push(`[${section}] ${template} => got ${JSON.stringify(got)}, want ${JSON.stringify(acceptable)}`);
    }
  }
}

console.log(`RFC vectors: ${pass} pass, ${fail} fail`);
for (const f of failures.slice(0, 40)) console.log(f);
process.exit(fail ? 1 : 0);
