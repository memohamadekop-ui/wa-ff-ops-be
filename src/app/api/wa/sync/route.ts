import { authorizeOcc } from "@/lib/auth";
import { jsonError, jsonSuccess } from "@/lib/http";
import { SupabaseError } from "@/lib/supabase";
import { synchronizeWhatsApp } from "@/lib/whatsapp";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = authorizeOcc(request);
  if (!auth.ok) {
    return jsonError(
      auth.status,
      auth.status === 401 ? "Unauthorized" : "Server configuration error",
    );
  }

  try {
    return jsonSuccess(await synchronizeWhatsApp());
  } catch (error) {
    const status = error instanceof SupabaseError ? error.status : 502;
    const message =
      error instanceof Error ? error.message : "WhatsApp history sync failed";
    console.error(`Manual WhatsApp sync failed ${JSON.stringify({
      name: error instanceof Error ? error.name : "UnknownError",
      message: message.slice(0, 500),
    })}`);
    return jsonError(status, message);
  }
}
