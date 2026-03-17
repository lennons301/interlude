"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatMessage } from "./chat-message";

type Message = {
  id: string;
  role: string;
  type: string;
  content: string;
  createdAt: string;
};

type TaskStatus = {
  containerStatus: string | null;
  status: string;
  totalCostUsd: number;
};

interface TaskStreamProps {
  taskId: string;
  onStatusChange?: (status: TaskStatus) => void;
}

export function TaskStream({ taskId, onStatusChange }: TaskStreamProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  const scrollToBottom = useCallback(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  useEffect(() => {
    // Track whether user has scrolled up
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      userScrolledUp.current = scrollHeight - scrollTop - clientHeight > 100;
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    // Load existing messages
    fetch(`/api/tasks/${taskId}/messages`)
      .then((r) => r.json())
      .then((data: Message[]) => {
        setMessages(data);
        // Scroll after initial load
        setTimeout(() => scrollToBottom(), 50);
      });

    // Connect to SSE stream
    const eventSource = new EventSource(`/api/tasks/${taskId}/stream`);

    eventSource.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data) as Message;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) {
          // Update existing message (e.g., tool_result updating tool_use)
          return prev.map((m) => (m.id === msg.id ? msg : m));
        }
        return [...prev, msg];
      });
    });

    eventSource.addEventListener("taskStatus", (e) => {
      const status = JSON.parse(e.data) as TaskStatus;
      onStatusChange?.(status);
    });

    return () => eventSource.close();
  }, [taskId, onStatusChange, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-4 py-3 space-y-1"
    >
      {messages.length === 0 && (
        <div className="flex items-center justify-center h-full">
          <p className="text-zinc-500 text-sm">Waiting for agent output...</p>
        </div>
      )}
      {messages.map((msg) => (
        <ChatMessage
          key={msg.id}
          id={msg.id}
          role={msg.role}
          type={msg.type ?? "text"}
          content={msg.content}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
