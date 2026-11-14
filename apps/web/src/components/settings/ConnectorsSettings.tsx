import type { Connector, ConnectorAuthInput, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Redacted from "effect/Redacted";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { ensureLocalApi } from "~/localApi";
import { connectorEnvironment } from "~/state/connectors";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function ConnectorsSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <EnvironmentConnectors
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <SettingsSection {...searchableSetting("connectors")}>
          <SettingsRow
            title="Connect an environment to manage its connectors."
            description="Connectors live on the machine running T4, so every device and agent there shares them."
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentConnectors({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const connectors = useEnvironmentQuery(connectorEnvironment.list({ environmentId, input: {} }));
  const canManage = useAtomValue(connectorEnvironment.save.permissionAtom(environmentId));
  const [dialog, setDialog] = useState<{
    readonly open: boolean;
    readonly connector: Connector | null;
    readonly session: number;
  }>({ open: false, connector: null, session: 0 });
  const openDialog = (connector: Connector | null) =>
    setDialog((current) => ({ open: true, connector, session: current.session + 1 }));
  const google = useGoogleSignIn(environmentId);

  return (
    <>
      <SettingsSection
        {...searchableSetting("connectors")}
        headerAction={
          canManage ? (
            <div className="flex items-center gap-1.5">
              <Button
                size="xs"
                variant="outline"
                disabled={google.status !== "idle"}
                onClick={() => void google.start()}
              >
                {google.status === "idle" ? null : <Spinner />}
                Connect Google
              </Button>
              <Button size="xs" variant="outline" onClick={() => openDialog(null)}>
                <PlusIcon className="size-3" aria-hidden />
                Add connector
              </Button>
            </div>
          ) : null
        }
      >
        {google.status === "waiting" ? (
          <SettingsRow
            title="Finish signing in to Google in the tab that opened."
            description={
              <span>
                Tab didn't open?{" "}
                <a
                  href={google.authUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2"
                >
                  Open Google sign-in
                </a>
              </span>
            }
            control={
              <Button size="xs" variant="ghost" onClick={google.cancel}>
                Cancel
              </Button>
            }
          />
        ) : null}
        {connectors.error ? (
          <SettingsRow title="Could not load connectors" description={connectors.error} />
        ) : !connectors.data ? (
          <SettingsRow title="Loading connectors…" role="status" />
        ) : connectors.data.connectors.length === 0 ? (
          <SettingsRow
            title="No connectors yet"
            description="Connect Google, or add an MCP server by its URL, such as Linear, Notion, or Stripe. Every agent on this machine can then use its tools."
          />
        ) : (
          connectors.data.connectors.map((connector) => (
            <ConnectorRow
              key={connector.id}
              environmentId={environmentId}
              connector={connector}
              canManage={canManage}
              onEdit={() =>
                connector.source._tag === "google" ? void google.start() : openDialog(connector)
              }
            />
          ))
        )}
      </SettingsSection>
      {canManage ? (
        <ConnectorDialog
          key={dialog.session}
          open={dialog.open}
          onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
          connector={dialog.connector}
          environmentId={environmentId}
        />
      ) : null}
    </>
  );
}

function ConnectorRow(props: {
  readonly environmentId: EnvironmentId;
  readonly connector: Connector;
  readonly canManage: boolean;
  readonly onEdit: () => void;
}) {
  const { connector } = props;
  const remove = useAtomCommand(connectorEnvironment.remove, { label: "remove connector" });
  const refresh = useAtomCommand(connectorEnvironment.refresh, { label: "refresh connector" });
  const [refreshing, setRefreshing] = useState(false);
  const target = { environmentId: props.environmentId, input: { connectorId: connector.id } };
  const toolCount = connector.tools.length;

  const confirmRemove = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove ${connector.name}?\nAgents lose its tools and its saved credentials are deleted from this machine.`,
      { variant: "destructive" },
    );
    if (confirmed) await remove(target);
  };

  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{connector.name}</span>
          {connector.health._tag === "error" ? (
            <Badge variant="error">Not working</Badge>
          ) : (
            <Badge variant="secondary">
              {toolCount} {toolCount === 1 ? "tool" : "tools"}
            </Badge>
          )}
        </span>
      }
      description={
        <span className="flex min-w-0 flex-col">
          <span className="truncate">
            {connector.source._tag === "mcp" ? connector.source.url : connector.source.email}
          </span>
          {connector.health._tag === "error" ? (
            <span className="text-destructive">{connector.health.message}</span>
          ) : null}
        </span>
      }
      control={
        props.canManage ? (
          <div className="flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Refresh ${connector.name}`}
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                void refresh(target).finally(() => setRefreshing(false));
              }}
            >
              {refreshing ? <Spinner /> : <RefreshCwIcon aria-hidden />}
            </Button>
            <Button size="xs" variant="ghost" onClick={props.onEdit}>
              {connector.source._tag === "google" ? "Reconnect" : "Edit"}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              aria-label={`Remove ${connector.name}`}
              onClick={() => void confirmRemove()}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </div>
        ) : null
      }
    />
  );
}

const AUTH_LABELS = { none: "No sign-in", header: "API key or token" } as const;
type AuthKind = keyof typeof AUTH_LABELS;

function ConnectorDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly connector: Connector | null;
  readonly environmentId: EnvironmentId;
}) {
  const editing = props.connector;
  const source = editing?.source._tag === "mcp" ? editing.source : undefined;
  const [name, setName] = useState(editing?.name ?? "");
  const [url, setUrl] = useState(source?.url ?? "");
  const [authKind, setAuthKind] = useState<AuthKind>(source?.auth._tag ?? "none");
  const [headerName, setHeaderName] = useState(
    source?.auth._tag === "header" ? source.auth.name : "Authorization",
  );
  const [headerValue, setHeaderValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useAtomCommand(connectorEnvironment.save, { reportFailure: false });

  // An edit that keeps header auth may leave the value empty to keep the saved one.
  const keepsSavedValue = source?.auth._tag === "header" && authKind === "header";
  const missing =
    name.trim().length === 0 ||
    !/^https?:\/\/\S+$/i.test(url.trim()) ||
    (authKind === "header" &&
      (headerName.trim().length === 0 || (headerValue.trim().length === 0 && !keepsSavedValue)));

  const submit = async () => {
    if (missing) return;
    const auth: ConnectorAuthInput =
      authKind === "none"
        ? { _tag: "none" }
        : {
            _tag: "header",
            name: headerName.trim(),
            ...(headerValue.trim().length > 0 ? { value: Redacted.make(headerValue.trim()) } : {}),
          };
    setSaving(true);
    setError(null);
    const result = await save({
      environmentId: props.environmentId,
      input: {
        ...(editing ? { connectorId: editing.id } : {}),
        name: name.trim(),
        url: url.trim(),
        auth,
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: editing ? `${result.value.name} updated` : `${result.value.name} connected`,
      });
      props.onOpenChange(false);
    } else {
      const failure = Cause.squash(result.cause);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : "Add connector"}</DialogTitle>
          <DialogDescription>
            Paste the service's MCP server URL. T4 connects to it once and every agent on this
            machine can use its tools. Credentials stay on this machine.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="connector-name">Name</Label>
              <Input
                id="connector-name"
                value={name}
                placeholder="Linear"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="connector-url">MCP server URL</Label>
              <Input
                id="connector-url"
                value={url}
                placeholder="https://mcp.linear.app/mcp"
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="connector-auth">Sign-in</Label>
              <Select
                value={authKind}
                onValueChange={(value) => {
                  if (value !== null) setAuthKind(value);
                }}
              >
                <SelectTrigger id="connector-auth" aria-label="Sign-in">
                  <SelectValue>{AUTH_LABELS[authKind]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {(Object.keys(AUTH_LABELS) as AuthKind[]).map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {AUTH_LABELS[kind]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">
                Servers that sign in through a browser are not supported yet. Use one that accepts
                an API key or token.
              </p>
            </div>
            {authKind === "header" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <div className="grid gap-1.5">
                  <Label htmlFor="connector-header-name">Header</Label>
                  <Input
                    id="connector-header-name"
                    value={headerName}
                    spellCheck={false}
                    onChange={(event) => setHeaderName(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="connector-header-value">Value</Label>
                  <SecretInput
                    id="connector-header-value"
                    configured={keepsSavedValue}
                    placeholder="Bearer sk-…"
                    value={headerValue}
                    onChange={(event) => setHeaderValue(event.target.value)}
                  />
                </div>
              </div>
            ) : null}
            <button type="submit" hidden />
          </form>
          {error !== null ? (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving || missing} onClick={() => void submit()}>
            {saving ? <Spinner /> : null}
            {saving ? "Connecting" : editing ? "Save" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type GoogleSignInState =
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | { readonly status: "waiting"; readonly authUrl: string };

/** Opens Google's consent screen and waits for the server to finish the sign-in. */
function useGoogleSignIn(environmentId: EnvironmentId) {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const startSignIn = useAtomCommand(connectorEnvironment.startGoogleSignIn, {
    reportFailure: false,
  });
  const waitForSignIn = useAtomCommand(connectorEnvironment.waitForGoogleSignIn, {
    reportFailure: false,
  });
  const [state, setState] = useState<GoogleSignInState>({ status: "idle" });
  // Bumped by cancel, so a sign-in that settles afterwards leaves the page alone.
  const attempt = useRef(0);
  const failure = (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    toastManager.add({
      type: "error",
      title: "Google not connected",
      description: error instanceof Error ? error.message : String(error),
    });
  };

  const start = async () => {
    if (httpBaseUrl === null) return;
    const mine = ++attempt.current;
    setState({ status: "starting" });
    const started = await startSignIn({ environmentId, input: { httpBaseUrl } });
    if (attempt.current !== mine) return;
    if (started._tag !== "Success") {
      setState({ status: "idle" });
      failure(started.cause);
      return;
    }
    setState({ status: "waiting", authUrl: started.value.authUrl });
    void ensureLocalApi()
      .shell.openExternal(started.value.authUrl)
      .catch(() => undefined);
    const finished = await waitForSignIn({ environmentId, input: { state: started.value.state } });
    if (attempt.current !== mine) return;
    setState({ status: "idle" });
    if (finished._tag === "Success") {
      toastManager.add({ type: "success", title: `${finished.value.name} connected` });
    } else {
      failure(finished.cause);
    }
  };

  const cancel = () => {
    attempt.current += 1;
    setState({ status: "idle" });
  };

  return {
    status: state.status,
    authUrl: state.status === "waiting" ? state.authUrl : "",
    start,
    cancel,
  };
}
