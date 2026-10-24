import { NextResponse } from "next/server";

export function jsonError(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status });
}

export function jsonSuccess<T>(data: T, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ success: true, data, ...extra });
}

export function parsePagination(params: URLSearchParams) {
  const rawLimit = params.get("limit");
  const rawOffset = params.get("offset");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1_000_000
  ) {
    return null;
  }

  return { limit, offset };
}

export function paginationResult(limit: number, offset: number, hasMore: boolean) {
  return { limit, offset, hasMore };
}
