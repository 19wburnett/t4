import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { museEnvironment } from "~/state/muse";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function MuseTokenSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const canManage = useAtomValue(museEnvironment.issueToken.permissionAtom(environmentId));
  const status = useEnvironmentQuery(
    canManage ? museEnvironment.tokenStatus({ environmentId, input: {} }) : null,
  );
  const issue = useAtomCommand(museEnvironment.issueToken);
  const revoke = useAtomCommand(museEnvironment.revokeToken);
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
    <SettingsSection title="Muse bridge">
      <SettingsRow
        title="Bridge token"
        description={
          status.error ??
          (hasToken
            ? "Regenerating replaces the current token."
            : "Generate a token for the Muse worker.")
        }
        control={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || status.data === null}
              onClick={() => void changeToken(true)}
            >
              {hasToken ? "Regenerate" : "Generate"}
            </Button>
            {hasToken && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void changeToken(false)}
              >
                Revoke
              </Button>
            )}
          </div>
        }
      />
      {token !== null && (
        <SettingsRow
          title="Copy your token now"
          description="This token is shown once."
          control={
            <div className="flex gap-2">
              <Input
                aria-label="New Muse bridge token"
                readOnly
                value={token}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button variant="outline" size="sm" onClick={() => setToken(null)}>
                Hide
              </Button>
            </div>
          }
        />
      )}
    </SettingsSection>
  );
}
