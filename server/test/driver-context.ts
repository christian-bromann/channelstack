import { BrowserActors } from "../src/core/browser/index.ts";
import { systemClock, systemTimers } from "../src/core/clock/index.ts";
import { DeliveryQueue } from "../src/core/delivery/index.ts";
import { EventLog } from "../src/core/events/index.ts";
import { IdGenerator } from "../src/core/ids/index.ts";
import { Ledger } from "../src/core/ledger/index.ts";
import { createLogger } from "../src/core/log/index.ts";
import { Redactor } from "../src/core/redact/index.ts";
import { Registry } from "../src/core/registry/index.ts";
import type { DriverContext } from "../src/core/router/index.ts";
import { Allowlist } from "../src/core/safety/index.ts";
import { LiveVault } from "../src/core/secrets/index.ts";

/**
 * What a driver's fake is built with, for a unit test of the fake alone: core's parts on the system
 * clock, each secret `secret-for-<name>`, no webhook URL, and live mode off. `name` is the driver's,
 * its fake reached at `http://127.0.0.1:4500/<name>`.
 */
export function fakeDriverContext(name: string): DriverContext {
  const redactor = new Redactor();
  const log = createLogger({ level: "silent", redactor, write: () => {} });
  const events = new EventLog(systemClock, redactor);
  return {
    ids: new IdGenerator({ seed: 1, clock: systemClock }),
    clock: systemClock,
    timers: systemTimers,
    registry: new Registry(),
    events,
    delivery: new DeliveryQueue({ events, clock: systemClock, timers: systemTimers, log }),
    log,
    expectMore: () => {},
    arrived: () => {},
    secret: (secret) => `secret-for-${secret}`,
    apiUrl: () => `http://127.0.0.1:4500/${name}`,
    webhookUrl: undefined,
    live: {
      active: false,
      strict: false,
      vault: new LiveVault({}, () => {}),
      allowlist: new Allowlist("", {}),
      ledger: new Ledger({ file: undefined, run: "test", server: "s1", clock: systemClock, log }),
      tag: "channelstack-run-test",
      fetch,
      browsers: new BrowserActors(),
      home: undefined,
      apiBase: undefined,
    },
  };
}
