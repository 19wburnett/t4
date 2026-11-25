import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigationState } from "@react-navigation/native";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createMuseEnvironmentAtoms,
  groupMuseMessages,
  hasPendingMuseMessages,
} from "@t3tools/client-runtime/state/muse";
import {
  EnvironmentId,
  type MuseMessage,
  type MuseMessageContext,
  type MuseSendInput,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Linking, TextInput, View } from "react-native";
import { useDeadlinePassed } from "../../lib/clock";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { connectionAtomRuntime } from "../../connection/runtime";
import { uuidv4 } from "../../lib/uuid";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { currentWorkspaceSelections } from "../workspace/workspace-selection-store";
import { SettingsScreen } from "./components/SettingsScreen";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const muse = createMuseEnvironmentAtoms(connectionAtomRuntime);

export function SettingsMuseRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const [selectedEnvironment, setSelectedEnvironment] = useState<EnvironmentId | null>(null);
  const currentThread = useNavigationState(
    (state) => state.routes.findLast((route) => route.name === "Thread")?.params,
  );
  const selectedFile = useNavigationState(
    (state) =>
      state.routes.findLast((route) => route.name === "ThreadFile" || route.name === "NewTaskFile")
        ?.params,
  );
  const source = currentThread ?? currentWorkspaceSelections().threads;
  const threadRef =
    source &&
    "environmentId" in source &&
    "threadId" in source &&
    typeof source.environmentId === "string" &&
    typeof source.threadId === "string"
      ? scopeThreadRef(EnvironmentId.make(source.environmentId), ThreadId.make(source.threadId))
      : null;
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const target =
    selectedTargets.find(({ environmentId }) => environmentId === selectedEnvironment) ??
    selectedTargets.find(({ environmentId }) => environmentId === threadRef?.environmentId) ??
    selectedTargets[0];
  const file =
    selectedFile &&
    "threadId" in selectedFile &&
    "environmentId" in selectedFile &&
    selectedFile.threadId === thread?.id &&
    selectedFile.environmentId === thread?.environmentId &&
    "path" in selectedFile
      ? selectedFile.path
      : null;
  const filePath = typeof file === "string" ? file : Array.isArray(file) ? file.join("/") : null;
  const context: MuseMessageContext =
    thread && target?.environmentId === thread.environmentId
      ? {
          open_thread_id: thread.id,
          open_thread_title: thread.title,
          ...(filePath ? { selected_files: [filePath] } : {}),
          ...(project
            ? {
                t4_project_id: project.id,
                project_title: project.title,
                repo: project.repositoryIdentity?.webUrl ?? project.workspaceRoot,
              }
            : {}),
        }
      : {};
  return (
    <SettingsScreen title="Muse">
      <ScreenScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 p-5">
        {selectedTargets.length > 1 && (
          <View className="flex-row flex-wrap gap-2">
            {selectedTargets.map(({ environmentId, label }) => (
              <Button
                key={environmentId}
                label={label}
                tone={target?.environmentId === environmentId ? "primary" : "secondary"}
                onPress={() => setSelectedEnvironment(environmentId)}
              />
            ))}
          </View>
        )}
        {target ? (
          <MuseThreads
            key={target.environmentId}
            environmentId={target.environmentId}
            context={context}
          />
        ) : (
          <AppText>Connect to a T4 environment to chat with Muse.</AppText>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function MuseThreads({
  environmentId,
  context,
}: {
  environmentId: EnvironmentId;
  context: MuseMessageContext;
}) {
  const list = useEnvironmentQuery(muse.list({ environmentId, input: {} }));
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const lock = useRef(false);
  const attempt = useRef<{ threadId: string; title: string } | null>(null);
  const create = useAtomCommand(muse.create);
  const canCreate = useAtomValue(muse.create.permissionAtom(environmentId));
  const threadId = selected ?? list.data?.threads[0]?.threadId;
  const lastSeenAt = list.data?.lastSeenAt;
  const passed = useDeadlinePassed(lastSeenAt == null ? null : Date.parse(lastSeenAt) + 600_000);
  const online = lastSeenAt != null && !passed;
  useMuseRefresh(list.refresh, 30_000);

  const createThread = async () => {
    const trimmed = title?.trim();
    if (!trimmed || lock.current) return;
    lock.current = true;
    setCreating(true);
    const input =
      attempt.current?.title === trimmed ? attempt.current : { threadId: uuidv4(), title: trimmed };
    attempt.current = input;
    await create({ environmentId, input })
      .then((result) => {
        if (result._tag === "Success") {
          attempt.current = null;
          setSelected(result.value.threadId);
          setTitle(null);
          list.refresh();
        }
      })
      .finally(() => {
        lock.current = false;
        setCreating(false);
      });
  };

  return (
    <View className="gap-3">
      <AppText className={online ? "text-foreground" : "text-foreground-muted"}>
        {online ? "Muse online" : "Muse offline"}
      </AppText>
      {title === null ? (
        <Button label="New Thread" disabled={!canCreate} onPress={() => setTitle("")} />
      ) : (
        <>
          <TextInput
            className="rounded-lg bg-secondary p-3 text-foreground"
            accessibilityLabel="Thread title"
            placeholder="Thread title"
            value={title}
            onChangeText={setTitle}
            editable={!creating}
          />
          <View className="flex-row gap-2">
            <Button
              label="Create"
              loading={creating}
              disabled={!title.trim()}
              onPress={() => void createThread()}
            />
            <Button
              label="Cancel"
              tone="text"
              disabled={creating}
              onPress={() => {
                attempt.current = null;
                setTitle(null);
              }}
            />
          </View>
        </>
      )}
      {list.error && <AppText accessibilityRole="alert">{list.error}</AppText>}
      <View className="flex-row flex-wrap gap-2">
        {list.data?.threads.map((thread) => (
          <Button
            key={thread.threadId}
            label={thread.title}
            tone={threadId === thread.threadId ? "primary" : "secondary"}
            onPress={() => setSelected(thread.threadId)}
          />
        ))}
      </View>
      {threadId && (
        <Conversation
          key={threadId}
          threadId={threadId}
          environmentId={environmentId}
          context={context}
        />
      )}
      <TokenSettings environmentId={environmentId} />
    </View>
  );
}

function useMuseRefresh(refresh: () => void, interval: number) {
  const focused = useIsFocused();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Poll the remote environment while this screen is visible.
  useEffect(() => {
    if (!focused) return;
    const timer = setInterval(refresh, interval);
    return () => clearInterval(timer);
  }, [focused, refresh, interval]);
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
  const thread = useEnvironmentQuery(muse.thread({ environmentId, input: { threadId } }));
  const send = useAtomCommand(muse.send);
  const canSend = useAtomValue(muse.send.permissionAtom(environmentId));
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const lock = useRef(false);
  const attempt = useRef<MuseSendInput | null>(null);
  const retries = useRef(new Map<string, MuseSendInput>());
  useMuseRefresh(thread.refresh, hasPendingMuseMessages(thread.data?.messages) ? 7_000 : 30_000);

  const submit = async (failed?: MuseMessage) => {
    const content = failed?.content ?? draft.trim();
    if (!content || lock.current) return;
    lock.current = true;
    setSending(true);
    const input = (failed ? retries.current.get(failed.id) : attempt.current) ?? {
      threadId,
      content,
      context: failed?.context ?? context,
      clientRequestId: uuidv4(),
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
    <View className="gap-3">
      <AppText className="font-t3-medium">{thread.data?.title}</AppText>
      {thread.error && <AppText accessibilityRole="alert">{thread.error}</AppText>}
      {groupMuseMessages(thread.data?.messages ?? []).map(({ message, activity, reply }) => (
        <View key={message.id} className="gap-2 rounded-lg bg-secondary p-3">
          <AppText selectable>{message.content}</AppText>
          {message.status === "queued" && (
            <AppText className="text-foreground-muted">Waiting for Muse</AppText>
          )}
          {message.status === "claimed" && (
            <AppText className="text-foreground-muted">Muse is working on it</AppText>
          )}
          {!reply &&
            message.status !== "failed" &&
            activity.map((line) => (
              <AppText key={line.id} className="text-foreground-muted">
                {line.content}
              </AppText>
            ))}
          {message.status === "failed" && (
            <>
              <AppText>{message.error ?? "Muse could not answer."}</AppText>
              <Button
                label="Retry"
                disabled={!canSend || sending}
                onPress={() => void submit(message)}
              />
            </>
          )}
          {reply?.replyKind === "approval_needed" &&
            (reply.actionUrl ? (
              <Button
                label="Waiting for your approval in Muse"
                onPress={() => {
                  if (reply.actionUrl) void Linking.openURL(reply.actionUrl);
                }}
              />
            ) : (
              <AppText className="rounded-lg bg-screen p-2">
                Waiting for your approval in Muse
              </AppText>
            ))}
          {reply && <AppText selectable>{reply.content}</AppText>}
        </View>
      ))}
      <TextInput
        className="rounded-lg bg-secondary p-3 text-foreground"
        accessibilityLabel="Message Muse"
        placeholder="Message Muse"
        value={draft}
        multiline
        editable={canSend && !sending}
        onChangeText={(value) => {
          attempt.current = null;
          setDraft(value);
        }}
      />
      <Button
        label="Send"
        tone="primary"
        disabled={!canSend || sending || !draft.trim()}
        onPress={() => void submit()}
      />
    </View>
  );
}

function TokenSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const canManage = useAtomValue(muse.issueToken.permissionAtom(environmentId));
  const status = useEnvironmentQuery(
    canManage ? muse.tokenStatus({ environmentId, input: {} }) : null,
  );
  const issue = useAtomCommand(muse.issueToken);
  const revoke = useAtomCommand(muse.revokeToken);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  if (!canManage) return null;

  const changeToken = async (generate: boolean) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const change = generate
      ? issue({ environmentId, input: {} }).then((result) => {
          if (result._tag === "Success") setToken(result.value.token);
        })
      : revoke({ environmentId, input: {} }).then((result) => {
          if (result._tag === "Success") setToken(null);
        });
    await change.then(status.refresh).finally(() => {
      lock.current = false;
      setBusy(false);
    });
  };
  const hasToken = status.data?.createdAt != null || token !== null;
  return (
    <View className="gap-2 border-t border-border pt-3">
      <AppText className="font-t3-medium">Muse bridge token</AppText>
      {status.error && <AppText accessibilityRole="alert">{status.error}</AppText>}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={hasToken ? "Regenerate" : "Generate"}
          disabled={busy || status.data === null}
          onPress={() => void changeToken(true)}
        />
        {hasToken && (
          <Button label="Revoke" disabled={busy} onPress={() => void changeToken(false)} />
        )}
      </View>
      {token !== null && (
        <>
          <AppText>Copy your token now. It is shown once.</AppText>
          <AppText selectable>{token}</AppText>
          <Button label="Hide" onPress={() => setToken(null)} />
        </>
      )}
    </View>
  );
}
