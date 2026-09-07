// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The entry form's live-preview type (issue #160). Choosing it is the request
 * for a preview: the form sends the chat payload plus the one flag, and no
 * session fields — a preview session is not a generation session.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { NewTaskForm } from "../new-task-form";

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
      if (url === "/api/projects") return json([{ id: "p1", name: "Lemons" }]);
      if (url === "/api/settings/overrides") return json({ lanes: null });
      if (url === "/api/tasks" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return json({ id: "t1" }, 201);
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the new-task form's preview type", () => {
  it("offers preview beside chat, and posts the chat payload plus the flag", async () => {
    render(<NewTaskForm />);
    await screen.findByRole("option", { name: "Lemons" });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "p1" } });
    fireEvent.click(screen.getByLabelText(/^preview/));
    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Add a dark mode toggle" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Start preview session" }));

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/tasks/t1"));
    expect(posted).toEqual([
      {
        title: "Add a dark mode toggle",
        description: "",
        projectId: "p1",
        livePreview: true,
      },
    ]);
  });

  it("does not ask for an issue anchor — that is a generation session's affordance", async () => {
    render(<NewTaskForm />);
    await screen.findByRole("option", { name: "Lemons" });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "p1" } });
    fireEvent.click(screen.getByLabelText(/^preview/));
    expect(screen.queryByLabelText("Issue to anchor to")).toBeNull();
    expect(screen.queryByText("loading issues…")).toBeNull();
  });
});
