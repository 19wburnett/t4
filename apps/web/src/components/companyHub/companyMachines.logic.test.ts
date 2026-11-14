import {
  type AuthAccessSnapshot,
  AuthSessionId,
  CompanyBrainCollectionId,
  CompanyBrainRecordId,
  type CompanyBrainRecordSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  companyMachines,
  machineFields,
  machineMemberAccess,
  removalPlan,
} from "./companyMachines.logic";

const home = EnvironmentId.make("environment-home");
const box = EnvironmentId.make("environment-box");

const record = (title: string, environmentId: string): CompanyBrainRecordSummary => ({
  collection: CompanyBrainCollectionId.make("machines"),
  id: CompanyBrainRecordId.make(title.toLowerCase()),
  path: `company/machines/${title.toLowerCase()}.md`,
  title,
  fields:
    environmentId === ""
      ? { kind: "machine" }
      : machineFields(EnvironmentId.make(environmentId), null),
  updatedAt: null,
});

describe("companyMachines", () => {
  it("lists the company's machine first, then each listed machine once", () => {
    const machines = companyMachines({
      home: { environmentId: home, name: "Laptop" },
      records: [
        record("Box", box),
        record("Box again", box),
        record("Home again", home),
        record("Broken", ""),
      ],
    });
    expect(machines.map((machine) => [machine.name, machine.environmentId])).toEqual([
      ["Laptop", home],
      ["Box", box],
    ]);
    expect(machines[0]?.recordId).toBeNull();
  });
});

describe("machineMemberAccess", () => {
  it("reports each teammate's strongest access, and ignores the owner's sessions", () => {
    const at = DateTime.makeUnsafe("2026-11-14T00:00:00.000Z");
    const session = (id: string, subject: string, connected: boolean) => ({
      sessionId: AuthSessionId.make(id),
      subject,
      scopes: [],
      method: "browser-session-cookie" as const,
      client: { deviceType: "desktop" as const },
      issuedAt: at,
      expiresAt: at,
      lastConnectedAt: null,
      connected,
      current: false,
    });
    const snapshot: AuthAccessSnapshot = {
      pairingLinks: [
        { id: "link-sam", scopes: [], subject: "member:sam", createdAt: at, expiresAt: at },
        { id: "link-ana", scopes: [], subject: "member:ana", createdAt: at, expiresAt: at },
      ],
      clientSessions: [
        session("owner", "one-time-token", true),
        session("sam-phone", "member:sam", false),
        session("sam-laptop", "member:sam", true),
        session("lee", "member:lee", false),
      ],
    };
    expect(Object.fromEntries(machineMemberAccess(snapshot))).toEqual({
      sam: "online",
      ana: "invited",
      lee: "signed-in",
    });

    // Removing Sam revokes everywhere it can read, and names the machines it could not.
    const machines = companyMachines({
      home: { environmentId: home, name: "Laptop" },
      records: [record("Box", box), record("Away", "environment-away")],
    });
    expect(
      removalPlan({ memberId: "sam", machines, snapshots: [snapshot, null, snapshot] }),
    ).toEqual({
      revoke: [
        {
          environmentId: home,
          sessionIds: ["sam-phone", "sam-laptop"],
          pairingLinkIds: ["link-sam"],
        },
        {
          environmentId: "environment-away",
          sessionIds: ["sam-phone", "sam-laptop"],
          pairingLinkIds: ["link-sam"],
        },
      ],
      unchecked: ["Box"],
    });
  });
});
