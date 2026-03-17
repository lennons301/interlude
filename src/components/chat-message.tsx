import { ToolCard } from "./tool-card";

interface MessageProps {
  id: string;
  role: string;
  type: string;
  content: string;
}

function parseContent(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content);
  } catch {
    // Legacy plain-text content from Phase 2a
    return { text: content };
  }
}

export function ChatMessage({ role, type, content }: MessageProps) {
  const parsed = parseContent(content);

  // System messages — centered muted text
  if (role === "system" || type === "system") {
    return (
      <div className="flex justify-center py-1">
        <span className="text-xs text-zinc-500">
          {(parsed.text as string) ?? content}
        </span>
      </div>
    );
  }

  // User messages — right-aligned purple bubble
  if (role === "user") {
    return (
      <div className="flex justify-end py-1">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-purple-600/80 px-4 py-2 text-sm text-white">
          {(parsed.text as string) ?? content}
        </div>
      </div>
    );
  }

  // Agent tool_use — render as tool card
  if (type === "tool_use") {
    return (
      <div className="py-1 max-w-[90%]">
        <ToolCard
          tool={(parsed.tool as string) ?? "tool"}
          filePath={parsed.file_path as string | undefined}
          input={(parsed.input as Record<string, unknown>) ?? {}}
          output={parsed.output as string | undefined}
        />
      </div>
    );
  }

  // Agent text — left-aligned dark bubble
  return (
    <div className="flex justify-start py-1">
      <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-zinc-800 px-4 py-2 text-sm text-zinc-100">
        {(parsed.text as string) ?? content}
      </div>
    </div>
  );
}
