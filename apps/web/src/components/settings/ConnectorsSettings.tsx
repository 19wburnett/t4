import type { Connector, ConnectorAuthInput, ConnectorId, EnvironmentId } from "@t3tools/contracts";
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
import { MuseTokenSettings } from "../muse/MuseTokenSettings";
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
  const signIn = useBrowserSignIn(environmentId);
  const connectGoogle = () =>
    void signIn.start("google").then((failure) => {
      if (failure !== null) {
        toastManager.add({ type: "error", title: "Google not connected", description: failure });
      }
    });

  return (
    <>
      <MuseTokenSettings environmentId={environmentId} />
      <SettingsSection
        {...searchableSetting("connectors")}
        headerAction={
          canManage ? (
            <div className="flex items-center gap-1.5">
              <Button
                size="xs"
                variant="outline"
                disabled={signIn.status !== "idle"}
                onClick={connectGoogle}
              >
                {signIn.status === "idle" ? null : <Spinner />}
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
        {signIn.status === "waiting" ? (
          <SettingsRow
            title={`Finish signing in to ${signIn.service} in the tab that opened.`}
            description={
              <span>
                Tab didn't open?{" "}
                <a
                  href={signIn.authUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2"
                >
                  Open {signIn.service} sign-in
                </a>
              </span>
            }
            control={
              <Button size="xs" variant="ghost" onClick={signIn.cancel}>
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
                connector.source._tag === "google" ? connectGoogle() : openDialog(connector)
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
          onSignIn={signIn.start}
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

const AUTH_LABELS = {
  oauth: "Sign in with browser",
  header: "API key or token",
  none: "No sign-in",
} as const;
type AuthKind = keyof typeof AUTH_LABELS;

function ConnectorDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly connector: Connector | null;
  readonly environmentId: EnvironmentId;
  readonly onSignIn: (target: OAuthSignInTarget) => Promise<string | null>;
}) {
  const editing = props.connector;
  const source = editing?.source._tag === "mcp" ? editing.source : undefined;
  const [name, setName] = useState(editing?.name ?? "");
  const [url, setUrl] = useState(source?.url ?? "");
  const [authKind, setAuthKind] = useState<AuthKind>(source?.auth._tag ?? "oauth");
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
    setError(null);
    if (authKind === "oauth") {
      setSaving(true);
      const failure = await props.onSignIn({
        ...(editing ? { connectorId: editing.id } : {}),
        name: name.trim(),
        url: url.trim(),
      });
      setSaving(false);
      if (failure === null) props.onOpenChange(false);
      else setError(failure);
      return;
    }
    const auth: ConnectorAuthInput =
      authKind === "none"
        ? { _tag: "none" }
        : {
            _tag: "header",
            name: headerName.trim(),
            ...(headerValue.trim().length > 0 ? { value: Redacted.make(headerValue.trim()) } : {}),
          };
    setSaving(true);
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
      setError(failureMessage(result.cause));
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
              {authKind === "oauth" ? (
                <p className="text-xs text-muted-foreground">
                  T4 opens the service's sign-in page and saves the connector when you finish there.
                </p>
              ) : null}
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
            {authKind === "oauth"
              ? saving
                ? "Opening sign-in"
                : "Sign in"
              : saving
                ? "Connecting"
                : editing
                  ? "Save"
                  : "Connect"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** An MCP server to sign in to on its own page. */
interface OAuthSignInTarget {
  readonly connectorId?: ConnectorId;
  readonly name: string;
  readonly url: string;
}

type SignInState =
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | { readonly status: "waiting"; readonly service: string; readonly authUrl: string };

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/** Opens a service's consent screen and waits for the server to finish the sign-in. */
function useBrowserSignIn(environmentId: EnvironmentId) {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const startGoogle = useAtomCommand(connectorEnvironment.startGoogleSignIn, {
    reportFailure: false,
  });
  const startOAuth = useAtomCommand(connectorEnvironment.startOAuthSignIn, {
    reportFailure: false,
  });
  const waitForSignIn = useAtomCommand(connectorEnvironment.waitForSignIn, {
    reportFailure: false,
  });
  const [state, setState] = useState<SignInState>({ status: "idle" });
  // Bumped by cancel, so a sign-in that settles afterwards leaves the page alone.
  const attempt = useRef(0);

  /** Resolves with why the sign-in could not start, or null once the service's page is open. */
  const start = async (target: "google" | OAuthSignInTarget): Promise<string | null> => {
    if (httpBaseUrl === null) return "T4 is not connected to this machine.";
    const service = target === "google" ? "Google" : target.name;
    const mine = ++attempt.current;
    setState({ status: "starting" });
    const started =
      target === "google"
        ? await startGoogle({ environmentId, input: { httpBaseUrl } })
        : await startOAuth({ environmentId, input: { ...target, httpBaseUrl } });
    if (attempt.current !== mine) return null;
    if (started._tag !== "Success") {
      setState({ status: "idle" });
      return failureMessage(started.cause);
    }
    setState({ status: "waiting", service, authUrl: started.value.authUrl });
    void ensureLocalApi()
      .shell.openExternal(started.value.authUrl)
      .catch(() => undefined);
    void waitForSignIn({ environmentId, input: { state: started.value.state } }).then(
      (finished) => {
        if (attempt.current !== mine) return;
        setState({ status: "idle" });
        if (finished._tag === "Success") {
          toastManager.add({ type: "success", title: `${finished.value.name} connected` });
        } else {
          toastManager.add({
            type: "error",
            title: `${service} not connected`,
            description: failureMessage(finished.cause),
          });
        }
      },
    );
    return null;
  };

  const cancel = () => {
    attempt.current += 1;
    setState({ status: "idle" });
  };

  return {
    status: state.status,
    service: state.status === "waiting" ? state.service : "",
    authUrl: state.status === "waiting" ? state.authUrl : "",
    start,
    cancel,
  };
}
