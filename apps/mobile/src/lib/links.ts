import { Linking, Platform } from "react-native";
import Constants from "expo-constants";

/** Public web addresses (served by apps/site) and the contact address. */
export const SITE = "https://knowyourspend.org";
export const CONTACT_EMAIL = "hello@knowyourspend.org";
export const PRIVACY_URL = `${SITE}/privacy`;
export const TERMS_URL = `${SITE}/terms`;
export const SUPPORT_URL = `${SITE}/support`;

export function openUrl(url: string): void {
  Linking.openURL(url).catch(() => {});
}

/**
 * Opens an email to us about a wrong answer. Only what the user can see in the email draft is sent,
 * and only if they press send in their own mail app — the app itself sends nothing.
 */
export function reportMistake(about?: string): void {
  const subject = about ? `Ownership mistake: ${about}` : "Ownership mistake";
  const body = "What's wrong, and where did you see the right answer?\n\n";
  openUrl(`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
}

/**
 * Opens an email to us about a problem, with the app version and platform filled in. As above, the
 * person sees the whole draft and nothing is sent unless they press send in their own mail app.
 */
export function reportProblem(details?: string): void {
  const version = Constants.expoConfig?.version ?? "";
  const where = Platform.OS === "web" && typeof navigator !== "undefined" ? `web · ${navigator.userAgent}` : `${Platform.OS} ${String(Platform.Version ?? "")}`;
  const body = `What happened, and what were you trying to do?\n\n\n---\nKnowYourSpend ${version} · ${where}${details ? `\nError: ${details}` : ""}\n`;
  openUrl(`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Problem with KnowYourSpend")}&body=${encodeURIComponent(body)}`);
}
