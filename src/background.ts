import { ExtensionSettings, DefaultSettings } from "./common/types";
import { getSettings } from "./common/storage";

let currentSettings: ExtensionSettings | undefined;
const tabLastActiveTimes: Map<number, number> = new Map(); // タブIDと最終アクティブ時刻のマッピング
const ARCHIVE_ALARM_PREFIX = "archiveTimer_tab_"; // アーカイブ用アラーム名の接頭辞

/**
 * 拡張機能の初期化処理を行います。
 * 設定を読み込み、各種イベントリスナーを登録し、初期タブスキャンを実行します。
 */
async function initialize() {
    currentSettings = await getSettings();
    console.debug("ArcLikeExtension initialized with settings:", currentSettings);

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
 * 指定されたタブIDに対応するアラーム名を生成します。
 * @param tabId タブID
 * @returns アラーム名
 */
function getAlarmName(tabId: number): string {
    return `${ARCHIVE_ALARM_PREFIX}${tabId}`;
}

/**
 * 指定されたタブIDの最終アクティブ時刻を現在時刻に更新します。
 * @param tabId タブID
 */
async function updateTabLastActiveTime(tabId: number) {
    if (tabId === chrome.tabs.TAB_ID_NONE || tabId === undefined) return;
    tabLastActiveTimes.set(tabId, Date.now());
    console.debug(`Updated last active time for tab ${tabId}`);
}

/**
 * 指定されたタブが実質的にアクティブかどうかを判定します。
 * タブがアクティブであり、かつそのウィンドウがフォーカスされている場合に実質的にアクティブとみなします。
 * @param tab 判定対象のタブオブジェクト
 * @returns 実質的にアクティブな場合は true、そうでない場合は false
 */
async function isTabEffectivelyActive(tab: chrome.tabs.Tab): Promise<boolean> {
    if (!tab.active) return false; // タブ自体が非アクティブなら即座に false
    try {
        // タブが属するウィンドウ情報を取得
        const window = await chrome.windows.get(tab.windowId);
        return window.focused; // ウィンドウがフォーカスされていれば true
    } catch (e) {
        // ウィンドウが存在しないなどのエラー時は、非アクティブとみなす
        console.warn(`Error getting window for tab ${tab.id}:`, e);
        return false;
    }
}

/**
 * 指定されたタブがアーカイブ可能かどうかを判定します。
 * @param tab 判定対象のタブオブジェクト
 * @param lastActiveTime タブの最終アクティブ時刻 (Unixタイムスタンプ)
 * @param settings 現在の拡張機能設定
 * @param tabIsEffectivelyActive タブが実質的にアクティブかどうか
 * @returns アーカイブ可能な場合は true、そうでない場合は false
 */
function isTabArchivable(
    tab: chrome.tabs.Tab,
    lastActiveTime: number | undefined,
    settings: ExtensionSettings,
    tabIsEffectivelyActive: boolean,
): boolean {
    // 自動アーカイブが無効な場合はアーカイブしない
    if (!settings.autoArchiveEnabled) return false;
    // ピン留めされたタブはアーカイブしない
    if (tab.pinned) return false;
    // グループ化されたタブはアーカイブしない (TAB_GROUP_ID_NONE は -1)
    if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && tab.groupId !== -1) return false;
    // シークレットモードのタブで、設定が許可していない場合はアーカイブしない
    if (tab.incognito && !settings.archiveInIncognito) return false;
    // 実質的にアクティブなタブはアーカイブしない
    if (tabIsEffectivelyActive) return false;

    // 最終アクティブ時刻が記録されていないタブはアーカイブしない
    if (lastActiveTime === undefined) {
        console.debug(`Tab ${tab.id} has no last active time, not archivable.`);
        return false;
    }

    // アーカイブまでの時間をミリ秒単位で計算
    const archiveThresholdMs =
        settings.archiveTimeValue *
        (settings.archiveTimeUnit === "minutes" ? 60 * 1000 : 60 * 60 * 1000);
    // 非アクティブ期間を計算
    const inactiveDurationMs = Date.now() - lastActiveTime;

    const isArchivable = inactiveDurationMs >= archiveThresholdMs;
    console.debug(
        `Tab ${tab.id} inactive for ${inactiveDurationMs}ms (threshold: ${archiveThresholdMs}ms). Archivable: ${isArchivable}`,
    );
    return isArchivable;
}

/**
 * 指定されたタブのアーカイブタイマーを開始またはリセットします。
 * @param tabId タイマーを開始/リセットするタブID
 * @param tabInfoProvided 事前に取得済みのタブ情報 (オプション)
 */
async function startArchiveTimer(tabId: number, tabInfoProvided?: chrome.tabs.Tab) {
    if (
        !currentSettings ||
        !currentSettings.autoArchiveEnabled ||
        tabId === chrome.tabs.TAB_ID_NONE ||
        tabId === undefined
    ) {
        return;
    }
    console.debug(`Attempting to start/reset archive timer for tab ${tabId}`);
    // 既存のアラームをクリア
    await chrome.alarms.clear(getAlarmName(tabId));

    // タブ情報を取得 (提供されていない場合)
    const tabInfo =
        tabInfoProvided ||
        (await (async () => {
            try {
                return await chrome.tabs.get(tabId);
            } catch (e) {
                console.warn(`Tab ${tabId} not found for timer start/reset.`);
                return null;
            }
        })());

    if (!tabInfo) return; // タブ情報が取得できなければ処理終了

    const tabIsEffectivelyActive = await isTabEffectivelyActive(tabInfo);
    // タブが実質的にアクティブな場合はタイマーをキャンセルして終了
    if (tabIsEffectivelyActive) {
        console.debug(`Tab ${tabId} is effectively active, cancelling timer.`);
        await cancelArchiveTimer(tabId);
        return;
    }

    const lastActiveTime = tabLastActiveTimes.get(tabId);
    // タブがアーカイブ可能か判定
    if (isTabArchivable(tabInfo, lastActiveTime, currentSettings, tabIsEffectivelyActive)) {
        const archiveThresholdMs =
            currentSettings.archiveTimeValue *
            (currentSettings.archiveTimeUnit === "minutes" ? 60 * 1000 : 60 * 60 * 1000);
        let delayInMinutes = 0;

        if (lastActiveTime) {
            // isTabArchivable が true であれば lastActiveTime は存在するはず
            // 残りの非アクティブ時間を分単位で計算
            delayInMinutes = Math.max(
                0,
                (archiveThresholdMs - (Date.now() - lastActiveTime)) / (60 * 1000),
            );
        }

        // 遅延が非常に短い場合 (約1秒未満) は即時アーカイブ
        if (delayInMinutes < 0.016) {
            console.log(`Tab ${tabId} is overdue or due immediately. Archiving.`);
            await archiveTab(tabId, tabInfo);
        } else {
            // アラームを設定
            console.log(
                `Starting archive timer for tab ${tabId}, delay: ${delayInMinutes.toFixed(2)} minutes.`,
            );
            chrome.alarms.create(getAlarmName(tabId), { delayInMinutes });
        }
    } else {
        console.debug(`Tab ${tabId} is not archivable currently (timer not started).`);
    }
}

/**
 * 指定されたタブのアーカイブタイマーをキャンセルします。
 * @param tabId タイマーをキャンセルするタブID
 */
async function cancelArchiveTimer(tabId: number) {
    if (tabId === chrome.tabs.TAB_ID_NONE || tabId === undefined) return;
    console.debug(`Cancelling archive timer for tab ${tabId}`);
    await chrome.alarms.clear(getAlarmName(tabId));
}

/**
 * 指定されたタブをアーカイブ (削除) します。
 * タブが編集中 ("Tabs cannot be edited right now") の場合はリトライします。
 * @param tabId アーカイブするタブID
 * @param tabForCheck 事前に取得済みのタブ情報 (オプション、アーカイブ条件の再チェック用)
 */
async function archiveTab(tabId: number, tabForCheck?: chrome.tabs.Tab) {
    if (!currentSettings || tabId === chrome.tabs.TAB_ID_NONE || tabId === undefined) return;
    console.log(`Attempting to archive tab ${tabId}`);

    const MAX_RETRIES = 5; // 最大リトライ回数
    const RETRY_DELAY_MS = 1000; // リトライ間隔 (ミリ秒)

    try {
        // タブ情報を取得 (提供されていない場合) または最新化
        const tab = tabForCheck || (await chrome.tabs.get(tabId));
        const tabIsEffectivelyActive = await isTabEffectivelyActive(tab);

        // アーカイブ直前にもう一度アーカイブ可能かチェック
        if (
            tab &&
            isTabArchivable(
                tab,
                tabLastActiveTimes.get(tabId),
                currentSettings,
                tabIsEffectivelyActive,
            )
        ) {
            console.log(`Archiving tab ${tabId}: ${tab.url}`);
            let retries = 0;
            while (retries < MAX_RETRIES) {
                try {
                    await chrome.tabs.remove(tabId);
                    console.log(`Successfully archived tab ${tabId}`);
                    break; // 成功したらループを抜ける
                } catch (e: any) {
                    // タブが編集中 (ドラッグ中など) の特定のエラーの場合のみリトライ
                    if (
                        e.message &&
                        e.message.includes("Tabs cannot be edited right now") &&
                        retries < MAX_RETRIES - 1
                    ) {
                        console.warn(
                            `Attempt ${retries + 1} to archive tab ${tabId} failed due to drag/edit lock. Retrying in ${RETRY_DELAY_MS}ms...`,
                        );
                        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
                        retries++;
                    } else {
                        throw e; // その他のエラー、または最大リトライ回数に達した場合は再スロー
                    }
                }
            }
            if (retries === MAX_RETRIES) {
                console.error(
                    `Failed to archive tab ${tabId} after ${MAX_RETRIES} retries due to persistent drag/edit lock.`,
                );
            }
        } else {
            console.log(
                `Tab ${tabId} no longer meets archive criteria or doesn't exist. Archival cancelled.`,
            );
        }
    } catch (error) {
        // chrome.tabs.get でタブが見つからない場合などもここに含まれる
        console.warn(`Error archiving tab ${tabId}: ${error}`);
    } finally {
        // アーカイブ試行後は、成功失敗に関わらず関連情報をクリーンアップ
        tabLastActiveTimes.delete(tabId);
        await chrome.alarms.clear(getAlarmName(tabId));
    }
}

/**
 * 拡張機能起動時や設定変更時に、全てのタブをスキャンして状態を評価し、
 * 必要に応じてタイマーを開始/キャンセルしたり、タブを並び替えたりします。
 */
async function initialTabScan() {
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
                await updateTabLastActiveTime(tab.id);
                await cancelArchiveTimer(tab.id);
            } else {
                // 非アクティブなタブ
                if (!tabLastActiveTimes.has(tab.id)) {
                    // 初めてスキャンされる非アクティブタブは、最終アクティブ時刻を現在時刻として記録
                    // これにより、アーカイブまでのカウントダウンがこの時点から開始される
                    tabLastActiveTimes.set(tab.id, Date.now());
                }
                await startArchiveTimer(tab.id, tab);
            }
        }

        // 各ウィンドウのタブを並び替え
        for (const window of allWindows) {
            if (window.id && window.type === "normal") {
                await sortTabsInWindow(window.id);
            }
        }
    } catch (error) {
        console.error("Error during initial tab scan:", error);
    }
}

/**
 * 指定されたウィンドウ内のタブを並び替えます。
 * グループ化されていないタブが、グループ化されたタブの後にくるように配置します。
 * ピン留めされたタブは影響を受けません。
 * @param windowId 並び替えるウィンドウのID
 */
async function sortTabsInWindow(windowId: number) {
    if (!currentSettings || !currentSettings.tabSortingEnabled) return;
    console.debug(`Sorting tabs in window ${windowId}`);

    const MAX_MOVE_RETRIES = 100; // タブ移動の最大リトライ回数
    const MOVE_RETRY_DELAY_MS = 100; // タブ移動のリトライ間隔 (ミリ秒)

    try {
        const allTabsInWindow = await chrome.tabs.query({ windowId });
        if (allTabsInWindow.length === 0) return; // タブがなければ何もしない

        // ピン留めされていないタブのみを対象
        const unpinnedTabs = allTabsInWindow.filter((t) => !t.pinned);
        // グループに属しているタブ (groupId が -1 でないもの)
        const tabsInGroups = unpinnedTabs.filter(
            (t) => t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && t.groupId !== -1,
        );

        // グループ化されたタブが存在しない場合は、並び替えの必要なし
        if (tabsInGroups.length === 0) {
            console.debug(
                `No groups in window ${windowId}, skipping sort logic related to groups.`,
            );
            return;
        }

        // グループに属していないタブ
        const nonGroupedTabs = unpinnedTabs.filter(
            (t) => t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE || t.groupId === -1,
        );

        // グループ化されたタブが占める最大のインデックスを特定
        // これが、グループ化されたタブ群の「終わり」の位置となる
        let maxIndexOfGroupedTabs = -1;
        if (tabsInGroups.length > 0) {
            maxIndexOfGroupedTabs = Math.max(...tabsInGroups.map((t) => t.index));
        }

        // グループ化されたタブ群よりも「前」に位置してしまっている、グループ化されていないタブを特定
        // これらが移動対象となる
        const nonGroupedTabsToRelocate = nonGroupedTabs
            .filter((ngTab) => ngTab.index < maxIndexOfGroupedTabs)
            .sort((a, b) => a.index - b.index); // 現在の視覚的な順序で処理するためソート

        if (nonGroupedTabsToRelocate.length > 0) {
            console.debug(
                `Relocating ${nonGroupedTabsToRelocate.length} non-grouped tabs in window ${windowId}. Target index after: ${maxIndexOfGroupedTabs}`,
            );

            // 移動対象のタブを一つずつ、グループ化されたタブ群の直後に移動する
            for (let i = 0; i < nonGroupedTabsToRelocate.length; i++) {
                const tabToMove = nonGroupedTabsToRelocate[i];
                let retries = 0;
                while (retries < MAX_MOVE_RETRIES) {
                    try {
                        await chrome.tabs.move(tabToMove.id!, {
                            index: maxIndexOfGroupedTabs + 1,
                        });
                        console.debug(
                            `Moved tab ${tabToMove.id} (original index ${tabToMove.index}) to index relative to grouped tabs (target ${maxIndexOfGroupedTabs + 1}).`,
                        );
                        break; // 成功
                    } catch (e: any) {
                        if (
                            e.message &&
                            e.message.includes("Tabs cannot be edited right now") &&
                            retries < MAX_MOVE_RETRIES - 1
                        ) {
                            console.warn(
                                `Sort: Attempt ${retries + 1} to move tab ${tabToMove.id} failed due to drag/edit lock. Retrying in ${MOVE_RETRY_DELAY_MS}ms...`,
                            );
                            await new Promise((resolve) =>
                                setTimeout(resolve, MOVE_RETRY_DELAY_MS),
                            );
                            retries++;
                        } else {
                            console.warn(
                                `Sort: Error moving tab ${tabToMove.id}: ${e}. Max retries reached or unexpected error.`,
                            );
                            break; // リトライを諦めて次のタブへ
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error(`Error sorting tabs in window ${windowId}:`, error);
    }
}

// --- イベントハンドラー ---

/**
 * タブが作成されたときの処理。
 * 新しいタブの最終アクティブ時刻を更新し、状態に応じてアーカイブタイマーを開始またはキャンセルします。
 * ウィンドウ内のタブの並び替えも試みます。
 * @param tab 作成されたタブオブジェクト
 */
async function handleTabCreated(tab: chrome.tabs.Tab) {
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
async function handleTabUpdated(
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
) {
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
async function handleTabActivated(activeInfo: chrome.tabs.TabActiveInfo) {
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
async function handleTabMoved(tabId: number, moveInfo: chrome.tabs.TabMoveInfo) {
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
async function handleTabRemoved(tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) {
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
async function handleTabGroupUpdated(group: chrome.tabGroups.TabGroup) {
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
async function handleWindowFocusChanged(windowId: number) {
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
async function handleAlarm(alarm: chrome.alarms.Alarm) {
    if (!currentSettings) return;
    console.debug("Alarm triggered:", alarm.name);
    if (alarm.name.startsWith(ARCHIVE_ALARM_PREFIX)) {
        const tabIdStr = alarm.name.substring(ARCHIVE_ALARM_PREFIX.length);
        const tabId = parseInt(tabIdStr, 10);
        if (!isNaN(tabId)) {
            await archiveTab(tabId);
        }
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
        currentSettings =
            (changes.arcLikeExtensionSettings.newValue as ExtensionSettings) || DefaultSettings;
        console.log("Settings changed, new settings:", currentSettings);

        const allAlarms = await chrome.alarms.getAll();
        for (const anAlarm of allAlarms) {
            if (anAlarm.name.startsWith(ARCHIVE_ALARM_PREFIX)) {
                await chrome.alarms.clear(anAlarm.name);
            }
        }
        await initialTabScan();
    }
}

initialize().catch((e) => console.error("ArcLikeExtension initialization failed:", e));
