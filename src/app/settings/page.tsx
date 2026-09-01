import { AppShell } from "@/components/app-shell";
import { Eyebrow } from "@/components/fleet/fleet-bits";
import { ProjectList } from "@/components/project-list";
import { DockerStatus } from "@/components/docker-status";
import { KillSwitch } from "@/components/kill-switch";
import { ModelTierSettings } from "@/components/model-tier-settings";
import { ExecutionLaneSettings } from "@/components/execution-lane-settings";
import { getConfig } from "@/lib/config";

/**
 * The fleet's control room (issue #119). Read top to bottom it answers the
 * three questions the owner actually arrives with: is the fleet allowed to pick
 * up work at all, which projects is it allowed to pick it up for, and is the
 * box underneath healthy enough to run it.
 *
 * A server component, which is what lets the arm confirmation quote the budget
 * actually in force (issue #142): `MAX_BUDGET_USD` is env config read at boot,
 * so the compiled-in default the strip used to render was wrong on any install
 * that sets it — and it is the very number the press authorises.
 */

/**
 * Rendered per request, because the point of reading `getConfig()` here is to
 * read the *running* process's environment. The image is built by `pnpm build`
 * in a Docker stage with no Doppler env (the app gets it at boot, under
 * `doppler run`), so prerendering this page — which Next did, it has no other
 * dynamic signal — would bake the compiled-in default into the HTML and quietly
 * reintroduce the exact defect this fixes. Nothing else here is cacheable
 * anyway: every panel below loads its state client-side.
 */
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <AppShell section="settings">
      <div className="space-y-10">
        <div className="mb-6 mt-2">
          <h1 className="text-lg text-fl-ink">Settings</h1>
          <p className="mt-0.5 text-[13px] text-fl-ink-3">
            What the fleet may do while you&apos;re not watching.
          </p>
        </div>

        <section aria-label="Autonomy" className="space-y-3">
          <Eyebrow>Autonomy</Eyebrow>
          <KillSwitch />
        </section>

        <section aria-label="Models" className="space-y-3">
          <Eyebrow>Models</Eyebrow>
          <ModelTierSettings />
        </section>

        <section aria-label="Execution lane" className="space-y-3">
          <Eyebrow>Execution lane</Eyebrow>
          <ExecutionLaneSettings />
        </section>

        <section aria-label="Projects" className="space-y-3">
          <Eyebrow>Projects</Eyebrow>
          <ProjectList attemptBudgetUsd={getConfig().maxBudgetUsd} />
        </section>

        <section aria-label="Environment" className="space-y-3">
          <Eyebrow>Environment</Eyebrow>
          <DockerStatus />
        </section>
      </div>
    </AppShell>
  );
}
