import { authorizeWorker } from "@/lib/auth";
import { jsonError, jsonSuccess } from "@/lib/http";
import {
  persistWhatsAppMessages,
  type NewWhatsAppMessage,
  SupabaseError,
  supabaseRequest,
  type ConversationRow,
} from "@/lib/supabase";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1_000_000;
const MAX_BATCH_SIZE = 200;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
let requestWindowStartedAt = 0;
let requestCount = 0;

function validMessage(value: unknown): value is NewWhatsAppMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.conversation_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      message.conversation_id,
    ) &&
    typeof message.message_at === "string" &&
    Number.isFinite(Date.parse(message.message_at)) &&
    ["inbound", "outbound", "system", "unknown"].includes(String(message.direction)) &&
    typeof message.body === "string" &&
    (message.raw_line === null || typeof message.raw_line === "string") &&
    message.source === "whatsapp" &&
    typeof message.external_id === "string" &&
    message.external_id.length > 0 &&
    message.external_id.length <= 512 &&
    (message.sender_phone === null || typeof message.sender_phone === "string") &&
    (message.sender_name === null || typeof message.sender_name === "string") &&
    !!message.metadata &&
    typeof message.metadata === "object" &&
    !Array.isArray(message.metadata)
  );
}

export async function POST(request: NextRequest) {
  const auth = authorizeWorker(request);
  if (!auth.ok) return jsonError(auth.status, auth.status === 401 ? "Unauthorized" : "Server configuration error");

  const now = Date.now();
  if (now - requestWindowStartedAt >= RATE_WINDOW_MS) {
    requestWindowStartedAt = now;
    requestCount = 0;
  }
  requestCount += 1;
  if (requestCount > RATE_LIMIT) {
    return jsonError(429, "Too many sync requests");
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return jsonError(413, "Request body is too large");

  let payload: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) return jsonError(400, "Request body is required");
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return jsonError(413, "Request body is too large");
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    payload = JSON.parse(body);
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const messages = (payload as { messages?: unknown } | null)?.messages;
  if (
    !Array.isArray(messages) ||
    messages.length > MAX_BATCH_SIZE ||
    !messages.every(validMessage)
  ) {
    return jsonError(400, "Invalid sync batch");
  }

  try {
    const conversationIds = [...new Set(messages.map((message) => message.conversation_id))];
    if (conversationIds.length) {
      const rows = await supabaseRequest<Pick<ConversationRow, "id">[]>(
        "wa_conversations",
        { select: "id", id: `in.(${conversationIds.join(",")})`, limit: conversationIds.length },
      );
      if (rows.length !== conversationIds.length) {
        return jsonError(404, "A conversation in the sync batch was not found");
      }
    }
    const result = await persistWhatsAppMessages(messages);
    return jsonSuccess(result);
  } catch (error) {
    const status = error instanceof SupabaseError ? error.status : 502;
    if (!(error instanceof SupabaseError)) console.error("WhatsApp sync batch failed", error);
    return jsonError(status, error instanceof SupabaseError ? error.message : "Could not save WhatsApp messages");
  }
}
