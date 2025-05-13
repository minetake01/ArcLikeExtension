import { ExtensionSettings, DefaultSettings } from "./common/types";
import { getSettings as getStoredSettings } from "./common/storage";
import { updateSettings, getSettings, getTabLastActiveTimes, getArchiveAlarmPrefix } from "./background/config";
import {
    handleTabCreated,
    handleTabUpdated,
    handleTabActivated,
    handleTabMoved,
    handleTabRemoved,
    handleTabGroupUpdated,
    handleWindowFocusChanged,
    handleAlarm,
} from "./background/eventHandlers";
import {
    updateTabLastActiveTime as tmUpdateTabLastActiveTime,
    startArchiveTimer as tmStartArchiveTimer,
    cancelArchiveTimer as tmCancelArchiveTimer,
} from "./background/tabManager";
import { sortTabsInWindow as tsSortTabsInWindow } from "./background/tabSorter";

/**
 * 拡張機能の初期化処理を行います。
 * 設定を読み込み、各種イベントリスナーを登録し、初期タブスキャンを実行します。
 */
async function initialize() {
    const loadedSettings = await getStoredSettings();
    updateSettings(loadedSettings);
    console.debug("ArcLikeExtension initialized with settings:", getSettings());

    // イベントリスナーの登録
    chrome.tabs.onCreated.addListener(handleTabCreated);
    chrome.tabs.onUpdated.addListener(handleTabUpdated);
    chrome.tabs.onActivated.addListener(handleTabActivated);
    chrome.tabs.onMoved.addListener(handleTabMoved);
    chrome.tabs.onRemoved.addListener(handleTabRemoved);

    chrome.tabGroups.onUpdated.addListener(handleTabGroupUpdated);

    chrome.windows.onFocusChanged.addListener(handleWindowFocusChanged);

    chrome.alarms.onAlarm.addListener(handleAlarm);
    chrome.storage.onChanged.addListener(handleStorageChanged);

    // 初期タブスキャンを実行して、既存タブの状態を評価
    await initialTabScan();
}

/**
 * 拡張機能起動時や設定変更時に、全てのタブをスキャンして状態を評価し、
 * 必要に応じてタイマーを開始/キャンセルしたり、タブを並び替えたりします。
 */
export async function initialTabScan() {
    const currentSettings = getSettings();
    const tabLastActiveTimes = getTabLastActiveTimes();

    if (!currentSettings) {
        console.debug("initialTabScan: currentSettings not loaded yet.");
        return;
    }
    console.debug("Performing initial tab scan...");
    try {
        const allTabs = await chrome.tabs.query({});
        const allWindows = await chrome.windows.getAll({
            populate: false,
            windowTypes: ["normal"],
        });
        const focusedWindowId = allWindows.find((w) => w.focused)?.id;

        for (const tab of allTabs) {
            if (tab.id === undefined) continue;

            const isEffectivelyActiveTab = tab.active && tab.windowId === focusedWindowId;

            if (isEffectivelyActiveTab) {
                // 実質的にアクティブなタブは最終アクティブ時刻を更新し、タイマーをキャンセル
                await tmUpdateTabLastActiveTime(tab.id);
                await tmCancelArchiveTimer(tab.id);
            } else {
                // 非アクティブなタブ
                if (!tabLastActiveTimes.has(tab.id)) {
                    // 初めてスキャンされる非アクティブタブは、最終アクティブ時刻を現在時刻として記録
                    // これにより、アーカイブまでのカウントダウンがこの時点から開始される
                    tabLastActiveTimes.set(tab.id, Date.now());
                }
                await tmStartArchiveTimer(tab.id, tab);
            }
        }

        // 各ウィンドウのタブを並び替え
        for (const window of allWindows) {
            if (window.id && window.type === "normal") {
                await tsSortTabsInWindow(window.id);
            }
        }
    } catch (error) {
        console.error("Error during initial tab scan:", error);
    }
}

/**
 * Chromeストレージの内容が変更されたときの処理。
 * 拡張機能の設定が変更された場合、新しい設定を読み込み、
 * 全てのアラームをクリアして初期タブスキャンを再実行します。
 * @param changes 変更内容
 * @param areaName ストレージエリア名 ('local', 'sync', 'managed')
 */
async function handleStorageChanged(
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string,
) {
    if (areaName === "local" && changes.arcLikeExtensionSettings) {
        const newSettings = changes.arcLikeExtensionSettings.newValue as ExtensionSettings;
        updateSettings(newSettings || DefaultSettings);
        console.log("Settings changed, new settings from storage:", getSettings());

        const archiveAlarmPrefix = getArchiveAlarmPrefix();
        const allAlarms = await chrome.alarms.getAll();
        for (const anAlarm of allAlarms) {
            if (anAlarm.name.startsWith(archiveAlarmPrefix)) {
                await chrome.alarms.clear(anAlarm.name);
            }
        }
        await initialTabScan();
    }
}

initialize().catch((e) => console.error("ArcLikeExtension initialization failed:", e));
