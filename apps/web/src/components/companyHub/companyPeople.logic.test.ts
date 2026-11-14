import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { CompanyBrainRecordId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { everyoneSummaries, type Member, personThreads } from "./companyPeople.logic";
import type { Employee } from "./companyTeam.logic";

const environmentId = EnvironmentId.make("environment-test");

const thread = (
  id: string,
  fields: {
    readonly memberId?: string;
    readonly employeeId?: string;
    readonly archived?: boolean;
    readonly subagent?: boolean;
    readonly at?: string;
  } = {},
) => {
  const base = makeThreadFixture({ id: ThreadId.make(id) }).source;
  return presentThreadShell(environmentId, {
    ...base,
    ...(fields.memberId === undefined ? {} : { memberId: fields.memberId }),
    ...(fields.employeeId === undefined ? {} : { employeeId: fields.employeeId }),
    archivedAt: fields.archived ? DateTime.makeUnsafe("2026-11-01T00:00:00.000Z") : null,
    updatedAt: DateTime.makeUnsafe(fields.at ?? "2026-11-10T00:00:00.000Z"),
    lineage: fields.subagent
      ? {
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("parent"),
        }
      : base.lineage,
  });
};

const sam: Member = {
  recordId: CompanyBrainRecordId.make("sam"),
  name: "Sam",
  email: "sam@example.com",
  role: "member",
};

const marketer: Employee = {
  recordId: CompanyBrainRecordId.make("marketer"),
  name: "Marketer",
  role: "Marketer",
  provider: "claude",
  providerLabel: "Claude",
};

describe("everyoneSummaries", () => {
  it("credits each thread to who started it, and to the AI employee doing it", () => {
    const threads = [
      thread("owner-own"),
      thread("sam-direct", { memberId: "sam", at: "2026-11-12T00:00:00.000Z" }),
      thread("sam-asks-marketer", { memberId: "sam", employeeId: "marketer" }),
      // A removed teammate's work stays visible, under the owner.
      thread("removed-teammate", { memberId: "alex" }),
      thread("archived", { memberId: "sam", archived: true }),
      thread("child", { memberId: "sam", subagent: true }),
    ];

    const byKey = Object.fromEntries(
      everyoneSummaries({ threads, members: [sam], employees: [marketer] }).map((summary) => [
        summary.key,
        summary.threads.map((entry) => entry.id),
      ]),
    );

    expect(byKey).toEqual({
      owner: ["owner-own", "removed-teammate"],
      "member:sam": ["sam-direct", "sam-asks-marketer"],
      "employee:marketer": ["sam-asks-marketer"],
    });
    expect(personThreads(threads, "sam", [sam]).map((entry) => entry.id)).toEqual(
      byKey["member:sam"],
    );
  });
});
