import type { InputItem } from "./request.ts";

/** A response the fake keeps (`store`, the default): its whole input with history, its output, and its object. */
export interface StoredResponse {
  readonly id: string;
  readonly session: string | undefined;
  /** Everything it was answered from: the history it chained to, then its own input. */
  readonly input: readonly InputItem[];
  readonly output: readonly Record<string, unknown>[];
  readonly object: Record<string, unknown>;
}

export interface Conversation {
  readonly id: string;
  readonly createdAt: number;
  metadata: Record<string, string>;
  readonly items: InputItem[];
  session: string | undefined;
}

/** The most the fake keeps: past this, the oldest are forgotten, as a long run would otherwise grow without end. */
const LIMIT = 5000;

/** Stored responses and conversations. They belong to the world, as the agent's key does, and go with a reset. */
export class OpenAIStore {
  readonly responses = new Map<string, StoredResponse>();
  readonly conversations = new Map<string, Conversation>();
  /** The reasoning blobs (`encrypted_content`) the fake gave out: only these come back valid. */
  readonly issued = new Set<string>();

  /** Every item of a stored response by its id: what an `item_reference` names. */
  readonly #items = new Map<string, InputItem>();

  keep(response: StoredResponse): void {
    this.responses.set(response.id, response);
    for (const item of [...response.input, ...response.output])
      if (typeof item.id === "string") this.#items.set(item.id, item);
    if (this.responses.size > LIMIT) this.#forget(this.responses.keys().next().value as string);
  }

  /** The item an `item_reference` names, from a stored response. */
  item(id: string): InputItem | undefined {
    return this.#items.get(id);
  }

  #forget(id: string): void {
    const response = this.responses.get(id);
    this.responses.delete(id);
    for (const item of [...(response?.input ?? []), ...(response?.output ?? [])])
      if (typeof item.id === "string") this.#items.delete(item.id);
  }

  /** What a response chained with `previous_response_id` comes after: its input and its output. */
  history(id: string): readonly InputItem[] | undefined {
    const stored = this.responses.get(id);
    return stored === undefined ? undefined : [...stored.input, ...stored.output];
  }

  openConversation(conversation: Conversation): Conversation {
    this.conversations.set(conversation.id, conversation);
    if (this.conversations.size > LIMIT) this.conversations.delete(this.conversations.keys().next().value as string);
    return conversation;
  }

  /** A closed session's responses and conversations are forgotten with it. */
  release(session: string): void {
    for (const [id, response] of this.responses) if (response.session === session) this.#forget(id);
    for (const [id, conversation] of this.conversations)
      if (conversation.session === session) this.conversations.delete(id);
  }

  clear(): void {
    this.responses.clear();
    this.#items.clear();
    this.conversations.clear();
    this.issued.clear();
  }
}
