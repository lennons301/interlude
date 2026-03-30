import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Caddy on_demand_tls validation endpoint.
 * Called before provisioning a TLS cert for a subdomain.
 * Returns 200 if the subdomain belongs to a valid task with a dev server.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const domain = searchParams.get("domain");
  const baseDomain = process.env.DOMAIN;

  if (!domain || !baseDomain) {
    return new Response("", { status: 403 });
  }

  // Extract subdomain prefix (e.g. "task-abc123" from "task-abc123.interludes.co.uk")
  const suffix = `.${baseDomain}`;
  if (!domain.endsWith(suffix)) {
    return new Response("", { status: 403 });
  }

  const subdomain = domain.slice(0, -suffix.length);
  if (!subdomain || !subdomain.startsWith("task-")) {
    return new Response("", { status: 403 });
  }

  const task = db
    .select({ id: tasks.id, devPort: tasks.devPort })
    .from(tasks)
    .where(eq(tasks.previewSubdomain, subdomain))
    .get();

  if (!task || !task.devPort) {
    return new Response("", { status: 403 });
  }

  return new Response("ok", { status: 200 });
}
