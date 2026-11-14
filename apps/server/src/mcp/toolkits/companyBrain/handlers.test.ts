import {
  CompanyBrainCollectionId,
  CompanyBrainRecordId,
  type CompanyBrainRecordSummary,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { type ActivityRow, type Roster, starterOf } from "./handlers.ts";

const person = (id: string): CompanyBrainRecordSummary => ({
  collection: CompanyBrainCollectionId.make("members"),
  id: CompanyBrainRecordId.make(id),
  path: `company/members/${id}.md`,
  title: id,
  fields: {},
  updatedAt: null,
});

const laptop = EnvironmentId.make("environment-laptop");
const samsMachine = EnvironmentId.make("environment-sam");
const sharedBox = EnvironmentId.make("environment-box");

const row = (environmentId: EnvironmentId, memberId: string | null): ActivityRow => ({
  threadId: ThreadId.make(`thread:${environmentId}:${memberId ?? "none"}`),
  title: "Work",
  environmentId,
  projectId: ProjectId.make("project"),
  status: "idle",
  waitingOn: null,
  memberId,
  employeeId: null,
  updatedAt: "2026-11-14T00:00:00.000Z",
});

describe("starterOf", () => {
  it("credits a thread to its starter, else to the teammate whose machine it is on", () => {
    const roster: Roster = {
      members: [person("sam"), person("ana")],
      employees: [],
      machines: [
        { name: "Sam's laptop", environmentId: samsMachine, ownerMemberId: "sam" },
        { name: "Shared box", environmentId: sharedBox, ownerMemberId: null },
      ],
    };
    const starter = starterOf(roster);

    expect(starter(row(laptop, null))).toBeNull();
    expect(starter(row(laptop, "ana"))).toBe("ana");
    // Sam works on their own machine without a member session there.
    expect(starter(row(samsMachine, null))).toBe("sam");
    // A teammate's session wins over the machine's owner.
    expect(starter(row(samsMachine, "ana"))).toBe("ana");
    expect(starter(row(sharedBox, null))).toBeNull();
    // Someone no longer on the roster counts as the owner.
    expect(starter(row(laptop, "alex"))).toBeNull();
  });
});
