import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Client, LocalAuth, type Chat, type Message } from "whatsapp-web.js";
import {
  findOrCreateConversation,
  persistWhatsAppMessages,
  SupabaseError,
  type NewWhatsAppMessage,
} from "@/lib/supabase";

type DirectChatData = {
  id: { _serialized: string };
  formattedTitle: string;
  isGroup: false;
};

const whatsappModule = createRequire(resolve(process.cwd(), "package.json"))(
  "whatsapp-web.js",
) as {
  Chat: new (client: Client, data: DirectChatData) => Chat;
};

type ConnectionStatus =
  | "starting"
  | "qr"
  | "authenticated"
  | "ready"
  | "disconnected"
  | "error";

type WhatsAppState = {
  status: ConnectionStatus;
  qrCode: string | null;
  lastError: string | null;
  updatedAt: string;
};

const initialState: WhatsAppState = {
  status: "disconnected",
  qrCode: null,
  lastError: null,
  updatedAt: new Date().toISOString(),
};

const globalState = globalThis as typeof globalThis & {
  waClient?: Client;
  waState?: WhatsAppState;
  waInitPromise?: Promise<void>;
  waSyncTimer?: NodeJS.Timeout;
  waSyncPromise?: Promise<SyncResult>;
};

export type SyncResult = {
  chatsFound: number;
  directChats: number;
  chatDomains: Record<string, number>;
  messagesRead: number;
  messagesSkipped: number;
  messagesMissingId: number;
  messagesInvalidTimestamp: number;
  inserted: number;
  duplicates: number;
};

function state() {
  globalState.waState ??= { ...initialState };
  return globalState.waState;
}

function updateState(
  changes: Partial<Pick<WhatsAppState, "status" | "qrCode" | "lastError">>,
) {
  globalState.waState = {
    ...state(),
    ...changes,
    updatedAt: new Date().toISOString(),
  };
}

function positiveInteger(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function safeStartupError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Could not find Chrome")) {
    return "Chrome untuk Puppeteer belum terpasang. Jalankan `npx.cmd puppeteer browsers install chrome`, lalu restart server.";
  }
  if (/failed to launch|failed to start|spawn/i.test(message)) {
    return "Chrome gagal dijalankan. Pastikan Chrome/Puppeteer dapat berjalan dan PUPPETEER_EXECUTABLE_PATH benar jika diatur.";
  }
  if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_PROXY_CONNECTION_FAILED|Navigation timeout/i.test(message)) {
    return "Chrome tidak dapat membuka WhatsApp Web. Periksa koneksi internet, DNS, atau proxy komputer.";
  }
  if (/browser is already running|user data directory|SingletonLock|profile.*in use/i.test(message)) {
    return "Profil WhatsApp sedang dipakai proses lain. Hentikan server WhatsApp lain, lalu coba lagi.";
  }
  if (/evaluation failed|execution context|cannot find.*module|failed to inject/i.test(message)) {
    return "Injeksi WhatsApp Web gagal. Versi whatsapp-web.js mungkin perlu diperbarui.";
  }
  return "Inisialisasi WhatsApp gagal. Lihat log terminal server untuk detail.";
}

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message.slice(0, 1000),
      ...(error.stack ? { stack: error.stack.slice(0, 4000) } : {}),
    };
  }
  if (typeof error === "string") {
    return { name: "NonError", message: error.slice(0, 1000) };
  }
  try {
    return { name: "NonError", message: JSON.stringify(error).slice(0, 1000) };
  } catch {
    return { name: "NonError", message: "Unknown startup error" };
  }
}

function contactNumber(jid: string | undefined) {
  if (!jid) return null;
  const [user, server] = jid.split("@");
  if (server && server !== "c.us" && server !== "s.whatsapp.net") return null;
  if (!server) return null;
  const number = user?.split(":")[0]?.replace(/\D/g, "");
  return number && number.length >= 7 && number.length <= 15 ? number : null;
}

async function phoneNumberForWhatsAppId(
  client: Client,
  id: string,
  cache: Map<string, string | null>,
) {
  const phoneNumber = contactNumber(id);
  if (phoneNumber) return phoneNumber;
  if (!id.endsWith("@lid")) return null;
  if (cache.has(id)) return cache.get(id) ?? null;

  try {
    const [resolved] = await client.getContactLidAndPhone([id]);
    const number = contactNumber(resolved?.pn);
    cache.set(id, number);
    return number;
  } catch {
    cache.set(id, null);
    return null;
  }
}

async function conversationNumber(
  client: Client,
  chat: Chat,
  phoneCache: Map<string, string | null>,
) {
  const id = chat.id?._serialized ?? "";
  const phoneNumber = await phoneNumberForWhatsAppId(client, id, phoneCache);
  if (phoneNumber) return phoneNumber;
  if (!id.endsWith("@lid")) return null;

  try {
    const contact = await chat.getContact();
    return phoneNumberForWhatsAppId(
      client,
      contact.id?._serialized ?? "",
      phoneCache,
    );
  } catch {
    return null;
  }
}

export async function resolveWhatsAppLidPhoneNumbers(lidIds: string[]) {
  const client = globalState.waClient;
  const uniqueIds = [...new Set(lidIds)].filter((id) => /^\d+@lid$/.test(id));
  if (!uniqueIds.length) return new Map<string, string>();
  if (!client || state().status !== "ready") {
    throw new Error("WhatsApp must be connected to resolve phone numbers");
  }
  const resolved = new Map<string, string>();
  for (let index = 0; index < uniqueIds.length; index += 100) {
    const batch = uniqueIds.slice(index, index + 100);
    try {
      const pairs = await client.getContactLidAndPhone(batch);
      for (const pair of pairs) {
        const lid = pair.lid;
        const phone = contactNumber(pair.pn);
        if (lid && phone) resolved.set(lid, phone);
      }
    } catch (error) {
      console.error(
        `Could not resolve WhatsApp LID numbers ${JSON.stringify(errorDetails(error))}`,
      );
      throw new Error("Could not resolve WhatsApp phone numbers");
    }
  }
  return resolved;
}

function messageExternalId(message: Message) {
  const id = message.id;
  if (id?._serialized) return id._serialized;
  if (
    typeof id?.fromMe === "boolean" &&
    typeof id.remote === "string" &&
    typeof id.id === "string"
  ) {
    return `${id.fromMe ? "true" : "false"}_${id.remote}_${id.id}`;
  }
  return null;
}

async function toStoredMessage(
  client: Client,
  message: Message,
  conversationId: string,
  fallbackSenderName: string | null,
  phoneCache: Map<string, string | null>,
): Promise<NewWhatsAppMessage | null> {
  const externalId = messageExternalId(message);
  const messageAt = new Date(message.timestamp * 1000);
  if (!externalId || !Number.isFinite(messageAt.getTime())) return null;

  let senderPhone: string | null = null;
  let senderName = fallbackSenderName;
  if (!message.fromMe) {
    try {
      const contact = await message.getContact();
      senderPhone = await phoneNumberForWhatsAppId(
        client,
        message.from || contact.id?._serialized || "",
        phoneCache,
      );
      senderName = contact.pushname || contact.name || senderName;
    } catch {
      senderPhone = await phoneNumberForWhatsAppId(
        client,
        message.author || message.from || "",
        phoneCache,
      );
      senderName = fallbackSenderName;
    }
  }

  const body = message.body?.trim() ?? "";
  const hasMedia = Boolean(message.hasMedia);
  const messageType = message.type || "unknown";
  const placeholder = body || (hasMedia ? `[media:${messageType}]` : `[${messageType} message]`);

  return {
    conversation_id: conversationId,
    message_at: messageAt.toISOString(),
    direction: message.fromMe ? "outbound" : "inbound",
    sender_phone: senderPhone,
    sender_name: senderName,
    body: placeholder,
    raw_line: null,
    source: "whatsapp",
    external_id: externalId,
    metadata: {
      type: messageType,
      hasMedia,
      isForwarded: message.isForwarded,
      hasQuotedMessage: message.hasQuotedMsg,
    },
  };
}

async function synchronizeChats(): Promise<SyncResult> {
  const client = globalState.waClient;
  if (!client || state().status !== "ready") {
    throw new Error("WhatsApp client is not ready");
  }

  const maxChats = positiveInteger("WA_SYNC_MAX_CHATS", 500, 10_000);
  const messageLimit = positiveInteger("WA_SYNC_MESSAGES_PER_CHAT", 100, 1000);
  if (!client.pupPage) throw new Error("WhatsApp browser page is unavailable");
  const { chatsFound, directChatData, chatDomains } = await client.pupPage.evaluate(() => {
    type BrowserChat = {
      id?: { _serialized?: string };
      formattedTitle?: string;
      isGroup?: boolean;
      groupMetadata?: unknown;
    };
    type ChatCollection = { getModelsArray?: () => BrowserChat[] };
    type WhatsAppWindow = Window & {
      require?: (moduleName: string) => { Chat?: ChatCollection };
    };

    const models =
      (window as WhatsAppWindow).require?.("WAWebCollections").Chat
        ?.getModelsArray?.() ?? [];
    const chats: DirectChatData[] = [];
    const domains: Record<string, number> = {};
    for (const model of models) {
      const id = model.id?._serialized;
      const domain = typeof id === "string" ? id.split("@").pop() ?? "unknown" : "unknown";
      domains[domain] = (domains[domain] ?? 0) + 1;
      const isPrivateAddress =
        typeof id === "string" &&
        (id.endsWith("@c.us") ||
          id.endsWith("@s.whatsapp.net") ||
          id.endsWith("@lid"));
      if (!isPrivateAddress || model.isGroup || model.groupMetadata) continue;
      chats.push({
        id: { _serialized: id },
        formattedTitle:
          typeof model.formattedTitle === "string" ? model.formattedTitle : "",
        isGroup: false,
      });
    }
    return { chatsFound: models.length, directChatData: chats, chatDomains: domains };
  });
  const chats = directChatData
    .slice(0, maxChats)
    .map((chat) => new whatsappModule.Chat(client, chat));

  if (!chats.length) {
    console.info(
      `WhatsApp sync found ${chatsFound} chats and no supported direct chats; domains=${JSON.stringify(chatDomains)}`,
    );
  }
  let inserted = 0;
  let duplicates = 0;
  let messagesRead = 0;
  let messagesSkipped = 0;
  let messagesMissingId = 0;
  let messagesInvalidTimestamp = 0;
  const phoneCache = new Map<string, string | null>();

  for (const [index, chat] of chats.entries()) {
    const phoneNumber = await conversationNumber(client, chat, phoneCache);
    if (!phoneNumber) continue;
    let conversation;
    try {
      conversation = await findOrCreateConversation(
        phoneNumber,
        chat.name?.trim() || null,
      );
    } catch (error) {
      const reason =
        error instanceof SupabaseError
          ? `Supabase error ${error.status}: ${error.message}`
          : "unexpected database error";
      console.error(`Could not save WhatsApp conversation #${index + 1}: ${reason}`);
      throw new Error(`Could not save WhatsApp conversation #${index + 1}: ${reason}`);
    }

    let messages: Message[];
    try {
      messages = await chat.fetchMessages({ limit: messageLimit });
    } catch (error) {
      console.error(
        `Could not read WhatsApp chat #${index + 1} ${JSON.stringify(errorDetails(error))}`,
      );
      throw new Error(`Could not read messages from WhatsApp chat #${index + 1}`);
    }
    messagesRead += messages.length;
    const normalized: NewWhatsAppMessage[] = [];
    for (const message of messages) {
      if (!messageExternalId(message)) messagesMissingId += 1;
      if (!Number.isFinite(new Date(message.timestamp * 1000).getTime())) {
        messagesInvalidTimestamp += 1;
      }
      const stored = await toStoredMessage(
        client,
        message,
        conversation.id,
        chat.name?.trim() || null,
        phoneCache,
      );
      if (stored) normalized.push(stored);
    }
    messagesSkipped += messages.length - normalized.length;

    let result: { inserted: number; duplicates: number };
    try {
      result = await persistWhatsAppMessages(normalized);
    } catch (error) {
      const reason =
        error instanceof SupabaseError
          ? `Supabase error ${error.status}: ${error.message}`
          : "unexpected database error";
      console.error(`Could not save messages for WhatsApp chat #${index + 1}: ${reason}`);
      throw new Error(`Could not save messages for WhatsApp chat #${index + 1}: ${reason}`);
    }
    inserted += result.inserted;
    duplicates += result.duplicates;
  }

  return {
    chatsFound,
    directChats: directChatData.length,
    chatDomains,
    messagesRead,
    messagesSkipped,
    messagesMissingId,
    messagesInvalidTimestamp,
    inserted,
    duplicates,
  };
}

export function getWhatsAppStatus() {
  return { ...state() };
}

export async function startWhatsApp() {
  if (globalState.waInitPromise) return globalState.waInitPromise;

  globalState.waInitPromise = (async () => {
    positiveInteger("WA_SYNC_INTERVAL_MS", 300_000, 86_400_000);
    positiveInteger("WA_SYNC_MESSAGES_PER_CHAT", 100, 1000);
    positiveInteger("WA_SYNC_MAX_CHATS", 500, 10_000);
    const authPath = resolve(
      /* turbopackIgnore: true */
      process.env.WA_HISTORY_AUTH_PATH ?? "./data/whatsapp-auth",
    );
    await mkdir(authPath, { recursive: true, mode: 0o700 });
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: authPath }),
      puppeteer: {
        headless: true,
        ...(process.env.PUPPETEER_EXECUTABLE_PATH
          ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
          : {}),
      },
    });
    globalState.waClient = client;
    updateState({ status: "starting", qrCode: null, lastError: null });

    client.on("qr", (qr) => updateState({ status: "qr", qrCode: qr, lastError: null }));
    client.on("authenticated", () =>
      updateState({ status: "authenticated", qrCode: null, lastError: null }),
    );
    client.on("ready", () => {
      updateState({ status: "ready", qrCode: null, lastError: null });
      if (globalState.waSyncTimer) clearInterval(globalState.waSyncTimer);
      const intervalMs = positiveInteger("WA_SYNC_INTERVAL_MS", 300_000, 86_400_000);
      globalState.waSyncTimer = setInterval(() => {
        void synchronizeWhatsApp().catch((error: unknown) => {
          console.error(
            `WhatsApp history sync failed ${JSON.stringify(errorDetails(error))}`,
          );
        });
      }, intervalMs);
      void synchronizeWhatsApp().catch((error: unknown) => {
        console.error(
          `Initial WhatsApp history sync failed ${JSON.stringify(errorDetails(error))}`,
        );
      });
    });
    client.on("auth_failure", () => {
      updateState({ status: "error", lastError: "WhatsApp authentication failed" });
      console.error("WhatsApp authentication failed");
    });
    client.on("disconnected", () => {
      updateState({ status: "disconnected", qrCode: null });
      console.error("WhatsApp client disconnected");
    });

    try {
      await client.initialize();
    } catch (error) {
      const safeMessage = safeStartupError(error);
      updateState({ status: "error", lastError: safeMessage });
      console.error(
        `WhatsApp client initialization failed ${JSON.stringify(errorDetails(error))}`,
      );
      try {
        await client.destroy();
      } catch (cleanupError) {
        console.error(
          `WhatsApp client cleanup failed ${JSON.stringify(errorDetails(cleanupError))}`,
        );
      }
      globalState.waClient = undefined;
      globalState.waInitPromise = undefined;
      throw error;
    }
  })();

  return globalState.waInitPromise;
}

export async function disconnectWhatsApp() {
  if (globalState.waSyncTimer) {
    clearInterval(globalState.waSyncTimer);
    globalState.waSyncTimer = undefined;
  }
  const client = globalState.waClient;
  globalState.waClient = undefined;
  globalState.waInitPromise = undefined;
  updateState({ status: "disconnected", qrCode: null, lastError: null });
  if (client) await client.logout();
}

export async function synchronizeWhatsApp() {
  if (globalState.waSyncPromise) return globalState.waSyncPromise;
  globalState.waSyncPromise = synchronizeChats().finally(() => {
    globalState.waSyncPromise = undefined;
  });
  return globalState.waSyncPromise;
}
