import { authorizeOcc } from "@/lib/auth";
import {
  jsonError,
  jsonSuccess,
  paginationResult,
  parsePagination,
} from "@/lib/http";
import {
  ilikePattern,
  SupabaseError,
  supabaseRequest,
  type ConversationRow,
} from "@/lib/supabase";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = authorizeOcc(request);
  if (!auth.ok) return jsonError(auth.status, auth.status === 401 ? "Unauthorized" : "Server configuration error");

  const params = request.nextUrl.searchParams;
  const pagination = parsePagination(params);
  if (!pagination) return jsonError(400, "Invalid limit or offset");
  const search = params.get("q")?.trim();
  if (search && search.length > 200) return jsonError(400, "Search query is too long");

  try {
    const rows = await supabaseRequest<ConversationRow[]>("wa_conversations", {
      select: "*",
      order: "last_message_at.desc.nullslast,created_at.desc",
      limit: pagination.limit + 1,
      offset: pagination.offset,
      ...(search
        ? {
            or: `(phone_number.ilike.${ilikePattern(search)},display_name.ilike.${ilikePattern(search)})`,
          }
        : {}),
    });
    const hasMore = rows.length > pagination.limit;
    return jsonSuccess(rows.slice(0, pagination.limit), {
      pagination: paginationResult(pagination.limit, pagination.offset, hasMore),
    });
  } catch (error) {
    const status = error instanceof SupabaseError ? error.status : 502;
    if (!(error instanceof SupabaseError)) console.error("Conversation query failed", error);
    return jsonError(status, error instanceof SupabaseError ? error.message : "Could not load conversations");
  }
}
