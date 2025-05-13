import { getSettings, getTabLastActiveTimes, getArchiveAlarmPrefix } from "./config";
import {
    updateTabLastActiveTime,
    isTabEffectivelyActive,
    startArchiveTimer,
    cancelArchiveTimer,
    archiveTab,
} from "./tabManager";
import { sortTabsInWindow } from "./tabSorter";
import { initialTabScan } from "../background"; // initialTabScan は background からインポート

/**
 * タブが作成されたときの処理。
 * 新しいタブの最終アクティブ時刻を更新し、状態に応じてアーカイブタイマーを開始またはキャンセルします。
 * ウィンドウ内のタブの並び替えも試みます。
 * @param tab 作成されたタブオブジェクト
 */
export async function handleTabCreated(tab: chrome.tabs.Tab) {
    const currentSettings = getSettings();
    if (!currentSettings || tab.id === undefined) return;
    console.debug("Tab created:", tab.id, tab);

    const isEffectivelyActiveTab = await isTabEffectivelyActive(tab);
    await updateTabLastActiveTime(tab.id); // 新規タブの最終アクティブ時刻を記録

    if (isEffectivelyActiveTab) {
        await cancelArchiveTimer(tab.id); // アクティブならタイマーは不要
    } else {
        await startArchiveTimer(tab.id, tab); // 非アクティブならタイマー開始
    }

    // タブが有効なウィンドウに属している場合、並び替えを実行
    if (tab.windowId !== chrome.windows.WINDOW_ID_NONE && tab.windowId !== undefined) {
        await sortTabsInWindow(tab.windowId);
    }
}

/**
 * タブが更新されたときの処理 (URL変更、読み込み完了、ピン留め状態変更など)。
 * タブの状態変化に応じて、最終アクティブ時刻の更新、アーカイブタイマーの開始/キャンセル、
 * およびタブの並び替えを行います。
 * @param tabId 更新されたタブID
 * @param changeInfo 変更情報
 * @param tab 更新後のタブオブジェクト
 */
export async function handleTabUpdated(
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
) {
    const currentSettings = getSettings();
    if (!currentSettings || tab.id === undefined) return;
    console.debug("Tab updated:", tabId, changeInfo, tab);

    const tabIsEffectivelyActive = await isTabEffectivelyActive(tab);

    if (tabIsEffectivelyActive) {
        await updateTabLastActiveTime(tabId);
        await cancelArchiveTimer(tabId);
    } else {
        await startArchiveTimer(tabId, tab);
    }

    if (changeInfo.groupId !== undefined || changeInfo.pinned !== undefined) {
        if (tab.windowId !== chrome.windows.WINDOW_ID_NONE && tab.windowId !== undefined) {
            await sortTabsInWindow(tab.windowId);
        }
    }
    if (changeInfo.status === "complete" && !tabIsEffectivelyActive) {
        await startArchiveTimer(tabId, tab);
    }
}

/**
 * アクティブなタブが変更されたときの処理。
 * 新しくアクティブになったタブの最終アクティブ時刻を更新し、アーカイブタイマーをキャンセルします。
 * また、同じウィンドウ内の他の非アクティブになったタブに対してアーカイブタイマーを開始します。
 * @param activeInfo アクティブになったタブの情報
 */
export async function handleTabActivated(activeInfo: chrome.tabs.TabActiveInfo) {
    const currentSettings = getSettings();
    if (!currentSettings || activeInfo.tabId === chrome.tabs.TAB_ID_NONE) return;
    console.debug("Tab activated:", activeInfo.tabId);

    await updateTabLastActiveTime(activeInfo.tabId);
    await cancelArchiveTimer(activeInfo.tabId);

    try {
        const otherTabsInWindow = await chrome.tabs.query({
            windowId: activeInfo.windowId,
            active: false,
        });
        for (const t of otherTabsInWindow) {
            if (t.id) await startArchiveTimer(t.id, t);
        }
    } catch (e) {
        console.warn("Error starting timers for other tabs on activation:", e);
    }
}

/**
 * タブが移動されたときの処理 (ウィンドウ内での位置変更、別ウィンドウへの移動)。
 * 移動先のウィンドウでタブの並び替えを実行します。
 * @param tabId 移動されたタブID
 * @param moveInfo 移動情報
 */
export async function handleTabMoved(tabId: number, moveInfo: chrome.tabs.TabMoveInfo) {
    const currentSettings = getSettings();
    if (!currentSettings) return;
    console.debug("Tab moved:", tabId, moveInfo);
    if (moveInfo.windowId !== chrome.windows.WINDOW_ID_NONE && moveInfo.windowId !== undefined) {
        await sortTabsInWindow(moveInfo.windowId);
    }
}

/**
 * タブが削除されたときの処理。
 * 該当タブのアーカイブタイマーをキャンセルし、最終アクティブ時刻の記録を削除します。
 * ウィンドウが閉じられていない場合は、タブ削除後にウィンドウ内のタブの並び替えを試みます。
 * @param tabId 削除されたタブID
 * @param removeInfo 削除情報
 */
export async function handleTabRemoved(tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) {
    const currentSettings = getSettings();
    const tabLastActiveTimes = getTabLastActiveTimes();
    console.debug("Tab removed:", tabId, removeInfo);
    await cancelArchiveTimer(tabId);
    tabLastActiveTimes.delete(tabId);

    if (!removeInfo.isWindowClosing && currentSettings && currentSettings.tabSortingEnabled) {
        if (
            removeInfo.windowId !== chrome.windows.WINDOW_ID_NONE &&
            removeInfo.windowId !== undefined
        ) {
            setTimeout(() => sortTabsInWindow(removeInfo.windowId), 100);
        }
    }
}

/**
 * タブグループが更新されたときの処理 (名前変更、色変更など)。
 * グループが属するウィンドウでタブの並び替えを実行します。
 * @param group 更新されたタブグループオブジェクト
 */
export async function handleTabGroupUpdated(group: chrome.tabGroups.TabGroup) {
    const currentSettings = getSettings();
    if (!currentSettings) return;
    console.debug("Tab group updated:", group.id, group);
    if (group.windowId !== chrome.windows.WINDOW_ID_NONE && group.windowId !== undefined) {
        await sortTabsInWindow(group.windowId);
    }
}

/**
 * フォーカスされているウィンドウが変更されたときの処理。
 * フォーカスを失ったウィンドウのタブに対してアーカイブタイマーを開始し、
 * 新しくフォーカスを得たウィンドウのアクティブタブに対してタイマーをキャンセル、
 * その他の非アクティブタブに対してタイマーを開始します。
 * @param windowId 新しくフォーカスされたウィンドウID (フォーカスを失った場合は chrome.windows.WINDOW_ID_NONE)
 */
export async function handleWindowFocusChanged(windowId: number) {
    const currentSettings = getSettings();
    if (!currentSettings) return;
    console.debug("Window focus changed to:", windowId);

    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        try {
            const allWindows = await chrome.windows.getAll({
                populate: true,
                windowTypes: ["normal"],
            });
            for (const win of allWindows) {
                if (!win.tabs) continue;
                for (const tab of win.tabs) {
                    if (tab.id && !(await isTabEffectivelyActive(tab))) {
                        await startArchiveTimer(tab.id, tab);
                    }
                }
            }
        } catch (e) {
            console.warn("Error on window focus NONE (all tabs potentially inactive):", e);
        }
    } else {
        try {
            const focusedWindowTabs = await chrome.tabs.query({ windowId: windowId });
            for (const tab of focusedWindowTabs) {
                if (tab.id === undefined) continue;
                const isEffectivelyActiveTab = await isTabEffectivelyActive(tab);
                if (isEffectivelyActiveTab) {
                    await updateTabLastActiveTime(tab.id);
                    await cancelArchiveTimer(tab.id);
                } else {
                    await startArchiveTimer(tab.id, tab);
                }
            }
            const otherWindows = await chrome.windows.getAll({
                populate: true,
                windowTypes: ["normal"],
            });
            for (const win of otherWindows) {
                if (win.id === windowId || !win.tabs) continue;
                for (const tab of win.tabs) {
                    if (tab.id) await startArchiveTimer(tab.id, tab);
                }
            }
        } catch (error) {
            console.warn(`Error handling window focus to ${windowId}:`, error);
        }
    }
}

/**
 * アラームがトリガーされたときの処理。
 * アーカイブ用のアラームであれば、該当タブのアーカイブ処理を実行します。
 * @param alarm トリガーされたアラームオブジェクト
 */
export async function handleAlarm(alarm: chrome.alarms.Alarm) {
    const currentSettings = getSettings();
    const archiveAlarmPrefix = getArchiveAlarmPrefix();
    if (!currentSettings) return;
    console.debug("Alarm triggered:", alarm.name);
    if (alarm.name.startsWith(archiveAlarmPrefix)) {
        const tabIdStr = alarm.name.substring(archiveAlarmPrefix.length);
        const tabId = parseInt(tabIdStr, 10);
        if (!isNaN(tabId)) {
            await archiveTab(tabId);
        }
    }
}
