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
  type MessageRow,
} from "@/lib/supabase";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = authorizeOcc(request);
  if (!auth.ok) return jsonError(auth.status, auth.status === 401 ? "Unauthorized" : "Server configuration error");

  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return jsonError(400, "Invalid conversation ID");
  }

  const params = request.nextUrl.searchParams;
  const pagination = parsePagination(params);
  if (!pagination) return jsonError(400, "Invalid limit or offset");
  const search = params.get("q")?.trim();
  if (search && search.length > 200) return jsonError(400, "Search query is too long");

  try {
    const rows = await supabaseRequest<MessageRow[]>("wa_messages", {
      select: "*",
      conversation_id: `eq.${id}`,
      order: "message_at.asc,id.asc",
      limit: pagination.limit + 1,
      offset: pagination.offset,
      ...(search
        ? { or: `(body.ilike.${ilikePattern(search)},external_id.ilike.${ilikePattern(search)})` }
        : {}),
    });
    const hasMore = rows.length > pagination.limit;
    return jsonSuccess(rows.slice(0, pagination.limit), {
      pagination: paginationResult(pagination.limit, pagination.offset, hasMore),
    });
  } catch (error) {
    const status = error instanceof SupabaseError ? error.status : 502;
    if (!(error instanceof SupabaseError)) console.error("Message query failed", error);
    return jsonError(status, error instanceof SupabaseError ? error.message : "Could not load messages");
  }
}
