export type LocaleRequest = string | readonly string[] | null | undefined;
export type MessageValues = Readonly<Record<string, unknown>>;
export type MessageCatalog = Readonly<Record<string, string>>;
export type MessageCatalogs = Readonly<Record<string, MessageCatalog>>;

export const DEFAULT_LOCALE: "en-US";
export const SYSTEM_LOCALE_PREFERENCE: "system";
export const SUPPORTED_LOCALES: readonly ["en-US", "zh-Hans", "es"];
export const LANGUAGE_OPTIONS: readonly Readonly<{
  id: "system" | "en-US" | "zh-Hans" | "es";
  nativeLabel: string;
}>[];
export const EN_US_CATALOG: MessageCatalog;
export const ZH_HANS_CATALOG: MessageCatalog;
export const ES_CATALOG: MessageCatalog;
export const CATALOGS: Readonly<{
  "en-US": MessageCatalog;
  "zh-Hans": MessageCatalog;
  es: MessageCatalog;
}>;

export function negotiateLocale(
  requestedLocales?: LocaleRequest,
  supportedLocales?: readonly string[],
  fallbackLocale?: string,
): string;

export function resolveLocalePreference(
  preference: string | null | undefined,
  systemLocales?: LocaleRequest,
  supportedLocales?: readonly string[],
  fallbackLocale?: string,
): string;

export function isLanguagePreference(value: unknown): boolean;

export function getMessage(
  catalog: MessageCatalog,
  key: string,
  fallback?: string,
): string;

export function interpolateMessage(
  message: string,
  values?: MessageValues,
): string;

export interface TranslateOptions {
  locale?: LocaleRequest;
  catalogs?: MessageCatalogs;
  fallbackLocale?: string;
}

export function translate(
  key: string,
  values?: MessageValues,
  options?: TranslateOptions,
): string;

export function formatNumber(
  value: number | bigint,
  locale?: LocaleRequest,
  options?: Intl.NumberFormatOptions,
): string;

export function formatPercent(
  value: number,
  locale?: LocaleRequest,
  options?: Intl.NumberFormatOptions,
): string;

export function formatDate(
  value: Date | number | string,
  locale?: LocaleRequest,
  options?: Intl.DateTimeFormatOptions,
): string;
