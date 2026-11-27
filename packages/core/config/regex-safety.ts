// Write-time screening for owner-supplied regex patterns (link rules, list
// classification). JS regexes backtrack, and a pattern like `(a+)+$` takes
// exponential time on a near-miss input. Execution is also bounded where the
// pattern runs (link rules cap the input at 8 KB, the classifier caps the list
// name), but a pattern that is catastrophic on short input still burns CPU.
//
// The nested-quantifier check is a heuristic: it catches the classic shape — a
// repeated group that itself contains a repeat — and not every exponential
// pattern (overlapping alternation such as `(a|a)*` passes). It rejects some
// harmless patterns too; `(ab+)*` is usually fine but is refused.

export const MAX_PATTERN_LENGTH = 256;

// Returns a reason the pattern is refused, or null when it's acceptable.
export function patternProblem(pattern: string, flags: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
  }
  try {
    new RegExp(pattern, flags);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (hasNestedQuantifier(pattern)) {
    return "a repeated group contains another repeat (for example (a+)+), which can take exponential time; simplify the pattern";
  }
  return null;
}

function isQuantifierAt(p: string, i: number): boolean {
  const c = p[i];
  return c === "*" || c === "+" || (c === "{" && /^\{\d+(,\d*)?\}/.test(p.slice(i)));
}

function hasNestedQuantifier(p: string): boolean {
  // One flag per open group: does it contain a quantifier (directly or nested)?
  const stack: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") {
      i++; // skip the escaped character
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      stack.push(false);
      continue;
    }
    if (c === ")") {
      const inner = stack.pop() ?? false;
      if (inner && isQuantifierAt(p, i + 1)) return true;
      if (stack.length > 0 && (inner || isQuantifierAt(p, i + 1))) stack[stack.length - 1] = true;
      continue;
    }
    if (isQuantifierAt(p, i) && stack.length > 0) stack[stack.length - 1] = true;
  }
  return false;
}
