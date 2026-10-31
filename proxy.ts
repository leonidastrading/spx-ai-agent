import { NextResponse, type NextRequest } from "next/server";
import { checkBasicAuth } from "@/lib/auth";

/** Basic auth on everything except the cron endpoint (own secret) and /api/health. */
export function proxy(request: NextRequest) {
  if (checkBasicAuth(request.headers.get("authorization"))) return NextResponse.next();
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="book-advisor", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!api/cron|api/health|_next/static|_next/image|favicon.ico).*)"],
};
