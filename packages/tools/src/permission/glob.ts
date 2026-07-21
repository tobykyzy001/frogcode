/**
 * In-house glob matcher (no minimatch dependency).
 *
 * Supports:
 *   `*`  — any chars except `.` (toolIds use dots as segment separators)
 *   `**` — any chars including `.` (greedy)
 *   `?`  — single char except `.`
 *   literal chars match themselves
 *
 * Does NOT support brace expansion (`{a,b}`) or negation (`!pattern`).
 *
 * Examples:
 *   matchGlob("fs.*", "fs.read")        → true
 *   matchGlob("fs.*", "fs.read.deep")   → false  (`*` doesn't cross `.`)
 *   matchGlob("fs.**", "fs.read.deep")  → true
 *   matchGlob("fs.?", "fs.x")           → true
 *   matchGlob("shell.*", "fs.read")     → false
 *   matchGlob("**", "anything")         → true
 */
export function matchGlob(pattern: string, str: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i++; // consume the second `*`
      } else {
        regex += "[^.]*";
      }
    } else if (c === "?") {
      regex += "[^.]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
  }
  regex += "$";
  return new RegExp(regex).test(str);
}
