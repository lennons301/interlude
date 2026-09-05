/**
 * The boot-time lane-availability report, wired (issue #226): read the lane
 * catalog and the orchestrator's environment, and say which declared lanes
 * cannot run and the variables each lacks. The impure shell around the pure
 * `describeLaneAvailability`, kept beside `catalog.ts` for the reason that
 * module exists — the report is testable against the real lane file and a
 * controlled environment without booting the orchestrator.
 *
 * One line per unavailable lane, in the resolver's own wording, so the line an
 * operator reads in the boot log is the line a pass on that lane would fail
 * with. Nothing when every lane is available: a fully configured fleet boots
 * quietly. An unusable lane file is not repeated here — `getLaneCatalog`
 * already logs the reason, and there are no lanes to report on.
 */

import { getLaneCatalog } from "./catalog";
import { describeLaneAvailability } from "./availability";

export function reportLaneAvailability(
  log: (line: string) => void = console.warn,
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  const catalog = getLaneCatalog();
  if (!catalog.ok) return;
  for (const line of describeLaneAvailability(catalog.catalog, env)) {
    log(`[lanes] ${line}`);
  }
}
