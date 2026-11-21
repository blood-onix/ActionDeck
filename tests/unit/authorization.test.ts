import { describe, expect, it } from "vitest";
import { UiAuthorization } from "../../src/application/dispatch/authorization";

describe("target-bound UI authorization", () => {
  it("authorizes only the exact reviewed parameters and consumes approval once", () => {
    const authorization = new UiAuthorization();
    const reviewed = { repositoryId: "repo", target: "workflow-1", ref: "main", inputs: { version: "1.0", deploy: "false" } };
    authorization.authorize(reviewed);
    expect(authorization.consume({ ...reviewed, inputs: { deploy: "false", version: "1.0" } })).toBe(true);
    expect(authorization.consume(reviewed)).toBe(false);
  });

  it("rejects changes to the target, ref, or input values", () => {
    const authorization = new UiAuthorization();
    authorization.authorize({ repositoryId: "repo", target: "workflow-1", ref: "main", inputs: { version: "1.0" } });
    expect(authorization.consume({ repositoryId: "repo", target: "workflow-1", ref: "release", inputs: { version: "1.0" } })).toBe(false);
  });
});
