import { Monitor, Moon, Sun } from "lucide-react";
import { useI18n } from "../../i18n/I18nProvider";
import type { Locale } from "../../i18n/i18n";
import { useKeypointsEnabled } from "../../reader/keypoints";
import { SegmentedControl, useAppearance, type Appearance } from "../../ui";
import { Section } from "./Section";
import styles from "./Settings.module.css";

/** The theme: light, dark, or the system's. */
export function AppearanceSection() {
  const { t } = useI18n();
  const { mode, setMode } = useAppearance();
  return (
    <Section title={t("settings.appearance.title")}>
      <div className={styles.card}>
        <div className={styles.setting}>
          <span className={styles.settingLabel}>
            {t("settings.appearance.label")}
          </span>
          <SegmentedControl<Appearance>
            kind="radio"
            label={t("settings.appearance.label")}
            value={mode}
            onChange={setMode}
            options={[
              {
                value: "system",
                label: t("settings.appearance.system"),
                icon: Monitor,
              },
              {
                value: "light",
                label: t("settings.appearance.light"),
                icon: Sun,
              },
              {
                value: "dark",
                label: t("settings.appearance.dark"),
                icon: Moon,
              },
            ]}
          />
        </div>
      </div>
    </Section>
  );
}

/** The interface's language. */
export function LanguageSection() {
  const { t, locale, setLocale } = useI18n();
  return (
    <Section title={t("settings.language.title")}>
      <div className={styles.card}>
        <div className={styles.setting}>
          <span className={styles.settingLabel}>
            {t("settings.language.label")}
          </span>
          <SegmentedControl<Locale>
            kind="radio"
            label={t("settings.language.label")}
            value={locale}
            onChange={setLocale}
            options={[
              { value: "zh", label: t("settings.language.zh") },
              { value: "en", label: t("settings.language.en") },
            ]}
          />
        </div>
      </div>
    </Section>
  );
}

/** Whether a paper's key sentences are found and underlined when it is opened. */
export function KeypointsSection() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useKeypointsEnabled();
  return (
    <Section title={t("settings.keypoints.title")}>
      <div className={styles.card}>
        <div className={styles.setting}>
          <span className={styles.settingLabel}>
            {t("settings.keypoints.label")}
          </span>
          <SegmentedControl<"on" | "off">
            kind="radio"
            label={t("settings.keypoints.label")}
            value={enabled ? "on" : "off"}
            onChange={(value) => setEnabled(value === "on")}
            options={[
              { value: "on", label: t("settings.keypoints.on") },
              { value: "off", label: t("settings.keypoints.off") },
            ]}
          />
        </div>
      </div>
    </Section>
  );
}
