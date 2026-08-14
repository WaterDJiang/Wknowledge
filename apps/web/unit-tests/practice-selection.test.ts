import { describe, expect, it } from "vitest";
import {
  selectedPracticeUnitIds,
  togglePracticeUnitExclusion
} from "../app/workspace/learning/practice-selection";

describe("practice unit selection", () => {
  it("selects every completed unit until the learner excludes one", () => {
    const completed = ["unit-01", "unit-02"];
    expect(selectedPracticeUnitIds(completed, [])).toEqual(completed);
    expect(selectedPracticeUnitIds(completed, ["unit-02"])).toEqual(["unit-01"]);
  });

  it("keeps a later completed unit selected without resetting an earlier exclusion", () => {
    expect(selectedPracticeUnitIds(["unit-01", "unit-02", "unit-03"], ["unit-02"])).toEqual([
      "unit-01",
      "unit-03"
    ]);
  });

  it("toggles only the selected unit's exclusion", () => {
    expect(togglePracticeUnitExclusion(["unit-02"], "unit-01")).toEqual(["unit-02", "unit-01"]);
    expect(togglePracticeUnitExclusion(["unit-02", "unit-01"], "unit-01")).toEqual(["unit-02"]);
  });
});
