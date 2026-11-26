import { describe, expect, it, vi } from "vitest";
import { PanelIdentityRegistry } from "../../src/host/webviews/panel-identity";

function listener() {
  return { revoke: vi.fn(), refresh: vi.fn() };
}

describe("panel identity registry", () => {
  it("revokes only the tabs of the repository whose account changed", () => {
    const registry = new PanelIdentityRegistry<string>();
    const a1 = listener();
    const a2 = listener();
    const b = listener();
    registry.register("repo-a", a1);
    registry.register("repo-a", a2);
    registry.register("repo-b", b);

    registry.revoke("repo-a");

    expect(a1.revoke).toHaveBeenCalledOnce();
    expect(a2.revoke).toHaveBeenCalledOnce();
    expect(b.revoke).not.toHaveBeenCalled();
  });

  it("does not revoke or refresh a revoked tab again", () => {
    const registry = new PanelIdentityRegistry<string>();
    const a = listener();
    registry.register("repo-a", a);
    registry.revoke("repo-a");
    registry.revoke("repo-a");
    registry.refresh("repo-a", "token-2");
    expect(a.revoke).toHaveBeenCalledOnce();
    expect(a.refresh).not.toHaveBeenCalled();
  });

  it("hands a renewed session to every open tab of the repository", () => {
    const registry = new PanelIdentityRegistry<string>();
    const a1 = listener();
    const a2 = listener();
    const b = listener();
    registry.register("repo-a", a1);
    registry.register("repo-a", a2);
    registry.register("repo-b", b);

    registry.refresh("repo-a", "token-2", true);

    expect(a1.refresh).toHaveBeenCalledWith("token-2", true);
    expect(a2.refresh).toHaveBeenCalledWith("token-2", true);
    expect(b.refresh).not.toHaveBeenCalled();
  });

  it("stops notifying a closed tab", () => {
    const registry = new PanelIdentityRegistry<string>();
    const a = listener();
    const unregister = registry.register("repo-a", a);
    unregister();
    registry.refresh("repo-a", "token-2");
    registry.revoke("repo-a");
    expect(a.refresh).not.toHaveBeenCalled();
    expect(a.revoke).not.toHaveBeenCalled();
  });
});
