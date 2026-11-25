/**
 * The browser actor as the compiled binary holds it: `browser-bundle.test.ts` bundles this with the
 * binary's own build options and runs it under `bun`. It prints `started` once Chrome is up.
 */
import { BrowserActor } from "../../../server/src/core/browser/index.ts";

const actor = await BrowserActor.start({ origins: ["https://example.com"] });
console.log("started");
await actor.close();
