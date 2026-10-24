import { authorizeOcc } from "@/lib/auth";
import { jsonError, jsonSuccess } from "@/lib/http";
import { disconnectWhatsApp } from "@/lib/whatsapp";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = authorizeOcc(request);
  if (!auth.ok) return jsonError(auth.status, auth.status === 401 ? "Unauthorized" : "Server configuration error");

  try {
    await disconnectWhatsApp();
    return jsonSuccess({ status: "disconnected" });
  } catch {
    console.error("WhatsApp disconnect failed");
    return jsonError(502, "WhatsApp could not be disconnected");
  }
}
