import { describe, expect, it } from "vitest";
import { parseAnsi, parseLogLines, stripAnsi } from "../../webview/src/utils/log-format";

describe("log formatting", () => {
  it("splits runner timestamps from the line text and keeps the raw line for copying", () => {
    const [line] = parseLogLines("2026-11-12T14:10:43.6356282Z Current runner version: '2.338.2'");
    expect(line?.text).toBe("Current runner version: '2.338.2'");
    expect(line?.time).toBe("2026-11-12T14:10:43.6356282Z");
    expect(line?.clock).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(line?.raw).toContain("2026-11-12T14:10:43");
  });

  it("interprets group markers, hides endgroup lines and keeps original line numbers", () => {
    const lines = parseLogLines(
      [
        "2026-11-12T14:10:43.1Z ##[group]Runner Image",
        "2026-11-12T14:10:43.2Z Image: ubuntu-24.04",
        "2026-11-12T14:10:43.3Z ##[endgroup]",
        "2026-11-12T14:10:43.4Z after",
      ].join("\n"),
    );
    expect(lines.map((l) => l.text)).toEqual(["Runner Image", "Image: ubuntu-24.04", "after"]);
    expect(lines[0]?.kind).toBe("step");
    expect(lines[1]?.group).toBe(0);
    expect(lines[2]?.group).toBeUndefined();
    expect(lines[2]?.n).toBe(4);
  });

  it("turns ANSI colors into segments and strips them from the searchable text", () => {
    const esc = "\u001b";
    const parsed = parseAnsi(`${esc}[31m│${esc}[0m ${esc}[1m${esc}[31mError: ${esc}[0m${esc}[0m${esc}[1m"name" bad`);
    expect(parsed.text).toBe('│ Error: "name" bad');
    expect(parsed.segments?.some((s) => s.fg === "red" && s.bold)).toBe(true);
    expect(stripAnsi("[31m│[0m [0m[1m[31mError:")).toBe("│ Error:");
  });

  it("classifies explicit and recognizable error lines", () => {
    const lines = parseLogLines([
      "2026-11-12T14:10:43.1Z ##[error]Process completed with exit code 1.",
      "2026-11-12T14:10:43.2Z {\"message\":\"Version 2.8.0 already exists\"}",
      "2026-11-12T14:10:43.3Z │ Error: invalid configuration",
      "2026-11-12T14:10:43.4Z [ERROR] Build stopped",
      "2026-11-12T14:10:43.5Z ::error::Invalid stage 'foo'",
    ].join("\n"));
    expect(lines[0]).toMatchObject({ kind: "error", text: "Process completed with exit code 1." });
    expect(lines[1]?.kind).toBe("error");
    expect(lines[2]?.kind).toBe("error");
    expect(lines[3]?.kind).toBe("error");
    expect(lines[4]?.kind).toBe("error");
  });

  it("does not falsely highlight shell scripts echoing ::error:: or step-echo Run groups", () => {
    const lines = parseLogLines([
      '2026-11-12T14:10:43.1Z ##[group]Run [[ "$SERVICE_NAME" =~ ^[a-z0-9_]+$ ]] || { echo "::error::Invalid service name \'$SERVICE_NAME\'"; exit 1; }',
      '2026-11-12T14:10:43.2Z [[ "$SERVICE_NAME" =~ ^[a-z0-9_]+$ ]] || { echo "::error::Invalid service name \'$SERVICE_NAME\'"; exit 1; }[ -d "services/$SERVICE_NAME" ] || { echo "::error::Unknown service \'$SERVICE_NAME\'"; exit 1; }case "$STAGE" in dev|qa|prod) ;; *) echo "::error::Invalid stage \'$STAGE\'"; exit 1 ;; esac',
      "2026-11-12T14:10:43.3Z   echo 'Error: failed to validate'",
      "2026-11-12T14:10:43.4Z shell: /usr/bin/bash -e {0}",
      "2026-11-12T14:10:43.5Z ##[endgroup]",
      "2026-11-12T14:10:43.6Z fail-on-error: false",
      "2026-11-12T14:10:43.7Z 0 errors, 0 warnings",
      "2026-11-12T14:10:43.8Z ##[error]Invalid stage 'staging'",
    ].join("\n"));
    expect(lines[0]?.kind).toBe("step");
    expect(lines[1]?.kind).toBeUndefined();
    expect(lines[2]?.kind).toBeUndefined();
    expect(lines[3]?.kind).toBeUndefined();
    expect(lines[4]?.kind).toBeUndefined();
    expect(lines[5]?.kind).toBeUndefined();
    expect(lines[6]).toMatchObject({ kind: "error", text: "Invalid stage 'staging'" });
  });
});
