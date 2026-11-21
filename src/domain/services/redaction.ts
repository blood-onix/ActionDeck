const keyCharacter = /[a-z0-9_-]/i;
const sensitiveKey = /(?:^|[_-])(?:token|password|secret|authorization|api[_-]?key|private[_-]?key|access[_-]?key)$/i;

export function redactSensitiveText(value: string): string {
  const replacements: Array<{ start: number; end: number }> = [];
  for (let delimiter = 0; delimiter < value.length; delimiter++) {
    if (value[delimiter] !== ":" && value[delimiter] !== "=") continue;

    let keyEnd = delimiter;
    while (keyEnd > 0 && /[ \t]/.test(value[keyEnd - 1] ?? "")) keyEnd--;
    const quote = value[keyEnd - 1] === "\"" || value[keyEnd - 1] === "'" ? value[keyEnd - 1] : undefined;
    if (quote) keyEnd--;
    let keyStart = keyEnd;
    while (keyStart > 0 && keyCharacter.test(value[keyStart - 1] ?? "")) keyStart--;
    if (!sensitiveKey.test(value.slice(keyStart, keyEnd))) continue;

    let valueStart = delimiter + 1;
    while (valueStart < value.length && /[ \t]/.test(value[valueStart] ?? "")) valueStart++;
    let valueEnd = valueStart;
    const valueQuote = value[valueStart] === "\"" || value[valueStart] === "'" ? value[valueStart] : undefined;
    if (valueQuote) {
      valueEnd++;
      while (valueEnd < value.length && value[valueEnd] !== "\r" && value[valueEnd] !== "\n") {
        if (value[valueEnd] === valueQuote && value[valueEnd - 1] !== "\\") {
          valueEnd++;
          break;
        }
        valueEnd++;
      }
    } else {
      while (valueEnd < value.length && !/[\s,;]/.test(value[valueEnd] ?? "")) valueEnd++;
      const scheme = value.slice(valueStart, valueEnd).toLowerCase();
      if (scheme === "bearer" || scheme === "basic") {
        while (valueEnd < value.length && /[ \t]/.test(value[valueEnd] ?? "")) valueEnd++;
        while (valueEnd < value.length && !/[\s,;]/.test(value[valueEnd] ?? "")) valueEnd++;
      }
    }
    if (valueEnd > valueStart) replacements.push({ start: valueStart, end: valueEnd });
    delimiter = valueEnd;
  }

  if (replacements.length === 0) return value;
  let result = "";
  let offset = 0;
  for (const replacement of replacements) {
    result += value.slice(offset, replacement.start) + "[REDACTED]";
    offset = replacement.end;
  }
  return result + value.slice(offset);
}
