// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The entry form, refused (issue #218). When no lane's harness can invoke the
 * session's skill the API answers with the reason, and the form has to show it
 * where the owner is looking — before anything was created, let alone a
 * container provisioned — and leave the form ready to try another type.
 *
 * The rest of the form is a fetch and a redirect; what is under test is what
 * it does with a refusal.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { NewTaskForm } from "../new-task-form";

const REFUSAL =
  "A grill-me session needs a lane whose harness can invoke skills, and no such " +
  "lane can host it now — codex-subscription runs codex, which cannot invoke a " +
  "skill; claude-subscription needs CLAUDE_CODE_OAUTH_TOKEN. Pick a lane whose " +
  "harness invokes skills, or start an ordinary chat task instead.";

let posted: unknown[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  posted = [];
  push.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects") return json([{ id: "p1", name: "Interlude" }]);
      if (url === "/api/projects/p1/issues") return json([]);
      if (url === "/api/tasks" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return json({ error: REFUSAL, reason: "no-skill-capable-lane" }, 409);
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Pick the project, choose a grill-me session and give it an agenda. */
async function composeSession() {
  render(<NewTaskForm />);
  await screen.findByRole("option", { name: "Interlude" });
  fireEvent.change(screen.getByLabelText("Project"), { target: { value: "p1" } });
  fireEvent.click(screen.getByLabelText(/^grill-me/));
  fireEvent.change(screen.getByLabelText("Session agenda"), {
    target: { value: "the fleet dashboard" },
  });
  await screen.findByText("no open issues — this session will be freeform");
}

describe("the new-task form, refused a session", () => {
  it("submits the session and shows the API's reason where the owner is looking", async () => {
    await composeSession();

    fireEvent.click(screen.getByRole("button", { name: "Start grill-me session" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(REFUSAL);
    // It asked for exactly the session it was refused.
    expect(posted).toEqual([
      { title: "the fleet dashboard", description: "", projectId: "p1", sessionSkill: "grill-me" },
    ]);
  });

  it("goes nowhere: nothing was created, so there is no task screen to open", async () => {
    await composeSession();

    fireEvent.click(screen.getByRole("button", { name: "Start grill-me session" }));
    await screen.findByRole("alert");

    expect(push).not.toHaveBeenCalled();
  });

  it("leaves the form ready to try again — another type, or the same one later", async () => {
    await composeSession();

    fireEvent.click(screen.getByRole("button", { name: "Start grill-me session" }));
    await screen.findByRole("alert");

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Start grill-me session" }) as HTMLButtonElement)
          .disabled
      ).toBe(false);
    });
    // The agenda survives the refusal, so switching to a chat task keeps it.
    fireEvent.click(screen.getByLabelText(/^chat/));
    expect((screen.getByLabelText("Task title") as HTMLInputElement).value).toBe(
      "the fleet dashboard"
    );
  });
});
