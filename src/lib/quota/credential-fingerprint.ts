/**
 * A non-secret fingerprint of the credential(s) currently backing a lane
 * (issue #251 — the wedge a rotated credential leaves in the quota gate).
 *
 * `quota-gate.ts` and the fleet dashboard both trust the last `rate_limit_event`
 * observed on a lane as still describing that lane's account *now*, aged out
 * only by its own `resetsAt` (or, absent one, after five hours — see
 * `QUOTA_OBSERVATION_STALE_MS`). That is sound for one account whose wall
 * comes and goes on its own window. It breaks the moment the credential behind
 * the lane is swapped for a different account: the observation is still about
 * the *old* account, and nothing before this module told the two apart. On
 * 2026-09-20 that swap went from an Enterprise seat (a rejection dated a month
 * out, by that plan's own reset) to a Pro seat (session windows measured in
 * hours) on the same subscription lane id — the new, perfectly usable account
 * inherited a wall dated for an account it had never been, and every
 * autonomous pass and interactive session on the lane stayed refused for what
 * would have been the rest of the month, because closing that wall requires a
 * successful call on the lane and the wall was itself refusing every call.
 *
 * The fix is not to read the secret, compare it, and remember having done so
 * — it is to remember a fingerprint instead, exactly the way a password is
 * checked without a database of passwords. A hash of the same value hashes
 * the same; a hash of a different one (with overwhelming probability) does
 * not, and neither the fingerprint nor anything it is computed from is ever
 * logged, stored raw, or returned to a caller.
 */

import { createHash } from "node:crypto";
import type { LaneAuthRef } from "../lanes/lane-config";
import type { LaneEnv } from "../lanes/resolve";

/**
 * `lane.auth`, in declaration order, is every credential the lane needs — so
 * the fingerprint changes if *any* of them does, matching "a lane is
 * unavailable unless all of them are set" (`lane-config.ts`). `env` is an
 * explicit parameter, not a read of `process.env`, for the same reason
 * `checkLanePin` takes one: a fingerprint computed against a fake environment
 * in a test must be exactly as pure as one computed against the real process.
 *
 * Null when nothing is configured for the lane — not a fingerprint of the
 * empty string, because "no credential" and "a credential that happens to be
 * empty" must not collide, and because null is the vocabulary every caller
 * here already uses for "nothing to compare against."
 */
export function laneCredentialFingerprint(
  auth: readonly LaneAuthRef[],
  env: LaneEnv
): string | null {
  const values = auth.map((ref) => env[ref.fromEnv] ?? "");
  if (values.every((value) => value === "")) return null;
  // NUL-joined: a value's own characters can never shift where one
  // credential ends and the next begins and hash the same as a different set.
  return createHash("sha256").update(values.join("\u0000")).digest("hex");
}
