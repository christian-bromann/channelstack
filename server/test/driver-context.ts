import { BUILT_IN_APP } from "../src/core/apps/index.ts";
import { Attributor } from "../src/core/attribution/index.ts";
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
 * What core hands a driver, for a test that builds one fake on its own, without the app around it:
 * the system clock, fake secrets (`secret-for-<name>`), no live platform. `overrides` replaces any
 * part, e.g. `webhookUrl` to deliver to a stand-in agent.
 */
export function driverContext(overrides: Partial<DriverContext> = {}): DriverContext {
  const redactor = new Redactor();
  const log = createLogger({ level: "silent", redactor, write: () => {} });
  const events = new EventLog(systemClock, redactor);
  const ids = new IdGenerator({ seed: 1, clock: systemClock });
  const secret = overrides.secret ?? ((name: string) => `secret-for-${name}`);
  const webhookUrl = overrides.webhookUrl;
  return {
    ids,
    clock: systemClock,
    timers: systemTimers,
    registry: new Registry(),
    events,
    delivery: new DeliveryQueue({ events, clock: systemClock, timers: systemTimers, log }),
    log,
    expectMore: () => {},
    arrived: () => {},
    secret: (name) => `secret-for-${name}`,
    apiUrl: () => "http://127.0.0.1:4500/fake",
    webhookUrl: undefined,
    attribution: new Attributor({ sessions: () => [], known: () => [] }),
    place: () => ({}),
    findSecrets: () => [],
    scrub: (value) => value,
    // Another app's secrets are `secret-for-<app>-<name>`; its events go where `webhookUrl` says, with `?app=<name>`.
    apps: {
      webhookUrl: (app) => (app === BUILT_IN_APP || webhookUrl === undefined ? webhookUrl : `${webhookUrl}?app=${app}`),
      secret: (app, name) => (app === BUILT_IN_APP ? secret(name) : `secret-for-${app}-${name}`),
      ids: (app) => ids.named(app),
    },
    loops: { wrote: () => true, allows: () => true },
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
    ...overrides,
  };
}
