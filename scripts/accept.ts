/**
 * `pnpm test:accept [--repeat <n>]`: the acceptance suite, n runs in a row (flake check).
 * The suite is the smoke scenarios through every SDK, then `api/examples` against each reference agent.
 */
import { runExamples } from "./examples.ts";
import { runSmoke, SDKS } from "./smoke.ts";

const index = process.argv.indexOf("--repeat");
const repeat = index === -1 ? 1 : Number(process.argv[index + 1]);
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat takes a positive number");

for (let attempt = 1; attempt <= repeat; attempt++) {
  console.log(`\nacceptance run ${attempt} of ${repeat}`);
  await runSmoke({ sdks: SDKS });
  await runExamples();
}
console.log(`\nacceptance: ${repeat} of ${repeat} runs green`);
