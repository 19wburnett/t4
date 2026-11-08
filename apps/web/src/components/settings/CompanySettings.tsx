import { Link } from "@tanstack/react-router";
import { BuildingIcon } from "lucide-react";

import {
  CompanyAccountsSetup,
  CompanyBrainSetup,
  companyProjectOf,
} from "../companyHub/CompanySetup";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

export function CompanySettings() {
  const { search } = useSettingsScope();
  const group = useSettingsProjectGroups().find((entry) => entry.projectKey === search.project);
  if (!group) {
    return (
      <SettingsScopeNotice target="project">
        Choose a company to connect its email and social accounts and set up its brain.
      </SettingsScopeNotice>
    );
  }
  const project = companyProjectOf(group);
  return (
    <SettingsPageContainer>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate text-base font-medium">{group.displayName}</h1>
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/company/$projectKey" params={{ projectKey: group.projectKey }} />}
        >
          <BuildingIcon aria-hidden />
          Open Company hub
        </Button>
      </div>
      <SettingsSection
        id="company-accounts"
        title="Email & social accounts"
        hideTitle
        variant="plain"
      >
        <CompanyAccountsSetup project={project} />
      </SettingsSection>
      <SettingsSection id="company-brain" title="Company brain" variant="plain">
        <CompanyBrainSetup project={project} />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
