import { describe, it, expect } from "vitest";
import type { AgentState } from "../src/types/agent.js";
import {
  AgentStateMachine,
  InvalidStateTransitionError,
} from "../src/state-machine.js";

describe("AgentStateMachine", () => {
  it("initial state is idle", () => {
    const sm = new AgentStateMachine();
    expect(sm.state).toBe("idle");
  });

  describe("legal transitions", () => {
    it("idle → running", () => {
      const sm = new AgentStateMachine();
      sm.transition("running");
      expect(sm.state).toBe("running");
    });

    it("running → waiting", () => {
      const sm = new AgentStateMachine();
      sm.transition("running");
      sm.transition("waiting");
      expect(sm.state).toBe("waiting");
    });

    it("running → finished", () => {
      const sm = new AgentStateMachine();
      sm.transition("running");
      sm.transition("finished");
      expect(sm.state).toBe("finished");
    });

    it("running → failed", () => {
      const sm = new AgentStateMachine();
      sm.transition("running");
      sm.transition("failed");
      expect(sm.state).toBe("failed");
    });

    it("running → aborted", () => {
      const sm = new AgentStateMachine();
      sm.transition("running");
      sm.transition("aborted");
      expect(sm.state).toBe("aborted");
    });

    it("waiting → running (resume from subagent wait)", () => {
      const sm = new AgentStateMachine();
      sm.transition("running");
      sm.transition("waiting");
      sm.transition("running");
      expect(sm.state).toBe("running");
    });

    it("waiting → aborted", () => {
      const sm = new AgentStateMachine();
      sm.transition("running");
      sm.transition("waiting");
      sm.transition("aborted");
      expect(sm.state).toBe("aborted");
    });

    it("finished → idle (reset)", () => {
      const sm = new AgentStateMachine();
      sm.transition("running");
      sm.transition("finished");
      sm.transition("idle");
      expect(sm.state).toBe("idle");
    });

    it("failed → idle (reset)", () => {
      const sm = new AgentStateMachine();
      sm.transition("running");
      sm.transition("failed");
      sm.transition("idle");
      expect(sm.state).toBe("idle");
    });

    it("aborted → idle (reset)", () => {
      const sm = new AgentStateMachine();
      sm.transition("running");
      sm.transition("aborted");
      sm.transition("idle");
      expect(sm.state).toBe("idle");
    });
  });

  describe("illegal transitions throw InvalidStateTransitionError", () => {
    const illegalCases: [AgentState, AgentState][] = [
      ["idle", "waiting"],
      ["idle", "finished"],
      ["idle", "failed"],
      ["idle", "aborted"],
      ["idle", "idle"],
      ["finished", "running"],
      ["finished", "waiting"],
      ["finished", "failed"],
      ["finished", "aborted"],
      ["finished", "finished"],
      ["aborted", "running"],
      ["aborted", "waiting"],
      ["aborted", "finished"],
      ["aborted", "failed"],
      ["aborted", "aborted"],
      ["running", "idle"],
      ["running", "running"],
      ["waiting", "failed"],
      ["waiting", "waiting"],
      ["waiting", "finished"],
      ["waiting", "idle"],
      ["failed", "running"],
      ["failed", "aborted"],
      ["failed", "waiting"],
      ["failed", "finished"],
      ["failed", "failed"],
    ];

    for (const [from, to] of illegalCases) {
      it(`${from} → ${to} throws`, () => {
        const sm = new AgentStateMachine();
        if (from !== "idle") {
          sm.transition("running");
          if (from === "waiting") sm.transition("waiting");
          if (from === "finished") sm.transition("finished");
          if (from === "failed") sm.transition("failed");
          if (from === "aborted") sm.transition("aborted");
        }
        expect(() => sm.transition(to)).toThrow(InvalidStateTransitionError);
        expect(() => sm.transition(to)).toThrow(
          `Invalid state transition: ${from} -> ${to}`,
        );
      });
    }
  });

  describe("canTransition()", () => {
    it("returns true for legal transitions", () => {
      const sm = new AgentStateMachine();
      expect(sm.canTransition("running")).toBe(true);
    });

    it("returns false for illegal transitions", () => {
      const sm = new AgentStateMachine();
      expect(sm.canTransition("finished")).toBe(false);
      expect(sm.canTransition("waiting")).toBe(false);
      expect(sm.canTransition("failed")).toBe(false);
      expect(sm.canTransition("aborted")).toBe(false);
    });

    it("returns true for reset from terminal states", () => {
      const sm = new AgentStateMachine();
      sm.transition("running");
      sm.transition("finished");
      expect(sm.canTransition("idle")).toBe(true);
      expect(sm.canTransition("running")).toBe(false);
    });

    it("returns true for reset from aborted", () => {
      const sm = new AgentStateMachine();
      sm.transition("running");
      sm.transition("aborted");
      expect(sm.canTransition("idle")).toBe(true);
    });
  });

  describe("onTransition()", () => {
    it("fires callback with (from, to) on transition", () => {
      const sm = new AgentStateMachine();
      const calls: [AgentState, AgentState][] = [];
      sm.onTransition((from, to) => calls.push([from, to]));
      sm.transition("running");
      expect(calls).toEqual([["idle", "running"]]);
    });

    it("supports multiple listeners", () => {
      const sm = new AgentStateMachine();
      const calls1: [AgentState, AgentState][] = [];
      const calls2: [AgentState, AgentState][] = [];
      sm.onTransition((from, to) => calls1.push([from, to]));
      sm.onTransition((from, to) => calls2.push([from, to]));
      sm.transition("running");
      expect(calls1).toEqual([["idle", "running"]]);
      expect(calls2).toEqual([["idle", "running"]]);
    });

    it("unsubscribe stops callback from firing", () => {
      const sm = new AgentStateMachine();
      const calls: [AgentState, AgentState][] = [];
      const unsub = sm.onTransition((from, to) => calls.push([from, to]));
      unsub();
      sm.transition("running");
      expect(calls).toEqual([]);
    });

    it("unsubscribing one listener does not affect others", () => {
      const sm = new AgentStateMachine();
      const calls1: [AgentState, AgentState][] = [];
      const calls2: [AgentState, AgentState][] = [];
      const unsub1 = sm.onTransition((from, to) => calls1.push([from, to]));
      sm.onTransition((from, to) => calls2.push([from, to]));
      unsub1();
      sm.transition("running");
      expect(calls1).toEqual([]);
      expect(calls2).toEqual([["idle", "running"]]);
    });
  });
});
