"use client";

import { useEffect, useRef, useState } from "react";

type Message = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
};

export function TaskStream({ taskId }: { taskId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load existing messages
    fetch(`/api/tasks/${taskId}/messages`)
      .then((r) => r.json())
      .then((data) => setMessages(data));

    // Connect to SSE stream
    const eventSource = new EventSource(`/api/tasks/${taskId}/stream`);

    eventSource.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data) as Message;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });

    return () => eventSource.close();
  }, [taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="max-h-64 overflow-y-auto rounded-md bg-black/30 p-3 font-mono text-sm">
      {messages.length === 0 && (
        <p className="text-muted-foreground">Waiting for agent output...</p>
      )}
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={
            msg.role === "user"
              ? "text-blue-400"
              : msg.role === "system"
                ? "text-muted-foreground"
                : "text-foreground"
          }
        >
          {msg.content}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
