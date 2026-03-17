"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

interface MessageInputProps {
  taskId: string;
  containerStatus: string | null;
  taskStatus: string;
}

export function MessageInput({
  taskId,
  containerStatus,
  taskStatus,
}: MessageInputProps) {
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [completing, setCompleting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isActive = taskStatus === "running";
  const isIdle = containerStatus === "idle";
  const isRunning = containerStatus === "running" || containerStatus === "setup";
  const canSend = isActive && !!content.trim() && !sending;
  const canComplete = isActive && isIdle && !completing;

  const placeholder = isRunning
    ? "Agent is working... your message will be queued"
    : isIdle
      ? "Message the agent..."
      : "Agent is not active";

  async function handleSend() {
    if (!canSend) return;

    setSending(true);
    await fetch(`/api/tasks/${taskId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.trim(), role: "user" }),
    });
    setContent("");
    setSending(false);
    textareaRef.current?.focus();
  }

  async function handleComplete() {
    if (!canComplete) return;

    setCompleting(true);
    await fetch(`/api/tasks/${taskId}/complete`, {
      method: "POST",
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setContent(e.target.value);
    const textarea = e.target;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  }

  if (!isActive) return null;

  return (
    <div className="border-t border-zinc-800 p-3">
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
          disabled={!isActive}
        />
        <Button
          onClick={handleSend}
          size="sm"
          disabled={!canSend}
          className="bg-purple-600 hover:bg-purple-700 text-white"
        >
          Send
        </Button>
        <Button
          onClick={handleComplete}
          size="sm"
          variant="outline"
          disabled={!canComplete}
          className="text-zinc-400 border-zinc-700"
        >
          Complete
        </Button>
      </div>
    </div>
  );
}
