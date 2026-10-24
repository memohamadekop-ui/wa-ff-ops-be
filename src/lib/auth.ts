import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export type AuthResult = { ok: true } | { ok: false; status: 401 | 500 };

type SessionPayload = {
  sub: string;
  email: string;
  role_id: 1;
  exp: number;
};

function secretMatches(received: string | null, expected: string | undefined) {
  if (!received || !expected) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

function tokenSecret() {
  const secret = process.env.WA_AUTH_TOKEN_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("WA_AUTH_TOKEN_SECRET must be at least 32 bytes");
  }
  return secret;
}

function sign(encodedPayload: string) {
  return createHmac("sha256", tokenSecret()).update(encodedPayload).digest("base64url");
}

export function createUserSession(user: { id: number; email: string }) {
  const payload: SessionPayload = {
    sub: String(user.id),
    email: user.email,
    role_id: 1,
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

function validUserSession(token: string) {
  const [encodedPayload, receivedSignature, extra] = token.split(".");
  if (!encodedPayload || !receivedSignature || extra) return false;

  let expectedSignature: string;
  try {
    expectedSignature = sign(encodedPayload);
  } catch (error) {
    console.error("User session signing is not configured", error);
    return null;
  }

  const received = Buffer.from(receivedSignature);
  const expected = Buffer.from(expectedSignature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>;
    return (
      typeof payload.sub === "string" &&
      payload.sub.length > 0 &&
      typeof payload.email === "string" &&
      payload.role_id === 1 &&
      typeof payload.exp === "number" &&
      payload.exp > Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}

export function authorizeOcc(request: NextRequest): AuthResult {
  const expected = process.env.OCC_BACKEND_SHARED_SECRET;
  if (expected && secretMatches(request.headers.get("x-occ-backend-secret"), expected)) {
    return { ok: true };
  }

  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match) return { ok: false, status: 401 };

  const valid = validUserSession(match[1]);
  if (valid === null) return { ok: false, status: 500 };
  return valid ? { ok: true } : { ok: false, status: 401 };
}

export function authorizeWorker(request: NextRequest): AuthResult {
  const expected = process.env.WA_HISTORY_CALLBACK_SECRET;
  if (!expected) {
    console.error("WA_HISTORY_CALLBACK_SECRET is not configured");
    return { ok: false, status: 500 };
  }

  if (!secretMatches(request.headers.get("x-wa-worker-secret"), expected)) {
    return { ok: false, status: 401 };
  }
  return { ok: true };
}
