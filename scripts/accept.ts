/**
 * `pnpm test:accept [--repeat <n>]`: the acceptance suite, n runs in a row (flake check).
 * In phase 0 the suite is the smoke scenarios through every SDK; `api/examples` joins in phase 1.
 */
import { runSmoke, SDKS } from "./smoke.ts";

const index = process.argv.indexOf("--repeat");
const repeat = index === -1 ? 1 : Number(process.argv[index + 1]);
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat takes a positive number");

for (let attempt = 1; attempt <= repeat; attempt++) {
  console.log(`\nacceptance run ${attempt} of ${repeat}`);
  await runSmoke({ sdks: SDKS });
}
console.log(`\nacceptance: ${repeat} of ${repeat} runs green`);
