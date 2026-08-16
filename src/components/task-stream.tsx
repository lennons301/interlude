"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toChatView, type ChatMessageRow } from "@/lib/chat/chat-view";
import { ChatMessage } from "./chat-message";

type Message = ChatMessageRow & {
  createdAt: string;
};

type TaskStatus = {
  containerStatus: string | null;
  status: string;
  totalCostUsd: number;
  devPort?: number | null;
};

interface TaskStreamProps {
  taskId: string;
  /** The container's live state, so the transcript can show a working pulse
   * of its own rather than making you read the shell's status line. */
  containerStatus: string | null;
  onStatusChange?: (status: TaskStatus) => void;
  onMessage?: (msg: Message) => void;
}

export function TaskStream({
  taskId,
  containerStatus,
  onStatusChange,
  onMessage,
}: TaskStreamProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  const items = useMemo(() => toChatView(messages), [messages]);

  /**
   * The pulse marks the gap between asking and the first output — the one
   * stretch where nothing moves and the view otherwise looks broken. Once the
   * agent has said or done something the transcript itself carries the
   * liveness, and a permanent breathing dot at its foot would just be noise
   * beside the shell's status line.
   */
  const working =
    (containerStatus === "running" || containerStatus === "setup") &&
    items[items.length - 1]?.kind !== "agent-markdown" &&
    items[items.length - 1]?.kind !== "tool-event";

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
      onMessage?.(msg);
    });

    eventSource.addEventListener("taskStatus", (e) => {
      const status = JSON.parse(e.data) as TaskStatus;
      onStatusChange?.(status);
    });

    return () => eventSource.close();
  }, [taskId, onStatusChange, onMessage, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3">
      {items.length === 0 && !working && (
        <div className="flex h-full items-center justify-center">
          <p className="font-plex-mono text-[11px] text-fl-ink-3">
            waiting for agent output
          </p>
        </div>
      )}

      {items.map((item) => (
        <ChatMessage key={item.id} item={item} />
      ))}

      {working && <WorkingPulse />}

      <div ref={bottomRef} />
    </div>
  );
}

/** The transcript's one animation, and the only green on the screen while it
 * runs: the agent is thinking and has not spoken yet. */
function WorkingPulse() {
  return (
    <div className="flex items-center gap-2 py-2" aria-live="polite">
      <span className="fleet-pulse h-1.5 w-1.5 rounded-full bg-fl-green" />
      <span className="font-plex-mono text-[11px] lowercase text-fl-ink-3">
        working
      </span>
    </div>
  );
}
