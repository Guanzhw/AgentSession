/** Observed diagnostic envelopes only. Logged JavaScript and shell text are never executed. */
export interface CodexMemoryLogOperation {
  kind: "read-request" | "modification-request";
  targetPath: string;
  workdir: string | null;
  content: string;
}

export interface CodexMemoryLogRequest {
  turnId: string;
  operations: CodexMemoryLogOperation[];
  unsupported: boolean;
}

const quoted = '"(?:\\\\.|[^"\\\\])*"';
const submissionPattern = new RegExp('^session_loop\\{thread_id=([^}]+)\\}: Submission sub=Submission \\{ id: (' + quoted + '), op: TurnInput \\{ request: TurnInputRequest \\{ input: UserInput \\{ content: \\[Text \\{ text: (' + quoted + '), text_elements:', 's');

export function parseCodexMemorySubmission(body: string, threadId: string): string | null {
  const match = submissionPattern.exec(body);
  if (!match || match[1] !== threadId) return null;
  try {
    const input = JSON.parse(match[3]);
    return /^#{1,3} Memory Writing Agent: Phase 2 \(Consolidation\)(?:\r?\n|$)/.test(input)
      ? JSON.parse(match[2]) : null;
  } catch { return null; }
}

function literalReadPaths(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: string | null = null;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        if (command[index + 1] === quote) index++;
        else quote = null;
      } else if (character === "`") index++;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ";" || character === "\n") {
      segments.push(command.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(command.slice(start));
  return segments.flatMap((segment) => {
    const match = /^\s*Get-Content\s+-Raw\s+(?:"([^"$`]+)"|'((?:[^']|'')+)'|([^\s;'"`$|&<>(){}\[\]*?]+))\s*$/i.exec(segment);
    const target = match && (match[1] ?? match[2]?.replace(/''/g, "'") ?? match[3]);
    return target && !/[*?\[\]]/.test(target) ? [target] : [];
  });
}

export function parseCodexMemoryRequest(body: string, threadId: string): CodexMemoryLogRequest | null {
  const marker = ": ToolCall: exec ";
  const offset = body.indexOf(marker);
  if (offset < 0) return null;
  const prefix = body.slice(0, offset);
  const session = /^session_loop\{thread_id=([^}]+)\}/.exec(prefix);
  const turn = /:turn\{[^}]*\bthread\.id=([^\s}]+)\s+turn\.id=([^\s}]+)/.exec(prefix);
  const suffix = `\n thread_id=${threadId}`;
  if (session?.[1] !== threadId || turn?.[1] !== threadId || !body.endsWith(suffix)) return null;
  const content = body.slice(offset + marker.length, -suffix.length);
  const operations: CodexMemoryLogOperation[] = [];
  const command = /^const (\w+) = await tools\.exec_command\((\{[\s\S]*\})\);\s*text\(\1\.output\);?\s*$/.exec(content);
  if (command) {
    try {
      const args = JSON.parse(command[2]);
      if (typeof args.cmd !== "string" || typeof args.workdir !== "string") return { turnId: turn[2], operations, unsupported: true };
      for (const targetPath of literalReadPaths(args.cmd)) {
        operations.push({ kind: "read-request", targetPath, workdir: args.workdir, content });
      }
      return { turnId: turn[2], operations, unsupported: false };
    } catch { return { turnId: turn[2], operations, unsupported: true }; }
  }
  const patchPattern = new RegExp('^const (\\w+) = (' + quoted + ');\\s*const (\\w+) = await tools\\.apply_patch\\(\\1\\);\\s*text\\(typeof \\3 === "string" \\? \\3 : JSON\\.stringify\\(\\3\\)\\);?\\s*$', 's');
  const patch = patchPattern.exec(content);
  if (patch) {
    try {
      const text: string = JSON.parse(patch[2]);
      for (const match of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
        operations.push({ kind: "modification-request", targetPath: match[1].replace(/\r$/, ""), workdir: null, content });
      }
      return { turnId: turn[2], operations, unsupported: false };
    } catch { return { turnId: turn[2], operations, unsupported: true }; }
  }
  return { turnId: turn[2], operations, unsupported: /tools\.(?:exec_command|apply_patch)\b/.test(content) };
}
