import { ExtensionSettings, DefaultSettings } from "../common/types";

let currentSettingsInstance: ExtensionSettings = DefaultSettings;
const tabLastActiveTimesMap: Map<number, number> = new Map();
const archiveAlarmPrefixConst = "archiveTimer_tab_";

export function getSettings(): ExtensionSettings {
    return currentSettingsInstance;
}

export function updateSettings(newSettings: ExtensionSettings | undefined): void {
    currentSettingsInstance = newSettings || DefaultSettings;
    console.debug("Settings updated in config:", currentSettingsInstance);
}

export function getTabLastActiveTimes(): Map<number, number> {
    return tabLastActiveTimesMap;
}

export function getArchiveAlarmPrefix(): string {
    return archiveAlarmPrefixConst;
}
