import { CompanyHub } from "../companyHub/CompanyHub";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

export function CompanySettings() {
  const { search } = useSettingsScope();
  const group = useSettingsProjectGroups().find((entry) => entry.projectKey === search.project);
  if (!group) {
    return (
      <SettingsScopeNotice target="project">
        Choose a company to run its work, its brain, and its email and social accounts.
      </SettingsScopeNotice>
    );
  }
  return (
    <SettingsPageContainer width="expanded">
      <CompanyHub group={group} />
    </SettingsPageContainer>
  );
}
