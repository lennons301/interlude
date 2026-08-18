import { useCallback, useRef } from "react";

/**
 * Give keyboard focus back to a control that unmounts while what it opened is on
 * screen (issue #142).
 *
 * The settings screen's two most deliberate controls — arming a project and
 * lifting the kill switch — replace their trigger with a confirmation strip, so
 * by the time the owner cancels, the button to return focus to no longer exists;
 * a plain saved reference would point at a detached node. What the caller can
 * hold instead is *intent*: `returnFocus()` says "the next control to mount here
 * is where focus belongs", and the ref callback spends that intent the moment
 * React attaches the replacement.
 *
 * Deliberately not a focus trap. These are inline strips in the page flow, not
 * modals: everything around them stays reachable, and the accessibility story
 * they were missing is only that focus should follow the decision in and back
 * out again.
 */
export function useReturnFocus<T extends HTMLElement>() {
  const pending = useRef(false);

  /** Call as the thing that replaced the trigger closes. */
  const returnFocus = useCallback(() => {
    pending.current = true;
  }, []);

  /** Put this on the trigger — or on whichever control takes its place, since
   * after a confirmed press that is the control the owner is looking at. */
  const triggerRef = useCallback((node: T | null) => {
    if (node !== null && pending.current) {
      pending.current = false;
      node.focus();
    }
  }, []);

  return { triggerRef, returnFocus };
}
