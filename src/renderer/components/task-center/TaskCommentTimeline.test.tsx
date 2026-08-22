import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/../shared/types/task";
import type { TaskComment } from "@/../shared/types/taskComment";
import { taskCommentQuote } from "@/../shared/types/taskComment";
import { CUSTOM_EVENTS } from "@/../shared/constants";
import { TaskCommentTimeline } from "./TaskCommentTimeline";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  context: vi.fn(),
  create: vi.fn(),
  retry: vi.fn(),
  commentChanged: null as null | ((event: { payload?: { taskId?: string } }) => void),
}));

vi.mock("@/api/taskCenter", () => ({
  taskListComments: mocks.list,
  taskGetCommentContext: mocks.context,
  taskCreateUserComment: mocks.create,
  taskRetryComment: mocks.retry,
}));

vi.mock("@/utils/tauriListen", () => ({
  listenWithCleanup: vi.fn(async (
    event: string,
    callback: (event: { payload?: { taskId?: string } }) => void,
  ) => {
    if (event === "task:comment-changed") mocks.commentChanged = callback;
    return {
    unlisten: vi.fn(),
    isRegistered: () => true,
    };
  }),
}));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    name: "依赖安全检查",
    executor: "agent",
    workspaceId: "workspace-1",
    workspacePath: "/workspace",
    executionMode: "once",
    runMode: "new-session",
    sessionIds: ["session-1"],
    status: "done",
    tags: [],
    createdAt: 1,
    updatedAt: 2,
    statusHistory: [],
    dispatchOrigin: "direct",
    ...overrides,
  };
}

const agentComment: TaskComment = {
  id: "comment-agent",
  taskId: "task-1",
  body: "发现两个高危依赖，需要确认升级范围。",
  author: { kind: "agent", label: "Agent", sessionId: "session-exact" },
  createdAt: Date.parse("2026-08-20T10:00:00+08:00"),
  conversationSessionId: "session-exact",
};

describe("TaskCommentTimeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.commentChanged = null;
    Element.prototype.scrollIntoView = vi.fn();
    mocks.list.mockResolvedValue({ items: [], nextBefore: undefined });
    mocks.context.mockResolvedValue({
      items: [agentComment],
      targetCommentId: agentComment.id,
    });
  });

  it("focuses an exact notification target and replies to its frozen Session relation", async () => {
    const created: TaskComment = {
      id: "comment-user",
      taskId: "task-1",
      body: "只升级第一个依赖。",
      author: { kind: "user" },
      createdAt: Date.parse("2026-08-20T10:01:00+08:00"),
      replyToCommentId: agentComment.id,
      conversationSessionId: "session-exact",
      admission: { state: "accepted", targetSessionId: "session-exact" },
    };
    mocks.create.mockResolvedValue(created);
    const onTargetReady = vi.fn();

    render(
      <TaskCommentTimeline
        task={task()}
        targetCommentId={agentComment.id}
        onTargetReady={onTargetReady}
      />,
    );

    const body = await screen.findByText(agentComment.body);
    const row = body.closest('[tabindex="-1"]');
    await waitFor(() => expect(row).toHaveFocus());
    expect(onTargetReady).toHaveBeenCalledWith(true);
    expect(screen.getByText("来自通知的目标评论")).toHaveAttribute(
      "aria-live",
      "polite",
    );

    fireEvent.click(screen.getByRole("button", { name: "回复" }));
    expect(
      screen.getAllByText("发现两个高危依赖，需要确认升级范围。"),
    ).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText("补充信息或回复 Agent…"), {
      target: { value: "只升级第一个依赖。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送评论" }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        id: "task-1",
        body: "只升级第一个依赖。",
        replyToCommentId: agentComment.id,
      }),
    );
    expect(await screen.findByText("已进入会话队列")).toBeInTheDocument();
  });

  it("renders compact Markdown and opens an Agent comment Session from its identity line", async () => {
    const markdownComment = {
      ...agentComment,
      body: "**三条重点**\n\n- 第一条\n- 第二条",
    };
    mocks.list.mockResolvedValueOnce({
      items: [markdownComment],
      nextBefore: undefined,
    });
    const onBeforeOpenSession = vi.fn();
    const onOpen = vi.fn();
    window.addEventListener(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, onOpen);

    render(
      <TaskCommentTimeline
        task={task()}
        agentLabel="mino"
        onBeforeOpenSession={onBeforeOpenSession}
      />,
    );

    expect(await screen.findByText("三条重点")).toHaveProperty(
      "tagName",
      "STRONG",
    );
    const identity = screen.getByRole("button", {
      name: /Agent\(mino\).*session-/,
    });
    expect(screen.getByText("Agent(mino)")).toHaveClass("text-sm");
    fireEvent.click(identity);

    expect(onBeforeOpenSession).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: "session-exact",
      workspacePath: "/workspace",
      historyEntrySource: "task_run_history",
    });
    expect(identity.closest('[tabindex="-1"]')).not.toHaveClass(
      "hover:bg-[var(--paper-inset)]/70",
    );
    expect(screen.getByPlaceholderText("补充信息或回复 Agent…")).toHaveAttribute(
      "rows",
      "2",
    );

    window.removeEventListener(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, onOpen);
  });

  it("keeps the exact Agent(name) identity format when the configured name is Agent", async () => {
    mocks.list.mockResolvedValueOnce({
      items: [agentComment],
      nextBefore: undefined,
    });

    render(<TaskCommentTimeline task={task()} agentLabel="Agent" />);

    expect(
      await screen.findByRole("button", { name: /Agent\(Agent\).*session-/ }),
    ).toBeInTheDocument();
  });

  it("does not restyle marked IME text and remeasures after composition", async () => {
    render(<TaskCommentTimeline task={task()} />);
    const textarea = screen.getByPlaceholderText("补充信息或回复 Agent…");
    let scrollHeight = 40;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    fireEvent.change(textarea, { target: { value: "初始文本" } });
    expect(textarea.style.height).toBe("40px");

    fireEvent.compositionStart(textarea);
    scrollHeight = 100;
    fireEvent.change(textarea, { target: { value: "输入法组合中的文本" } });
    expect(textarea.style.height).toBe("40px");

    fireEvent.compositionEnd(textarea);
    await waitFor(() => expect(textarea.style.height).toBe("100px"));
  });

  it("remeasures a wrapped draft when the timeline width changes", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    try {
      render(<TaskCommentTimeline task={task()} />);
      const textarea = screen.getByPlaceholderText("补充信息或回复 Agent…");
      let scrollHeight = 40;
      Object.defineProperty(textarea, "scrollHeight", {
        configurable: true,
        get: () => scrollHeight,
      });
      fireEvent.change(textarea, { target: { value: "会随宽度换行的草稿" } });
      expect(textarea.style.height).toBe("40px");

      scrollHeight = 120;
      act(() => {
        resizeCallback?.(
          [
            {
              contentRect: { width: 500 } as DOMRectReadOnly,
            } as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });
      expect(textarea.style.height).toBe("120px");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the composer concise without a routing explanation", async () => {
    render(<TaskCommentTimeline task={task({ sessionIds: [] })} />);

    expect(
      await screen.findByText("暂无评论。可以在这里补充信息或继续跟进任务。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("将发送到最近执行会话")).not.toBeInTheDocument();
    expect(
      screen.queryByText("将保存，并在任务下次产生执行会话后发送"),
    ).not.toBeInTheDocument();
  });

  it("shows a longer reply preview with a square left edge and stronger fill", async () => {
    const longBody = "这是用于验证回复引用展示长度的父评论内容，需要超过六十个字符，并继续补充足够多的文字来确认末尾会正确显示省略号而不是过早截断。";
    const reply: TaskComment = {
      ...agentComment,
      id: "comment-reply-long",
      body: "收到，继续处理。",
      replyToCommentId: agentComment.id,
    };
    mocks.list.mockResolvedValueOnce({
      items: [{ ...agentComment, body: longBody }, reply],
      nextBefore: undefined,
    });

    render(<TaskCommentTimeline task={task()} />);

    const quote = taskCommentQuote(longBody);
    expect(Array.from(quote.slice(0, -1))).toHaveLength(60);
    const quoteButton = await screen.findByRole("button", {
      name: `回复 Agent：${quote}`,
    });
    expect(quoteButton).toHaveClass(
      "rounded-r-md",
      "bg-[var(--line-strong)]",
    );
    expect(quoteButton).not.toHaveClass("rounded-md");

    fireEvent.click(screen.getAllByRole("button", { name: "回复" })[0]);
    const composerQuote = screen.getAllByText(quote).at(-1)?.parentElement;
    expect(composerQuote).toHaveClass(
      "rounded-r-lg",
      "bg-[var(--line-strong)]",
    );
    expect(composerQuote).not.toHaveClass("rounded-lg");
  });

  it("keeps an out-of-window reply parent as a short accessible quote", async () => {
    const reply: TaskComment = {
      ...agentComment,
      id: "comment-reply",
      body: "已经按这条要求补充证据。",
      replyToCommentId: "comment-old-parent",
    };
    mocks.context.mockResolvedValueOnce({
      items: [reply],
      targetCommentId: reply.id,
      replyParents: [
        {
          commentId: "comment-old-parent",
          author: { kind: "user", label: "Ethan" },
          createdAt: 1,
          quote: "请补充独立验证步骤与失败证据",
        },
      ],
    });

    render(<TaskCommentTimeline task={task()} targetCommentId={reply.id} />);

    expect(
      await screen.findByRole("button", {
        name: "回复 Ethan：请补充独立验证步骤与失败证据",
      }),
    ).toBeDisabled();
  });

  it("loads newer comments after a notification-centered page", async () => {
    mocks.context.mockResolvedValueOnce({
      items: [agentComment],
      targetCommentId: agentComment.id,
      nextAfter: agentComment.id,
    });
    mocks.list.mockResolvedValueOnce({
      items: [{ ...agentComment, id: "comment-newer", body: "后续结论" }],
    });

    render(
      <TaskCommentTimeline task={task()} targetCommentId={agentComment.id} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "加载更新评论" }),
    );

    expect(await screen.findByText("后续结论")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith("task-1", {
      after: agentComment.id,
      limit: 50,
    });
  });

  it("does not let the old around page overwrite a comment sent after exact navigation", async () => {
    const created: TaskComment = {
      id: "comment-after-route",
      taskId: "task-1",
      body: "补充最新验证结论。",
      author: { kind: "user" },
      createdAt: Date.parse("2026-08-20T10:02:00+08:00"),
      conversationSessionId: "session-exact",
      admission: { state: "accepted", targetSessionId: "session-exact" },
    };
    mocks.list.mockResolvedValue({ items: [created], nextBefore: undefined });
    mocks.create.mockImplementation(async () => {
      mocks.commentChanged?.({ payload: { taskId: "task-1" } });
      await Promise.resolve();
      return created;
    });

    render(
      <TaskCommentTimeline task={task()} targetCommentId={agentComment.id} />,
    );
    await screen.findByText(agentComment.body);
    fireEvent.change(screen.getByPlaceholderText("补充信息或回复 Agent…"), {
      target: { value: created.body },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送评论" }));

    expect(await screen.findByText(created.body)).toBeInTheDocument();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith("task-1", { limit: 50 }));
  });

  it("does not consume a deep link when context loading fails transiently", async () => {
    mocks.context.mockRejectedValueOnce(new Error("temporary read failure"));
    const onTargetReady = vi.fn();

    render(
      <TaskCommentTimeline
        task={task()}
        targetCommentId={agentComment.id}
        onTargetReady={onTargetReady}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "temporary read failure",
    );
    expect(onTargetReady).not.toHaveBeenCalled();
  });
});
