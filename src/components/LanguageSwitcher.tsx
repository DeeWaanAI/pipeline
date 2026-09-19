import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Globe } from "lucide-react";
import { LANGUAGES } from "@/i18n-languages";

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation("common");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-md transition-colors"
          title={t("language.switchLanguage")}
        >
          <Globe className="w-3.5 h-3.5" />
          <span>{LANGUAGES.find((l) => l.code === i18n.language)?.label ?? "EN"}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="bg-neutral-800 border-neutral-700 text-neutral-100 min-w-[120px]"
      >
        {LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => i18n.changeLanguage(lang.code)}
            className={`text-xs cursor-pointer ${
              i18n.language === lang.code
                ? "text-blue-400 bg-blue-500/10"
                : "text-neutral-300 hover:text-neutral-100 hover:bg-neutral-700"
            }`}
          >
            {lang.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
