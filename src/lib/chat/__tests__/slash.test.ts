import { describe, expect, it } from "vitest";
import { SESSION_SKILLS } from "@/db/schema";
import { applySlashCommand, matchCommands, slashMenu, SLASH_COMMANDS } from "../slash";

const names = (list: readonly { name: string }[]) => list.map((c) => c.name);

describe("SLASH_COMMANDS", () => {
  it("offers every session skill the orchestrator re-frames", () => {
    expect([...names(SLASH_COMMANDS)].sort()).toEqual([...SESSION_SKILLS].sort());
  });

  it("gives each command a summary", () => {
    for (const command of SLASH_COMMANDS) {
      expect(command.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("slashMenu — when the menu opens", () => {
  it("opens on a bare slash, offering everything", () => {
    const menu = slashMenu("/");

    expect(menu?.query).toBe("");
    expect(names(menu!.matches)).toEqual(names(SLASH_COMMANDS));
  });

  it("stays shut for prose", () => {
    expect(slashMenu("")).toBeNull();
    expect(slashMenu("what about option 2")).toBeNull();
  });

  it("stays shut for a slash mid-sentence", () => {
    expect(slashMenu("try src/lib/chat")).toBeNull();
    expect(slashMenu("option a/b")).toBeNull();
  });

  it("closes once the agenda begins", () => {
    // The space after the command means you are writing what it should do,
    // and a menu over the field would be in the way.
    expect(slashMenu("/to-spec ")).toBeNull();
    expect(slashMenu("/to-spec the composer")).toBeNull();
  });

  it("closes on a second line", () => {
    expect(slashMenu("/to-spec\nmore")).toBeNull();
  });

  it("tolerates leading whitespace, as the server's routing does", () => {
    expect(slashMenu("  /to")?.query).toBe("to");
  });

  it("lowercases the query so case never hides a command", () => {
    expect(names(slashMenu("/TO")!.matches)).toEqual(["to-spec", "to-tickets"]);
  });
});

describe("matchCommands", () => {
  it("ranks prefix matches above ones that merely contain the query", () => {
    // `triage` matches "g" only on its middle, so it comes after the two
    // commands that start with it.
    expect(names(matchCommands("g"))).toEqual([
      "grill-me",
      "grill-with-docs",
      "triage",
    ]);
  });

  it("matches on the middle of a name when nothing starts with the query", () => {
    expect(names(matchCommands("with"))).toEqual(["grill-with-docs"]);
  });

  it("keeps the canonical order within a group", () => {
    expect(names(matchCommands("to"))).toEqual(["to-spec", "to-tickets"]);
  });

  it("returns nothing for a query no command matches", () => {
    expect(matchCommands("zzz")).toEqual([]);
  });
});

describe("applySlashCommand", () => {
  it("leaves the caret before the agenda", () => {
    expect(applySlashCommand("to-tickets")).toBe("/to-tickets ");
  });
});
