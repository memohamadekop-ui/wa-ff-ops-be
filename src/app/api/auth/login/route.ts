import { compare, hashSync } from "bcryptjs";
import { randomBytes } from "node:crypto";
import { createUserSession } from "@/lib/auth";
import { jsonError, jsonSuccess } from "@/lib/http";
import { SupabaseError, supabaseRequest } from "@/lib/supabase";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

type UserRow = {
  id: number;
  email: string;
  password: string | null;
  role_id: number;
};

const attempts = new Map<string, { count: number; resetAt: number }>();
const maxAttempts = 10;
const windowMs = 15 * 60 * 1000;
const dummyPasswordHash = hashSync(randomBytes(32).toString("hex"), 10);

function isRateLimited(key: string) {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    if (attempts.size > 5000) {
      for (const [entry, value] of attempts) {
        if (value.resetAt <= now) attempts.delete(entry);
      }
    }
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  current.count += 1;
  return current.count > maxAttempts;
}

function rateLimitKey(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
}

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 4096) return jsonError(413, "Permintaan login terlalu besar");
  if (isRateLimited(rateLimitKey(request))) {
    return jsonError(429, "Terlalu banyak percobaan login. Coba lagi beberapa menit.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Format permintaan login tidak valid");
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("email" in body) ||
    !("password" in body) ||
    typeof body.email !== "string" ||
    typeof body.password !== "string"
  ) {
    return jsonError(400, "Email dan password wajib diisi");
  }

  const email = body.email.trim().toLocaleLowerCase("en-US");
  const password = body.password;
  if (
    email.length > 254 ||
    password.length === 0 ||
    password.length > 256 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return jsonError(400, "Email atau password tidak valid");
  }

  if (isRateLimited(`email:${email}`)) {
    return jsonError(429, "Terlalu banyak percobaan login. Coba lagi beberapa menit.");
  }

  try {
    const users = await supabaseRequest<UserRow[]>("tb_user", {
      select: "id,email,password,role_id",
      email: `eq.${email}`,
      role_id: "eq.1",
      limit: 1,
    });
    const user = users[0];
    const passwordHash =
      user?.password?.replace(/^\$2y\$/, "$2b$") ?? dummyPasswordHash;
    const passwordMatches = await compare(password, passwordHash);

    if (!user || user.role_id !== 1 || !passwordMatches) {
      return jsonError(401, "Email atau password salah");
    }

    const token = createUserSession({ id: user.id, email: user.email });
    return jsonSuccess({ token, user: { email: user.email } });
  } catch (error) {
    if (error instanceof SupabaseError) {
      return jsonError(error.status, error.message);
    }
    console.error("Supabase table login failed", error);
    return jsonError(500, "Login tidak dapat diproses");
  }
}
