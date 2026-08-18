import { AppShell } from "@/components/app-shell";
import { Eyebrow } from "@/components/fleet/fleet-bits";
import { ProjectList } from "@/components/project-list";
import { DockerStatus } from "@/components/docker-status";
import { KillSwitch } from "@/components/kill-switch";
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
