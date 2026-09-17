/**
 * Device info detection (client-only).
 * Capacitor import is optional for server environments (functions).
 */

let Capacitor: { isNativePlatform?: () => boolean; getPlatform?: () => string } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cap = require("@capacitor/core");
  Capacitor = cap.Capacitor ?? null;
} catch {
  // Capacitor not available (e.g., in Cloud Functions)
  Capacitor = null;
}

export interface DeviceInfo {
  device: string;
  browser: string;
  os: string;
}

export function getDeviceInfo(): DeviceInfo {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  let browser = "Unknown Browser";
  let os = "Unknown OS";
  let device = "Desktop Workspace";

  // Canonical native check (matches the push guard): the legacy
  // window.Capacitor.isNative flag misclassifies live-reload web sessions.
  if (Capacitor?.isNativePlatform?.()) {
    browser = `Capacitor WebView (${Capacitor.getPlatform?.() ?? "unknown"})`;
    device = "Mobile Application";
  } else if (/Mobi|Android|iPhone|iPad/i.test(ua)) {
    device = "Mobile Browser";
  }

  if (/android/i.test(ua)) {
    os = "Android";
  } else if (/iPad|iPhone|iPod/i.test(ua)) {
    os = "iOS";
  } else if (/macintosh|mac os x/i.test(ua)) {
    os = "macOS";
  } else if (/windows/i.test(ua)) {
    os = "Windows";
  } else if (/linux/i.test(ua)) {
    os = "Linux";
  }

  if (browser === "Unknown Browser") {
    if (/chrome|crios|crmo/i.test(ua) && !/edge|edg/i.test(ua)) {
      browser = "Chrome";
    } else if (/safari/i.test(ua) && !/chrome/i.test(ua)) {
      browser = "Safari";
    } else if (/firefox|fxios/i.test(ua)) {
      browser = "Firefox";
    } else if (/edge|edg/i.test(ua)) {
      browser = "Edge";
    }
  }

  return { device, browser, os };
}