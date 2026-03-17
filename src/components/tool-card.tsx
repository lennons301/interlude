"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

interface ToolCardProps {
  tool: string;
  filePath?: string;
  input: Record<string, unknown>;
  output?: string;
}

const TOOL_COLORS: Record<string, string> = {
  Read: "border-blue-500/50",
  read: "border-blue-500/50",
  Edit: "border-green-500/50",
  edit: "border-green-500/50",
  Write: "border-green-500/50",
  write: "border-green-500/50",
  Bash: "border-amber-500/50",
  bash: "border-amber-500/50",
  Glob: "border-blue-500/50",
  Grep: "border-blue-500/50",
  Agent: "border-purple-500/50",
};

function getToolLabel(tool: string, filePath?: string): string {
  if (filePath) return `${tool} ${filePath}`;
  if (tool === "Bash" || tool === "bash") return "Bash";
  return tool;
}

export function ToolCard({ tool, filePath, input, output }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const borderColor = TOOL_COLORS[tool] ?? "border-zinc-500/50";

  return (
    <div
      className={`border-l-2 ${borderColor} rounded-r-md bg-zinc-900/50 cursor-pointer`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-300">
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="font-medium">{getToolLabel(tool, filePath)}</span>
      </div>

      {expanded && (
        <div className="border-t border-zinc-800 px-3 py-2 text-xs font-mono text-zinc-400 space-y-2">
          {(tool === "Bash" || tool === "bash") && !!input.command && (
            <pre className="whitespace-pre-wrap">$ {input.command as string}</pre>
          )}

          {(tool === "Edit" || tool === "edit") && !!input.old_string && (
            <div>
              <div className="text-red-400">- {input.old_string as string}</div>
              <div className="text-green-400">+ {input.new_string as string}</div>
            </div>
          )}

          {output && (
            <pre className="whitespace-pre-wrap text-zinc-500 max-h-40 overflow-y-auto">
              {output.slice(0, 2000)}
              {output.length > 2000 ? "\n..." : ""}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
