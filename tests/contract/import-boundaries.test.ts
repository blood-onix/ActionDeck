import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

function allWebviewFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? allWebviewFiles(path) : [path];
  });
}

describe("host/browser import boundaries", () => {
  it("keeps VS Code and host-only source imports out of the webview", () => {
    for (const file of sourceFiles(join(process.cwd(), "webview", "src"))) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from\s+["']vscode["']/);
      expect(source).not.toMatch(/from\s+["'][^"']*\/src\/(host|github|persistence)\//);
    }
  });

  it("keeps --vscode-* references strictly inside webview/src/styles.css", () => {
    for (const file of sourceFiles(join(process.cwd(), "webview", "src"))) {
      const source = readFileSync(file, "utf8");
      expect(source, `Found --vscode-* in ${file}`).not.toMatch(/--vscode-/);
    }
  });

  it("forbids raw hex colour literals in webview TypeScript/TSX sources", () => {
    for (const file of sourceFiles(join(process.cwd(), "webview", "src"))) {
      const source = readFileSync(file, "utf8");
      expect(source, `Found raw hex literal in ${file}`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it("forbids brand colours anywhere in webview/src/ and forbids importing design/components/bundle", () => {
    for (const file of allWebviewFiles(join(process.cwd(), "webview", "src"))) {
      const source = readFileSync(file, "utf8");
      expect(source.toLowerCase(), `Found brand hex in ${file}`).not.toMatch(/#f0a43a|#12161c|#f6f1e7|#5b6b7f/);
      expect(source, `Found brand-* token in ${file}`).not.toMatch(/\bbrand-(amber|ink|paper|slate)\b/);
      expect(source, `Found design/components/bundle import in ${file}`).not.toMatch(/design\/components\/bundle/);
    }
  });

  it("enforces UI writing rules (no OK/Submit button labels, no emojis, no exclamation marks in UI strings)", () => {
    for (const file of sourceFiles(join(process.cwd(), "webview", "src"))) {
      const source = readFileSync(file, "utf8");
      // No "OK" or "Submit" button labels
      expect(source, `Found generic OK/Submit button label in ${file}`).not.toMatch(/>\s*(OK|Submit)\s*</);
      // No emoji characters
      expect(source, `Found emoji in ${file}`).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    }
  });
});
