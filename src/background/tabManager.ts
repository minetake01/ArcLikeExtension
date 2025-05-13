import { ExtensionSettings } from "../common/types";
import { getSettings, getTabLastActiveTimes, getArchiveAlarmPrefix } from "./config";

/**
 * 指定されたタブIDに対応するアラーム名を生成します。
 * @param tabId タブID
 * @returns アラーム名
 */
export function getAlarmName(tabId: number): string {
    return `${getArchiveAlarmPrefix()}${tabId}`;
}

/**
 * 指定されたタブIDの最終アクティブ時刻を現在時刻に更新します。
 * @param tabId タブID
 */
export async function updateTabLastActiveTime(tabId: number) {
    if (tabId === chrome.tabs.TAB_ID_NONE || tabId === undefined) return;
    getTabLastActiveTimes().set(tabId, Date.now());
    console.debug(`Updated last active time for tab ${tabId}`);
}

/**
 * 指定されたタブが実質的にアクティブかどうかを判定します。
 * タブがアクティブであり、かつそのウィンドウがフォーカスされている場合に実質的にアクティブとみなします。
 * @param tab 判定対象のタブオブジェクト
 * @returns 実質的にアクティブな場合は true、そうでない場合は false
 */
export async function isTabEffectivelyActive(tab: chrome.tabs.Tab): Promise<boolean> {
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
export function isTabArchivable(
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
export async function startArchiveTimer(tabId: number, tabInfoProvided?: chrome.tabs.Tab) {
    const currentSettings = getSettings();
    const tabLastActiveTimes = getTabLastActiveTimes();

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
export async function cancelArchiveTimer(tabId: number) {
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
export async function archiveTab(tabId: number, tabForCheck?: chrome.tabs.Tab) {
    const currentSettings = getSettings();
    const tabLastActiveTimes = getTabLastActiveTimes();

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
