export interface ExtensionSettings {
    autoArchiveEnabled: boolean;
    archiveTimeValue: number;
    archiveTimeUnit: "minutes" | "hours";
    archiveInIncognito: boolean;
    tabSortingEnabled: boolean;
}

export const DefaultSettings: ExtensionSettings = {
    autoArchiveEnabled: true,
    archiveTimeValue: 12,
    archiveTimeUnit: "hours",
    archiveInIncognito: false,
    tabSortingEnabled: true,
};

export interface TabState {
    lastActivated: number; // Unix timestamp
    // 必要に応じて他の状態も追加
}
