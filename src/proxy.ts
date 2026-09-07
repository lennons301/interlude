import { NextResponse, type NextRequest } from "next/server";
import { BASIC_CHALLENGE, decideOperatorAuth } from "@/lib/operator-auth";

/**
 * The operator gate (issue #242), applied to every request Next serves —
 * pages, API routes, SSE streams and static assets alike — before any handler
 * runs. The decision itself is `decideOperatorAuth`, pure and tested; this
 * only turns it into a response. No `matcher`: an exemption expressed here
 * would be a second list the test cannot see, so every path goes through the
 * one function and the exempt set has one home.
 *
 * Next 16 runs this on the Node.js runtime. Requests for preview subdomains
 * (`task-*.DOMAIN`) never arrive: `custom-server.js` proxies those to the agent
 * container by Host header before Next sees them.
 */
export function proxy(request: NextRequest) {
  const decision = decideOperatorAuth({
    pathname: request.nextUrl.pathname,
    authorization: request.headers.get("authorization"),
    password: process.env.OPERATOR_PASSWORD ?? null,
    production: process.env.NODE_ENV === "production",
  });

  if (decision.kind === "allow") return NextResponse.next();

  if (decision.kind === "misconfigured") {
    return new NextResponse(
      "Operator credential not configured: set OPERATOR_PASSWORD (Doppler interlude/prd) and restart the app.",
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }

  return new NextResponse("Unauthorized", {
    status: 401,
    headers: { "www-authenticate": BASIC_CHALLENGE, "cache-control": "no-store" },
  });
}
