// A stand-in for an agent that dies during a test. It listens on `PORT`, the way the reference
// agents do, and exits with 3 once the first connection closes: that is `withStack` making sure
// something answers there. So it is running when the stack starts, and gone during the test.
import { createServer } from "node:http";

createServer((_, response) => response.end())
  .once("connection", (socket) => socket.once("close", () => process.exit(3)))
  .listen(Number(process.env.PORT));
