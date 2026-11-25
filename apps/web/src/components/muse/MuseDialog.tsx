import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type MuseMessage,
  type MuseMessageContext,
  type MuseSendInput,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { groupMuseMessages, hasPendingMuseMessages } from "@t3tools/client-runtime/state/muse";
import { useDeadlinePassed } from "~/hooks/useDeadline";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { useThreadRouteRef } from "~/hooks/useThreadRouteTarget";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { randomUUID } from "~/lib/utils";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "~/state/environments";
import { useProject, useQuietThreadShell } from "~/state/entities";
import { museEnvironment } from "~/state/muse";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export function MuseDialog({ onClose }: { onClose: () => void }) {
  const threadRef = useThreadRouteRef();
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const primary = usePrimaryEnvironmentId();
  const connected = useConnectedEnvironmentIds();
  const environmentId =
    threadRef?.environmentId ?? (primary && connected.includes(primary) ? primary : connected[0]);
  const diff = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, threadRef),
  );
  const surface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, threadRef),
  );
  const selectedFile =
    surface?.kind === "file" && !surface.attachment
      ? surface.relativePath
      : surface?.kind === "diff" && diff.kind === "turn"
        ? diff.filePath
        : null;
  const context: MuseMessageContext = {
    ...(project
      ? {
          t4_project_id: project.id,
          project_title: project.title,
          repo: project.repositoryIdentity?.webUrl ?? project.workspaceRoot,
        }
      : {}),
    ...(thread ? { open_thread_id: thread.id, open_thread_title: thread.title } : {}),
    ...(selectedFile ? { selected_files: [selectedFile] } : {}),
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Muse</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {environmentId ? (
            <MuseThreads
              key={environmentId}
              environmentId={environmentId}
              context={context}
              onClose={onClose}
            />
          ) : (
            <p>Connect to a T4 environment to chat with Muse.</p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function MuseThreads({
  environmentId,
  context,
  onClose,
}: {
  environmentId: EnvironmentId;
  context: MuseMessageContext;
  onClose: () => void;
}) {
  const list = useEnvironmentQuery(museEnvironment.list({ environmentId, input: {} }));
  const [selected, setSelected] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const createAttempt = useRef<{ title: string; threadId: string } | null>(null);
  const createLock = useRef(false);
  const canCreate = useAtomValue(museEnvironment.create.permissionAtom(environmentId));
  const create = useAtomCommand(museEnvironment.create);
  const threadId = selected ?? list.data?.threads[0]?.threadId;
  const lastSeenAt = list.data?.lastSeenAt;
  const passed = useDeadlinePassed(lastSeenAt == null ? null : Date.parse(lastSeenAt) + 600_000);
  const online = lastSeenAt != null && !passed;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh presence while the dialog is open.
  useEffect(() => {
    const timer = setInterval(list.refresh, 30_000);
    return () => clearInterval(timer);
  }, [list.refresh]);

  const createThread = async () => {
    const title = newTitle?.trim();
    if (!title || createLock.current) return;
    createLock.current = true;
    setCreating(true);
    const input =
      createAttempt.current?.title === title
        ? createAttempt.current
        : { title, threadId: randomUUID() };
    createAttempt.current = input;
    await create({ environmentId, input })
      .then((result) => {
        if (result._tag === "Success") {
          createAttempt.current = null;
          setSelected(result.value.threadId);
          setNewTitle(null);
          list.refresh();
        }
      })
      .finally(() => {
        createLock.current = false;
        setCreating(false);
      });
  };

  return (
    <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
      <aside className="min-w-0 space-y-2" aria-label="Muse threads">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <span
            className={
              online
                ? "size-2 rounded-full bg-success"
                : "size-2 rounded-full bg-muted-foreground/50"
            }
          />
          {online ? "Muse online" : "Muse offline"}
        </div>
        <Link
          to="/settings/connectors"
          search={{ machine: environmentId }}
          onClick={onClose}
          className="text-xs underline"
        >
          Bridge settings
        </Link>
        {newTitle === null ? (
          <Button size="sm" disabled={!canCreate} onClick={() => setNewTitle("")}>
            New Thread
          </Button>
        ) : (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void createThread();
            }}
          >
            <Input
              aria-label="Thread title"
              placeholder="Thread title"
              value={newTitle}
              disabled={creating}
              onChange={(event) => setNewTitle(event.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" type="submit" disabled={creating || !newTitle.trim()}>
                Create
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                disabled={creating}
                onClick={() => {
                  setNewTitle(null);
                  createAttempt.current = null;
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {list.error && <p role="alert">{list.error}</p>}
        <ul className="max-h-36 space-y-1 overflow-auto sm:max-h-72">
          {list.data?.threads.map((item) => (
            <li key={item.threadId}>
              <Button
                size="sm"
                variant={item.threadId === threadId ? "secondary" : "ghost"}
                aria-pressed={item.threadId === threadId}
                onClick={() => setSelected(item.threadId)}
              >
                <span className="truncate">{item.title}</span>
              </Button>
            </li>
          ))}
        </ul>
      </aside>
      {threadId ? (
        <Conversation
          key={threadId}
          environmentId={environmentId}
          threadId={threadId}
          context={context}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {list.data ? "Start a thread to chat with Muse." : "Loading Muse threads…"}
        </p>
      )}
    </div>
  );
}

function Conversation({
  environmentId,
  threadId,
  context,
}: {
  environmentId: EnvironmentId;
  threadId: string;
  context: MuseMessageContext;
}) {
  const thread = useEnvironmentQuery(
    museEnvironment.thread({ environmentId, input: { threadId } }),
  );
  const pending = hasPendingMuseMessages(thread.data?.messages);
  const canSend = useAtomValue(museEnvironment.send.permissionAtom(environmentId));
  const send = useAtomCommand(museEnvironment.send);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const lock = useRef(false);
  const attempt = useRef<MuseSendInput | null>(null);
  const retries = useRef(new Map<string, MuseSendInput>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe queue changes while this conversation is open.
  useEffect(() => {
    const timer = setInterval(thread.refresh, pending ? 7_000 : 30_000);
    return () => clearInterval(timer);
  }, [pending, thread.refresh]);

  const submit = async (failed?: MuseMessage) => {
    const content = failed?.content ?? draft.trim();
    if (!content || lock.current) return;
    lock.current = true;
    setSending(true);
    const existing = failed ? retries.current.get(failed.id) : attempt.current;
    const input = existing ?? {
      threadId,
      content,
      context: failed?.context ?? context,
      clientRequestId: randomUUID(),
    };
    if (failed) retries.current.set(failed.id, input);
    else attempt.current = input;
    await send({ environmentId, input })
      .then((result) => {
        if (result._tag === "Success") {
          if (failed) retries.current.delete(failed.id);
          else {
            attempt.current = null;
            setDraft("");
          }
          thread.refresh();
        }
      })
      .finally(() => {
        lock.current = false;
        setSending(false);
      });
  };

  return (
    <section className="min-w-0 space-y-3">
      <h3 className="truncate font-medium">{thread.data?.title ?? "Conversation"}</h3>
      {thread.error && <p role="alert">{thread.error}</p>}
      <ol className="max-h-[42vh] space-y-3 overflow-auto text-sm" aria-label="Messages">
        {groupMuseMessages(thread.data?.messages ?? []).map(({ message, activity, reply }) => (
          <li key={message.id} className="space-y-2 rounded-lg border p-3">
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
            {message.status === "queued" && (
              <p className="text-muted-foreground">Waiting for Muse</p>
            )}
            {message.status === "claimed" && (
              <p className="text-muted-foreground">Muse is working on it</p>
            )}
            {activity.length > 0 && (
              <details
                open={!reply && message.status !== "failed"}
                className="text-muted-foreground"
              >
                <summary>Muse activity</summary>
                {activity.map((line) => (
                  <p className="whitespace-pre-wrap break-words" key={line.id}>
                    {line.content}
                  </p>
                ))}
              </details>
            )}
            {message.status === "failed" && (
              <div className="space-y-1">
                <p className="text-destructive">{message.error ?? "Muse could not answer."}</p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canSend || sending}
                  onClick={() => void submit(message)}
                >
                  Retry
                </Button>
              </div>
            )}
            {reply && (
              <div className="space-y-2 border-t pt-2">
                {reply.replyKind === "approval_needed" && (
                  <div className="rounded-md bg-muted p-2">
                    {reply.actionUrl ? (
                      <a
                        className="underline"
                        href={reply.actionUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Waiting for your approval in Muse
                      </a>
                    ) : (
                      "Waiting for your approval in Muse"
                    )}
                  </div>
                )}
                <p className="whitespace-pre-wrap break-words">{reply.content}</p>
              </div>
            )}
          </li>
        ))}
      </ol>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Textarea
          aria-label="Message Muse"
          placeholder="Message Muse"
          value={draft}
          disabled={!canSend || sending}
          onChange={(event) => {
            attempt.current = null;
            setDraft(event.target.value);
          }}
        />
        <Button type="submit" size="sm" disabled={!canSend || sending || !draft.trim()}>
          Send
        </Button>
      </form>
    </section>
  );
}
