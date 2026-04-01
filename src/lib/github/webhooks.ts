import { createHmac, timingSafeEqual } from "crypto";
import { getConfig } from "../config";

export function verifyWebhookSignature(
  payload: string,
  signature: string | null
): boolean {
  const secret = getConfig().githubWebhookSecret;
  if (!secret || !signature) return false;

  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");

  if (expected.length !== signature.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
