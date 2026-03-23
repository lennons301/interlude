import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

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

    // Read entire response as text to avoid stream piping issues
    const body = await proxyRes.text();

    const responseHeaders = new Headers();
    responseHeaders.set("content-type", proxyRes.headers.get("content-type") ?? "text/html");
    // Don't copy headers that block iframe embedding
    for (const [key, value] of proxyRes.headers) {
      if (["x-frame-options", "content-security-policy", "content-encoding", "transfer-encoding", "content-length"].includes(key.toLowerCase())) continue;
      responseHeaders.set(key, value);
    }

    // Inject base tag for correct asset path resolution
    const contentType = responseHeaders.get("content-type") ?? "";
    let finalBody = body;
    if (contentType.includes("text/html")) {
      const baseTag = `<base href="/api/tasks/${taskId}/preview/">`;
      finalBody = body.includes("<head>")
        ? body.replace("<head>", `<head>${baseTag}`)
        : body.includes("<head ")
          ? body.replace(/<head\s[^>]*>/, `$&${baseTag}`)
          : `${baseTag}${body}`;
    }

    return new Response(finalBody, {
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
  try {
    const { id, path } = await params;
    return await proxyRequest(request, id, path?.join("/") ?? "");
  } catch (err) {
    console.error("[preview-proxy] Unhandled error in GET:", err);
    return NextResponse.json({ error: "Internal proxy error" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; path?: string[] }> }
) {
  try {
    const { id, path } = await params;
    return await proxyRequest(request, id, path?.join("/") ?? "");
  } catch (err) {
    console.error("[preview-proxy] Unhandled error in POST:", err);
    return NextResponse.json({ error: "Internal proxy error" }, { status: 500 });
  }
}
