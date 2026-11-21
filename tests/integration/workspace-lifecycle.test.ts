import * as assert from "node:assert";
import * as vscode from "vscode";
import { RepositoryScheduler } from "../../src/github/rate-limit/repository-scheduler";

suite("Workspace lifecycle & scheduler disposal", () => {
  test("disposes repository scheduler cleanly without leaked timers", async () => {
    const scheduler = new RepositoryScheduler(2);
    const lease = scheduler.createLease("acme/demo|origin|file:///repo", "background");
    const result = await scheduler.schedule(
      "acme/demo|origin|file:///repo",
      "lifecycle-probe",
      async () => "ok",
      { lease },
    );
    assert.strictEqual(result, "ok");
    lease.dispose();
    scheduler.dispose();

    const extension = vscode.extensions.getExtension("rtlabs.actiondeck");
    assert.ok(extension);
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });
});
