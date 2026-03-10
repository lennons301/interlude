"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function MessageInput({ taskId }: { taskId: string }) {
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || sending) return;

    setSending(true);
    await fetch(`/api/tasks/${taskId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.trim(), role: "user" }),
    });
    setContent("");
    setSending(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <Input
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Reply to agent..."
        className="flex-1"
      />
      <Button type="submit" size="sm" disabled={sending || !content.trim()}>
        Send
      </Button>
    </form>
  );
}
