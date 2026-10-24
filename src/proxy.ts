import { NextRequest, NextResponse } from "next/server";

function allowedOrigins() {
  return (process.env.WA_HISTORY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, x-occ-backend-secret",
    "Access-Control-Expose-Headers": "Content-Disposition",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function proxy(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return NextResponse.next();

  if (!allowedOrigins().includes(origin)) {
    return new NextResponse("Origin not allowed", { status: 403 });
  }

  const headers = corsHeaders(origin);
  if (request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers });
  }

  const response = NextResponse.next();
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
