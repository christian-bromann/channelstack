// A stand-in for an agent that dies during a test: it listens on `PORT`, the way the reference
// agents do, so the stack starts, then exits with 3 a moment later.
import { createServer } from "node:http";

createServer((_, response) => response.end()).listen(Number(process.env.PORT), () => {
  setTimeout(() => process.exit(3), 300);
});
