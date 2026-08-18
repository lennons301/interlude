// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../message-input";

/**
 * The composer interaction a static render cannot reach: the confirmation row,
 * and what becomes of it when the session moves on underneath it (issue #149).
 * The window is seconds wide and it is the normal end of a session — the owner
 * decides they are done at the moment the agent picks the next turn up — so the
 * behaviour is pinned here rather than left to be noticed in production.
 *
 * The rest of the composer is covered without a DOM: its decisions in
 * `composer.test.ts`, its markup in `composer-render.test.tsx`.
 */

const PROPS = {
  taskId: "01TASK",
  taskStatus: "running",
  containerStatus: "idle" as string | null,
  queued: 0,
  sessionSkill: null,
};

/** Neither exists in jsdom, and neither has anything to do with what is under
 * test: the field's autosize watches its own width, and the Enter-vs-newline
 * hint asks whether the pointer is coarse. */
function stubBrowserAPIs() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  if (!window.matchMedia) {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  stubBrowserAPIs();
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The owner presses complete on an idle agent and is asked to confirm. */
function openConfirmation() {
  const view = render(<MessageInput {...PROPS} />);
  fireEvent.click(screen.getByRole("button", { name: "complete" }));
  expect(screen.getByText("end this session?")).toBeTruthy();
  return view;
}

/** A queued message is delivered and the next turn starts, arriving over SSE
 * while the confirmation is still on screen. */
const workingProps = { ...PROPS, containerStatus: "running" };

describe("composer — completing as the agent starts a turn", () => {
  it("closes the confirmation rather than leaving it open over a hidden status line", () => {
    const { rerender } = openConfirmation();

    rerender(<MessageInput {...workingProps} />);

    expect(screen.queryByText("end this session?")).toBeNull();
    // The status line the row was covering is back, and says what changed.
    expect(screen.getByText("agent working")).toBeTruthy();
  });

  it("says why completion was refused rather than dead-ending silently", () => {
    const { rerender } = openConfirmation();

    rerender(<MessageInput {...workingProps} />);

    expect(
      screen.getByText("The agent started a turn. You can end the session once it's idle again.")
    ).toBeTruthy();
    // Refused means refused: nothing was posted on the owner's behalf.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the reason where a screen reader is already listening", () => {
    const { rerender } = openConfirmation();

    rerender(<MessageInput {...workingProps} />);

    const field = screen.getByRole("textbox");
    const described = document.getElementById(
      field.getAttribute("aria-describedby") ?? ""
    );
    expect(described?.textContent).toContain("The agent started a turn");
    // The live region is the same element that held the keyboard hint a moment
    // ago, not one that appears with its message already in it.
    expect(described?.getAttribute("role")).toBe("status");
  });

  it("puts focus back in the field instead of dropping it on the floor", () => {
    const { rerender } = openConfirmation();
    const confirm = screen.getByRole("button", { name: "confirm" });
    confirm.focus();

    rerender(<MessageInput {...workingProps} />);

    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("hands the line back to the keyboard hint once the notice has been read", () => {
    vi.useFakeTimers();
    const { rerender } = openConfirmation();
    rerender(<MessageInput {...workingProps} />);

    act(() => void vi.advanceTimersByTime(8000));

    expect(screen.queryByText(/The agent started a turn/)).toBeNull();
    expect(screen.getByText(/enter to send/)).toBeTruthy();
  });

  it("names the same reason on the button the refusal disabled", () => {
    render(<MessageInput {...workingProps} />);

    expect(screen.getByRole("button", { name: "complete" })).toHaveProperty(
      "title",
      "The agent started a turn. You can end the session once it's idle again."
    );
  });

  it("still completes when the agent is idle at the moment it is confirmed", async () => {
    openConfirmation();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/01TASK/complete", {
      method: "POST",
    });
    expect(screen.queryByText("end this session?")).toBeNull();
  });
});
