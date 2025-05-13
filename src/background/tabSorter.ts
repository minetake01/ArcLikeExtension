import { getSettings } from "./config";

/**
 * 指定されたウィンドウ内のタブを並び替えます。
 * グループ化されていないタブが、グループ化されたタブの後にくるように配置します。
 * ピン留めされたタブは影響を受けません。
 * @param windowId 並び替えるウィンドウのID
 */
export async function sortTabsInWindow(windowId: number) {
    const currentSettings = getSettings();
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
