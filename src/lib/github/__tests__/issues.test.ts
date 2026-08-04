import { describe, it, expect } from "vitest";
import { selectRetryComments } from "../issues";

type C = { id: number; authorIsBot: boolean };

const bot = (id: number): C => ({ id, authorIsBot: true });
const human = (id: number): C => ({ id, authorIsBot: false });

describe("selectRetryComments (issue #73)", () => {
  it("keeps the most-recent `recentTail` comments regardless of author", () => {
    const comments = [bot(1), bot(2), bot(3), bot(4), bot(5)];
    expect(selectRetryComments(comments, 2)).toEqual([bot(4), bot(5)]);
  });

  it("floors in a human comment that lifecycle chatter pushed past the tail", () => {
    // Human guidance at index 0, then enough bot chatter to bury it.
    const comments = [human(1), bot(2), bot(3), bot(4), bot(5)];
    expect(selectRetryComments(comments, 2)).toEqual([human(1), bot(4), bot(5)]);
  });

  it("keeps every human comment however old, plus the recent tail", () => {
    const comments = [human(1), bot(2), human(3), bot(4), bot(5), bot(6)];
    // tail=1 keeps only bot(6); humans 1 and 3 are floored in on top.
    expect(selectRetryComments(comments, 1)).toEqual([human(1), human(3), bot(6)]);
  });

  it("does not double-count a human comment already inside the tail", () => {
    const comments = [bot(1), bot(2), human(3), bot(4)];
    expect(selectRetryComments(comments, 3)).toEqual([bot(2), human(3), bot(4)]);
  });

  it("preserves chronological order", () => {
    const comments = [human(1), bot(2), human(3), bot(4)];
    const result = selectRetryComments(comments, 1).map((c) => c.id);
    expect(result).toEqual([...result].sort((a, b) => a - b));
  });

  it("a tail at least the length of the thread keeps everything", () => {
    const comments = [bot(1), human(2), bot(3)];
    expect(selectRetryComments(comments, 10)).toEqual(comments);
  });

  it("returns nothing for an empty thread", () => {
    expect(selectRetryComments([], 5)).toEqual([]);
  });
});
