const folderAnnotation = /^#\s*@folder:\s*(.+?)\s*$/;

export function workflowFolder(contents: string, fileName: string, prefixes: readonly string[] = []): string {
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (!line.startsWith("#")) break;
    const match = folderAnnotation.exec(line);
    if (match?.[1]) {
      const folder = match[1].split("/").map((part) => part.trim()).filter(Boolean).join("/");
      if (folder) return folder;
    }
  }
  const prefix = prefixes.find((candidate) => candidate.length > 0 && fileName.startsWith(candidate));
  return prefix ? prefix.replace(/[-_]+$/, "") : "Ungrouped";
}
