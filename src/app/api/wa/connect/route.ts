import { authorizeOcc } from "@/lib/auth";
import { jsonError, jsonSuccess } from "@/lib/http";
import { getWhatsAppStatus, startWhatsApp } from "@/lib/whatsapp";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = authorizeOcc(request);
  if (!auth.ok) return jsonError(auth.status, auth.status === 401 ? "Unauthorized" : "Server configuration error");

  try {
    await startWhatsApp();
    return jsonSuccess(getWhatsAppStatus());
  } catch {
    const status = getWhatsAppStatus();
    return jsonError(502, status.lastError ?? "WhatsApp could not be started");
  }
}
