import { useI18n } from "../../i18n/I18nProvider";
import { Button } from "../../ui";

/** Return to the conversation after connecting a model; its draft stays put. */
export function openModelSetup() {
  const params = new URLSearchParams({
    returnTo: window.location.hash.slice(1) || "new",
  });
  window.location.hash = `customize/models?${params}`;
}

export function AddModelButton({ disabled = false }: { disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <Button
      variant="primary"
      size="sm"
      disabled={disabled}
      onClick={openModelSetup}
    >
      {t("settings.models.add")}
    </Button>
  );
}
