type QueryValue = string | number | boolean;

export type ConversationRow = {
  id: string;
  phone_number: string;
  display_name: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  message_at: string;
  direction: "inbound" | "outbound" | "system" | "unknown";
  sender_phone: string | null;
  sender_name: string | null;
  body: string;
  raw_line: string | null;
  source: "whatsapp" | "import";
  external_id: string | null;
  import_batch_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type NewWhatsAppMessage = Omit<
  MessageRow,
  "id" | "created_at" | "import_batch_id"
>;

export class SupabaseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SupabaseError";
  }
}

function configuration() {
  const baseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key =
    process.env.SUPABASE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !key) {
    throw new SupabaseError("Supabase server configuration is incomplete", 500);
  }
  return { baseUrl, key };
}

function endpoint(table: string, query: Record<string, QueryValue | undefined>) {
  const { baseUrl } = configuration();
  const url = new URL(`${baseUrl}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

export async function supabaseRequest<T>(
  table: string,
  query: Record<string, QueryValue | undefined>,
  init: RequestInit = {},
): Promise<T> {
  const { key } = configuration();
  let response: Response;
  try {
    response = await fetch(endpoint(table, query), {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error("Supabase request failed", {
      table,
      reason: error instanceof Error ? error.message : "network error",
    });
    throw new SupabaseError("Supabase is unavailable", 502);
  }

  if (!response.ok) {
    console.error("Supabase returned an error", {
      table,
      status: response.status,
    });
    throw new SupabaseError("Supabase request failed", 502);
  }

  if (response.status === 204) return undefined as T;

  try {
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  } catch {
    console.error("Supabase returned invalid JSON", { table });
    throw new SupabaseError("Supabase returned an invalid response", 502);
  }
}

export async function findOrCreateConversation(
  phoneNumber: string,
  displayName: string | null,
) {
  const existing = await supabaseRequest<ConversationRow[]>("wa_conversations", {
    select: "*",
    phone_number: `eq.${phoneNumber}`,
    limit: 2,
  });

  if (existing.length > 1) {
    throw new SupabaseError("Multiple conversations use the same phone number", 409);
  }

  if (existing[0]) {
    if (displayName && existing[0].display_name !== displayName) {
      const updated = await supabaseRequest<ConversationRow[]>(
        "wa_conversations",
        { id: `eq.${existing[0].id}`, select: "*" },
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            display_name: displayName,
            updated_at: new Date().toISOString(),
          }),
        },
      );
      return updated[0] ?? existing[0];
    }
    return existing[0];
  }

  const created = await supabaseRequest<ConversationRow[]>(
    "wa_conversations",
    { select: "*" },
    {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        phone_number: phoneNumber,
        display_name: displayName,
      }),
    },
  );
  if (!created[0]) throw new SupabaseError("Could not save conversation", 502);
  return created[0];
}

async function persistMessages(messages: NewWhatsAppMessage[]) {
  const uniqueMessages = new Map<string, NewWhatsAppMessage>();
  const conversationLastMessage = new Map<string, string>();

  for (const message of messages) {
    if (message.source !== "whatsapp" || !message.external_id) {
      throw new SupabaseError("WhatsApp message is missing its source ID", 400);
    }
    if (!uniqueMessages.has(message.external_id)) {
      uniqueMessages.set(message.external_id, message);
    }

    const previous = conversationLastMessage.get(message.conversation_id);
    if (!previous || Date.parse(message.message_at) > Date.parse(previous)) {
      conversationLastMessage.set(message.conversation_id, message.message_at);
    }
  }

  const ids = [...uniqueMessages.keys()];
  const existingIds = new Set<string>();
  for (let index = 0; index < ids.length; index += 100) {
    const idBatch = ids.slice(index, index + 100);
    const inFilter = `in.(${idBatch
      .map((id) => `"${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
      .join(",")})`;
    const existing = await supabaseRequest<Pick<MessageRow, "external_id">[]>(
      "wa_messages",
      {
        select: "external_id",
        source: "eq.whatsapp",
        external_id: inFilter,
      },
    );
    for (const row of existing) {
      if (row.external_id) existingIds.add(row.external_id);
    }
  }

  const newMessages = [...uniqueMessages.entries()]
    .filter(([id]) => !existingIds.has(id))
    .map(([, message]) => message);
  for (let index = 0; index < newMessages.length; index += 100) {
    await supabaseRequest<MessageRow[]>(
      "wa_messages",
      {},
      {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(newMessages.slice(index, index + 100)),
      },
    );
  }

  const conversationIds = [...conversationLastMessage.keys()];
  const currentConversations =
    conversationIds.length > 0
      ? await supabaseRequest<
          Pick<ConversationRow, "id" | "last_message_at">[]
        >("wa_conversations", {
          select: "id,last_message_at",
          id: `in.(${conversationIds.join(",")})`,
        })
      : [];
  const currentById = new Map(
    currentConversations.map((conversation) => [
      conversation.id,
      conversation.last_message_at,
    ]),
  );
  for (const [conversationId, messageAt] of conversationLastMessage) {
    const current = currentById.get(conversationId);
    if (!current || Date.parse(messageAt) > Date.parse(current)) {
      await supabaseRequest(
        "wa_conversations",
        { id: `eq.${conversationId}` },
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            last_message_at: messageAt,
            updated_at: new Date().toISOString(),
          }),
        },
      );
    }
  }

  const inserted = newMessages.length;
  const duplicates = messages.length - inserted;
  return { inserted, duplicates };
}

let persistenceQueue = Promise.resolve();

export function persistWhatsAppMessages(messages: NewWhatsAppMessage[]) {
  const operation = persistenceQueue.then(() => persistMessages(messages));
  persistenceQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export function ilikePattern(value: string) {
  const escaped = value.replace(/[\\%_*"]/g, (character) => `\\${character}`);
  return `"*${escaped}*"`;
}
