import { describe, expect, it } from "vitest";
import { renderText } from "./render-text.js";
import type { Beat } from "./schemas.js";

const beat = (b: Partial<Beat> & Pick<Beat, "kind">): Beat => ({
  character: null,
  text: null,
  delivery: null,
  framing: null,
  setting: null,
  expression: null,
  action_desc: null,
  action_token: null,
  realization: null,
  duration_s: null,
  note: null,
  ...b,
});

describe("renderText", () => {
  it("renders shots, lines, actions with actor names and strips SFX prefixes", () => {
    const text = renderText({
      title: "t",
      logline: "l",
      cast: ["Grimsby"],
      est_runtime_s: 10,
      kit_requests: [],
      beats: [
        beat({ kind: "shot", framing: "WIDE", setting: "The cave" }),
        beat({ kind: "line", character: "Grimsby", text: "Hello.", delivery: "flat" }),
        beat({ kind: "action", character: "Grimsby", action_desc: "Sips tea.", duration_s: 1 }),
        beat({ kind: "sfx", action_desc: "SFX: clink" }),
      ],
    });
    expect(text).toContain("[WIDE — The cave]");
    expect(text).toContain("GRIMSBY (flat): Hello.");
    expect(text).toContain("> GRIMSBY: Sips tea. (1s)");
    expect(text).toContain("[SFX: clink]");
  });
});
