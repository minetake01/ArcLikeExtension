import { ExtensionSettings, DefaultSettings } from "./types";

const SETTINGS_KEY = "arcLikeExtensionSettings";

export async function getSettings(): Promise<ExtensionSettings> {
    try {
        const result = await chrome.storage.sync.get(SETTINGS_KEY);
        if (result[SETTINGS_KEY]) {
            // 保存された設定とデフォルト設定をマージして、新しい設定項目に対応
            return { ...DefaultSettings, ...result[SETTINGS_KEY] };
        }
        return DefaultSettings;
    } catch (error) {
        console.error("Error getting settings:", error);
        return DefaultSettings;
    }
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
    try {
        await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
    } catch (error) {
        console.error("Error saving settings:", error);
    }
}
