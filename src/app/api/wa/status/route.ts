import { authorizeOcc } from "@/lib/auth";
import { jsonError, jsonSuccess } from "@/lib/http";
import { getWhatsAppStatus } from "@/lib/whatsapp";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export function GET(request: NextRequest) {
  const auth = authorizeOcc(request);
  if (!auth.ok) return jsonError(auth.status, auth.status === 401 ? "Unauthorized" : "Server configuration error");
  return jsonSuccess(getWhatsAppStatus());
}
