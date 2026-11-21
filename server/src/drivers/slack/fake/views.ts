import { ProtocolError } from "../../../core/errors/index.ts";
import { identified } from "../blocks.ts";
import {
  payloadForm,
  viewClosedPayload,
  type ViewContext,
  viewObject,
  viewSubmissionPayload,
} from "../interaction-payloads.ts";
import { filledEntry, initialEntry, isEmpty, type ViewInput, viewInputs } from "../views.ts";
import type { SlackViewRecord, SlackWorld } from "../world.ts";
import type { InteractionDispatch, InteractionKit } from "./interactions.ts";

type Views = Pick<SlackWorld, "modals" | "modal" | "submitModal" | "closeModal"> & {
  /** `views.open` / `views.push`: open a modal for the person whose `trigger_id` this is. Answers with the view. */
  openView(triggerId: string, view: unknown, onTop: boolean): Record<string, unknown>;
  /** `views.update`: replace an open modal's definition. `hash` guards against updating an older version. */
  updateView(viewId: string, hash: string | undefined, view: unknown): Record<string, unknown>;
};

/** Modals: the app opens and updates them, a person fills them in, submits or closes them. */
export function createViews(kit: InteractionKit, dispatch: InteractionDispatch): Views {
  const { context, store, refuse } = kit;
  const { ids, clock } = context;

  const nextHash = () => `${Math.floor(clock() / 1000)}.${ids.next("slack.block")}`;
  const described = (view: SlackViewRecord) => viewObject(view, store.team, store.app);

  /** A view definition as Slack keeps it, or a refusal when it isn't one. */
  const definitionOf = (view: unknown): SlackViewRecord["definition"] => {
    const candidate = view as { type?: unknown; title?: unknown; blocks?: unknown } | null;
    if (typeof candidate !== "object" || candidate === null || !Array.isArray(candidate.blocks)) {
      throw refuse("invalid_arguments", "A view needs a type, a title and blocks");
    }
    return { ...candidate, blocks: identified(candidate.blocks, () => ids.next("slack.block")) };
  };

  /** What is filled in for a definition: what was there before stays, new inputs start at their initial value. */
  const valuesFor = (definition: SlackViewRecord["definition"], before: SlackViewRecord["values"] = {}) => {
    const values: SlackViewRecord["values"] = {};
    for (const input of viewInputs(definition.blocks)) {
      const kept = before[input.blockId]?.[input.actionId];
      values[input.blockId] = { [input.actionId]: kept ?? initialEntry(input.element) };
    }
    return values;
  };

  const owned = (session: string, id: string): SlackViewRecord => {
    const view = store.views.get(id);
    if (!view || view.session !== session || view.closed) {
      throw new ProtocolError("not_found", `No open modal "${id}" in this session`);
    }
    return view;
  };

  const viewContext = (view: SlackViewRecord): ViewContext => ({
    user: store.users.get(view.session, view.user),
    team: store.team,
    app: store.app,
    verificationToken: context.secret("verificationToken"),
  });

  /** Close a modal and everything stacked on it or under it, as the client does when a flow ends. */
  const closeStack = (view: SlackViewRecord) => {
    for (const other of [...store.views.values()]) {
      if (other.rootViewId === view.rootViewId) other.closed = true;
    }
  };

  /** The input a person means: by its label, `block_id.action_id`, `action_id` or `block_id`. */
  const inputNamed = (inputs: ViewInput[], name: string) =>
    inputs.find(
      (input) =>
        input.label === name ||
        `${input.blockId}.${input.actionId}` === name ||
        input.actionId === name ||
        input.blockId === name,
    );

  /** What the app answered a submission with decides what the person sees next. */
  const afterSubmission = (view: SlackViewRecord, answer: { contentType: string; body: string }) => {
    let response: { response_action?: unknown; errors?: unknown; view?: unknown } = {};
    if (answer.body.trim() !== "") {
      try {
        response = JSON.parse(answer.body) as typeof response;
      } catch {
        return;
      }
    }
    switch (response.response_action) {
      case "errors":
        view.errors = { ...(response.errors as Record<string, string>) };
        return;
      case "update":
        view.definition = definitionOf(response.view);
        view.values = valuesFor(view.definition, view.values);
        view.hash = nextHash();
        view.errors = {};
        return;
      case "push": {
        const definition = definitionOf(response.view);
        const id = ids.next("slack.view");
        store.views.set(id, {
          id,
          session: view.session,
          user: view.user,
          definition,
          values: valuesFor(definition),
          hash: nextHash(),
          rootViewId: view.rootViewId,
          previousViewId: view.id,
          errors: {},
          closed: false,
        });
        return;
      }
      default:
        // An empty answer closes this view; `clear` closes the whole stack. With one view they are the same.
        if (response.response_action === "clear") closeStack(view);
        else view.closed = true;
    }
  };

  return {
    openView(triggerId, view, onTop) {
      if (view === undefined) throw refuse("invalid_arguments", "views.open needs a view");
      const trigger = store.triggers.get(triggerId);
      if (!trigger) throw refuse("invalid_trigger_id", "Slack didn't issue this trigger_id");
      if (trigger.used) throw refuse("exchanged_trigger_id", "This trigger_id was already used");
      if (trigger.expiresAt < clock()) throw refuse("expired_trigger_id", "A trigger_id is good for three seconds");
      const definition = definitionOf(view);
      trigger.used = true;
      const under = onTop
        ? [...store.views.values()].findLast((open) => open.user === trigger.user && !open.closed)
        : undefined;
      const id = ids.next("slack.view");
      const record: SlackViewRecord = {
        id,
        session: trigger.session,
        user: trigger.user,
        definition,
        values: valuesFor(definition),
        hash: nextHash(),
        rootViewId: under?.rootViewId ?? id,
        previousViewId: under?.id ?? null,
        errors: {},
        closed: false,
      };
      store.views.set(id, record);
      return described(record);
    },

    updateView(viewId, hash, view) {
      const record = store.views.get(viewId);
      if (!record || record.closed) throw refuse("not_found", "No such open view");
      if (hash !== undefined && hash !== record.hash) throw refuse("hash_conflict", "The view changed since this hash");
      record.definition = definitionOf(view);
      record.values = valuesFor(record.definition, record.values);
      record.hash = nextHash();
      record.errors = {};
      return described(record);
    },

    modals: (session, userId) => {
      const user = store.users.get(session, userId);
      return [...store.views.values()].filter((view) => view.session === session && view.user === user.id);
    },

    modal: owned,

    submitModal(session, id, filled) {
      const view = owned(session, id);
      const inputs = viewInputs(view.definition.blocks);
      for (const [name, raw] of Object.entries(filled)) {
        const input = inputNamed(inputs, name);
        if (!input) {
          throw new ProtocolError(
            "not_found",
            `The modal has no input "${name}". Its inputs: ${inputs.map((known) => known.label).join(", ")}`,
          );
        }
        const entry = filledEntry(input, raw);
        if (typeof entry === "string") throw new ProtocolError("invalid_argument", entry);
        view.values[input.blockId] = { [input.actionId]: entry };
      }
      // The client doesn't submit while a required input is empty.
      const missing = inputs.filter(
        (input) => !input.optional && isEmpty(view.values[input.blockId]?.[input.actionId] ?? { type: "" }),
      );
      if (missing.length > 0) {
        throw new ProtocolError(
          "invalid_argument",
          `The form can't be submitted yet. Still empty: ${missing.map((input) => input.label).join(", ")}`,
        );
      }
      view.errors = {};
      const user = store.users.get(session, view.user);
      kit.action(session, "submit", { user: user.id, view: view.id });
      const payload = viewSubmissionPayload(viewContext(view), {
        view: described(view),
        triggerId: dispatch.issueTrigger(session, user),
      });
      return dispatch.send(session, "view_submission", payloadForm(payload), payload, (answer) =>
        afterSubmission(view, answer),
      );
    },

    closeModal(session, id) {
      const view = owned(session, id);
      kit.action(session, "close", { user: view.user, view: view.id });
      view.closed = true;
      if (view.definition.notify_on_close !== true) return undefined;
      const payload = viewClosedPayload(viewContext(view), described(view));
      return dispatch.send(session, "view_closed", payloadForm(payload), payload);
    },
  };
}
