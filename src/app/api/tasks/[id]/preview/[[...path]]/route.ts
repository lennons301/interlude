import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Path-based preview proxy — local dev fallback.
 * In production, subdomain routing (custom-server.js) handles preview traffic
 * directly, bypassing this route entirely.
 */
async function proxyRequest(
  request: Request,
  taskId: string,
  path: string
): Promise<Response> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (!task.devPort || !task.containerName) {
    return NextResponse.json(
      { error: "No dev server running" },
      { status: 503 }
    );
  }

  const reqUrl = new URL(request.url);
  const targetUrl = `http://${task.containerName}:${task.devPort}/${path}${reqUrl.search}`;

  try {
    const headers = new Headers(request.headers);
    headers.set("Host", `${task.containerName}:${task.devPort}`);
    headers.delete("connection");

    const proxyRes = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method !== "GET" && request.method !== "HEAD"
        ? request.body
        : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });

    const body = await proxyRes.text();

    const responseHeaders = new Headers();
    for (const [key, value] of proxyRes.headers) {
      if (["x-frame-options", "content-security-policy", "content-encoding", "transfer-encoding", "content-length"].includes(key.toLowerCase())) continue;
      responseHeaders.set(key, value);
    }

    return new Response(body, {
      status: proxyRes.status,
      headers: responseHeaders,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[preview-proxy] Error proxying to ${targetUrl}:`, msg);
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return NextResponse.json({ error: "Dev server timeout" }, { status: 504 });
    }
    return NextResponse.json(
      { error: `Dev server unavailable: ${msg}` },
      { status: 502 }
    );
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; path?: string[] }> }
) {
  const { id, path } = await params;
  return proxyRequest(request, id, path?.join("/") ?? "");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; path?: string[] }> }
) {
  const { id, path } = await params;
  return proxyRequest(request, id, path?.join("/") ?? "");
}
