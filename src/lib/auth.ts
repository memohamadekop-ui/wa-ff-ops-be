import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export type AuthResult = { ok: true } | { ok: false; status: 401 | 500 };

function secretMatches(received: string | null, expected: string | undefined) {
  if (!received || !expected) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export function authorizeOcc(request: NextRequest): AuthResult {
  const expected = process.env.OCC_BACKEND_SHARED_SECRET;
  if (!expected) {
    console.error("OCC_BACKEND_SHARED_SECRET is not configured");
    return { ok: false, status: 500 };
  }

  if (
    !secretMatches(
      request.headers.get("x-occ-backend-secret"),
      expected,
    )
  ) {
    return { ok: false, status: 401 };
  }
  return { ok: true };
}

export function authorizeWorker(request: NextRequest): AuthResult {
  const expected = process.env.WA_HISTORY_CALLBACK_SECRET;
  if (!expected) {
    console.error("WA_HISTORY_CALLBACK_SECRET is not configured");
    return { ok: false, status: 500 };
  }

  if (
    !secretMatches(
      request.headers.get("x-wa-worker-secret"),
      expected,
    )
  ) {
    return { ok: false, status: 401 };
  }
  return { ok: true };
}
