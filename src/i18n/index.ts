import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { zh } from "./zh";
import { en } from "./en";
import { initialLanguage } from "./language";

const language = initialLanguage();

// 资源内联打包，同步初始化，无需 Suspense；React 已做转义，关闭 escapeValue。
void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: language,
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

// 同步 <html lang>（切换语言时由 setLanguage 负责更新）
try {
  if (typeof document !== "undefined") document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
} catch {
  // 非浏览器环境忽略
}

export default i18n;
