import { ExtensionSettings, DefaultSettings } from "../common/types";
import { getSettings, saveSettings } from "../common/storage";

document.addEventListener("DOMContentLoaded", async () => {
    const autoArchiveEnabledInput = document.getElementById(
        "autoArchiveEnabled",
    ) as HTMLInputElement;
    const archiveTimeValueInput = document.getElementById("archiveTimeValue") as HTMLInputElement;
    const archiveTimeUnitSelect = document.getElementById("archiveTimeUnit") as HTMLSelectElement;
    const archiveInIncognitoInput = document.getElementById(
        "archiveInIncognito",
    ) as HTMLInputElement;
    const tabSortingEnabledInput = document.getElementById("tabSortingEnabled") as HTMLInputElement;

    async function loadPopupSettings() {
        const settings = await getSettings();
        autoArchiveEnabledInput.checked = settings.autoArchiveEnabled;
        archiveTimeValueInput.value = settings.archiveTimeValue.toString();
        archiveTimeUnitSelect.value = settings.archiveTimeUnit;
        archiveInIncognitoInput.checked = settings.archiveInIncognito;
        tabSortingEnabledInput.checked = settings.tabSortingEnabled;
    }

    async function savePopupSettings() {
        const newSettings: ExtensionSettings = {
            autoArchiveEnabled: autoArchiveEnabledInput.checked,
            archiveTimeValue:
                parseInt(archiveTimeValueInput.value, 10) || DefaultSettings.archiveTimeValue,
            archiveTimeUnit: archiveTimeUnitSelect.value as "minutes" | "hours",
            archiveInIncognito: archiveInIncognitoInput.checked,
            tabSortingEnabled: tabSortingEnabledInput.checked,
        };
        await saveSettings(newSettings);
    }

    autoArchiveEnabledInput.addEventListener("change", savePopupSettings);
    archiveTimeValueInput.addEventListener("change", savePopupSettings);
    archiveTimeValueInput.addEventListener("input", savePopupSettings);
    archiveTimeUnitSelect.addEventListener("change", savePopupSettings);
    archiveInIncognitoInput.addEventListener("change", savePopupSettings);
    tabSortingEnabledInput.addEventListener("change", savePopupSettings);

    await loadPopupSettings();
});
