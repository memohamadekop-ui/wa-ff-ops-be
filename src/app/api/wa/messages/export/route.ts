import ExcelJS from "exceljs";
import { authorizeOcc } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import {
  ilikePattern,
  SupabaseError,
  supabaseRequest,
  type ConversationRow,
  type MessageRow,
} from "@/lib/supabase";
import { resolveWhatsAppLidPhoneNumbers } from "@/lib/whatsapp";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

const PAGE_SIZE = 500;
const MAX_EXPORT_ROWS = 10_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function inFilter(values: string[]) {
  return `in.(${values.join(",")})`;
}

function formatWhatsAppTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(value));
}

function lidIdFromMessage(message: MessageRow) {
  const match = message.external_id?.match(/^(?:true|false)_(\d+@lid)_/);
  return match?.[1] ?? null;
}

export async function GET(request: NextRequest) {
  const auth = authorizeOcc(request);
  if (!auth.ok) {
    return jsonError(
      auth.status,
      auth.status === 401 ? "Unauthorized" : "Server configuration error",
    );
  }

  const params = request.nextUrl.searchParams;
  const search = params.get("q")?.trim();
  const conversationId = params.get("conversationId");
  if (!search) return jsonError(400, "A search query is required");
  if (search.length > 200) return jsonError(400, "Search query is too long");
  if (conversationId && !UUID_PATTERN.test(conversationId)) {
    return jsonError(400, "Invalid conversation ID");
  }

  try {
    const messages: MessageRow[] = [];
    let offset = 0;
    while (messages.length <= MAX_EXPORT_ROWS) {
      const limit = Math.min(PAGE_SIZE, MAX_EXPORT_ROWS + 1 - messages.length);
      const page = await supabaseRequest<MessageRow[]>("wa_messages", {
        select: "*",
        ...(conversationId ? { conversation_id: `eq.${conversationId}` } : {}),
        or: `(body.ilike.${ilikePattern(search)},external_id.ilike.${ilikePattern(search)})`,
        order: conversationId ? "message_at.asc,id.asc" : "message_at.desc,id.desc",
        limit,
        offset,
      });
      messages.push(...page);
      if (messages.length > MAX_EXPORT_ROWS) {
        return jsonError(
          413,
          `More than ${MAX_EXPORT_ROWS} messages match. Refine the search before exporting.`,
        );
      }
      if (page.length < limit) break;
      offset += page.length;
    }

    const conversationIds = [...new Set(messages.map((message) => message.conversation_id))];
    const lidIds = messages
      .map(lidIdFromMessage)
      .filter((id): id is string => id !== null);
    const resolvedLidPhones = await resolveWhatsAppLidPhoneNumbers(lidIds);
    const conversations = new Map<string, ConversationRow>();
    for (let index = 0; index < conversationIds.length; index += 100) {
      const rows = await supabaseRequest<ConversationRow[]>("wa_conversations", {
        select: "id,phone_number,display_name,last_message_at,created_at,updated_at",
        id: inFilter(conversationIds.slice(index, index + 100)),
      });
      for (const conversation of rows) conversations.set(conversation.id, conversation);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "WhatsApp History";
    workbook.created = new Date();
    const worksheet = workbook.addWorksheet("Hasil Pencarian");
    worksheet.columns = [
      { header: "Tanggal & Waktu", key: "timestamp", width: 22 },
      { header: "Nomor WhatsApp", key: "phone", width: 22 },
      { header: "Pengirim", key: "sender", width: 24 },
      { header: "Pesan", key: "body", width: 60 },
      { header: "Arah", key: "direction", width: 14 },
      { header: "ID Pesan", key: "externalId", width: 42 },
      { header: "Format WhatsApp", key: "formatted", width: 90 },
    ];
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    worksheet.autoFilter = { from: "A1", to: "G1" };
    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF176B4D" },
    };

    for (const message of messages) {
      const conversation = conversations.get(message.conversation_id);
      const lidId = lidIdFromMessage(message);
      const phoneNumber = lidId
        ? resolvedLidPhones.get(lidId) ?? "Nomor tidak tersedia"
        : conversation?.phone_number ||
          (message.direction === "inbound" ? message.sender_phone : null) ||
          "";
      const sender =
        message.direction === "outbound"
          ? "Anda"
          : phoneNumber ||
            message.sender_name ||
            "Tidak diketahui";
      const timestamp = new Date(message.message_at);
      const body = message.body || "[pesan tanpa teks]";
      worksheet.addRow({
        timestamp,
        phone: phoneNumber,
        sender,
        body,
        direction: message.direction,
        externalId: message.external_id ?? "",
        formatted: `[${formatWhatsAppTimestamp(message.message_at)}] ${sender}: ${body}`,
      });
    }
    worksheet.getColumn("timestamp").numFmt = "dd/mm/yyyy hh:mm:ss";
    worksheet.getColumn("body").alignment = { vertical: "top", wrapText: true };
    worksheet.getColumn("formatted").alignment = { vertical: "top", wrapText: true };
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) row.alignment = { vertical: "top" };
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="whatsapp-search-results.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const status = error instanceof SupabaseError ? error.status : 502;
    if (!(error instanceof SupabaseError)) {
      console.error("WhatsApp Excel export failed", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return jsonError(
      status,
      error instanceof SupabaseError
        ? error.message
        : "Could not export WhatsApp search results",
    );
  }
}
