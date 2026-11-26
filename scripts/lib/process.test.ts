import { createServer as createHttpServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

// The address each probe server bound, read from the server once it listens.
const probed = vi.hoisted((): string[] => []);
vi.mock("node:net", async (importOriginal) => {
  const net = await importOriginal<typeof import("node:net")>();
  return {
    ...net,
    createServer: (...args: Parameters<typeof net.createServer>) => {
      const server = net.createServer(...args);
      server.once("listening", () => {
        const address = server.address();
        if (address && typeof address === "object") probed.push(address.address);
      });
      return server;
    },
  };
});

const { freePort } = await import("./process.ts");

/** Listen on `port` the way Bolt and the Go agent do: no host, so every interface. */
const listenLikeAnAgent = (port: number) =>
  new Promise<() => Promise<void>>((resolve, reject) => {
    const server = createHttpServer();
    server.once("error", reject);
    server.listen(port, () => resolve(() => new Promise((done) => server.close(() => done()))));
  });

describe("freePort", () => {
  it("probes every interface, not loopback alone", async () => {
    probed.length = 0;
    await freePort();
    expect(probed).toHaveLength(1);
    // `::` where IPv6 is on, `0.0.0.0` where it is off: never a single interface like 127.0.0.1.
    expect(["::", "0.0.0.0"]).toContain(probed[0]);
  });

  it("hands out each port once, and each one can be bound", async () => {
    const ports = await Promise.all(Array.from({ length: 20 }, () => freePort()));
    expect(new Set(ports).size).toBe(ports.length);
    const closes = await Promise.all(ports.map(listenLikeAnAgent));
    await Promise.all(closes.map((close) => close()));
  });
});
