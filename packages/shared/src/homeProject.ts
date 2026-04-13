function trimSegment(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const INVALID_FOLDER_NAME_CHARS = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);

function normalizeFolderName(input: string): string {
  return Array.from(input, (char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 32 || INVALID_FOLDER_NAME_CHARS.has(char)) {
      return " ";
    }
    return char;
  }).join("");
}

export function sanitizeProjectFolderName(input: string): string {
  const normalized = trimSegment(normalizeFolderName(input).replace(/^[. ]+|[. ]+$/g, " "));

  if (normalized.length > 0) {
    return normalized.slice(0, 80).trim();
  }

  return "Untitled Project";
}
