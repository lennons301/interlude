import { useCallback, useEffect, useRef } from "react";

/**
 * Give keyboard focus back to a control that unmounts while what it opened is on
 * screen (issue #142).
 *
 * The settings screen's two most deliberate controls — arming a project and
 * lifting the kill switch — replace their trigger with a confirmation strip, so
 * by the time the owner cancels, the button to return focus to no longer exists
 * and a saved reference would point at a detached node. What survives is the
 * *position*: whatever control React mounts there next is where focus belongs,
 * whether that's the trigger again after a cancel or its opposite after a
 * confirmed press ("disarm", "stop the fleet").
 *
 * So the close itself is the signal, not a flag some handler has to remember to
 * set: pass whether the thing is open, and the effect fires on the edge back to
 * closed. Refs are attached before effects run, so by then `trigger` holds the
 * control that replaced the strip — including the case where React reconciled it
 * in place and never re-ran the callback, which is what makes this preferable to
 * spending a pending flag from inside the ref.
 *
 * Deliberately not a focus trap. These are inline strips in the page flow, not
 * modals: everything around them stays reachable, and the accessibility story
 * they were missing is only that focus should follow the decision in and back
 * out again.
 */
export function useReturnFocus<T extends HTMLElement>(open: boolean) {
  const trigger = useRef<T | null>(null);
  const wasOpen = useRef(open);

  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);

  /** Put this on the trigger — and on whichever control takes its place. */
  return useCallback((node: T | null) => {
    // Ignore the unmount: the node we want is the one that mounts next, and on
    // the closing render that callback has not run yet.
    if (node !== null) trigger.current = node;
  }, []);
}
