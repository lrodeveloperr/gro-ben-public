import { Directory, File, Paths } from "expo-file-system";
import {
  getTrackingPermissionsAsync,
  requestTrackingPermissionsAsync,
} from "expo-tracking-transparency";
import * as Notifications from "expo-notifications";
import * as Sharing from "expo-sharing";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Linking,
  Share,
  StyleSheet,
  View,
} from "react-native";
import mobileAds, {
  AdsConsent,
  AdsConsentPrivacyOptionsRequirementStatus,
  BannerAd,
  BannerAdSize,
  MaxAdContentRating,
  TestIds,
} from "react-native-google-mobile-ads";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView as PackageWebView } from "react-native-webview";
import type {
  IOSWebViewProps,
  ShouldStartLoadRequest,
  WebViewMessageEvent,
  WebViewOpenWindowEvent,
} from "react-native-webview/lib/WebViewTypes";

import APP_HTML from "./src/appHtml";
import {
  connectRemoveAdsStore,
  fetchRemoveAdsProduct,
  finishVerifiedRemoveAdsPurchase,
  isRemoveAdsAlreadyOwned,
  isRemoveAdsPurchaseCancelled,
  isRemoveAdsPurchaseEvent,
  isRemoveAdsPurchasePending,
  readVerifiedRemoveAdsEntitlement,
  requestRemoveAdsPurchase,
  restoreRemoveAdsPurchase,
} from "./src/removeAdsPurchase";
import type {
  RemoveAdsProduct,
  RemoveAdsStoreConnection,
} from "./src/removeAdsPurchase";

const LOCAL_APP_ORIGIN = "https://snap-ebt-wic.local/";
const AD_SLOT_HEIGHT = 50;
const AD_SLOT_BOTTOM = 66;
const GOOGLE_DEMO_PUBLISHER_ID = "3940256099942544";
const STOREKIT_CONNECTION_RETRY_DELAYS_MS = [0, 1000, 3000] as const;
const STOREKIT_ENTITLEMENT_RETRY_DELAYS_MS = [0, 500, 2000] as const;
const MAX_SHARE_BYTES = 20 * 1024 * 1024;
const MAX_SHARE_DATA_URL_CHARS = 28 * 1024 * 1024;
const NOTIFICATION_OWNER = "snap-ebt-grocery-tracker:local-reminder:v1";
const NOTIFICATION_IDENTIFIER_PREFIX = "gbt-local-reminder-v1:";
const MAX_OWNED_REMINDERS = 48;

type ConsentState = "unresolved" | "permitted" | "blocked";
type NativeAdState = "idle" | "loading" | "loaded" | "failed";
type RemoveAdsEntitlementState =
  | "checking"
  | "not-entitled"
  | "entitled"
  | "unknown";
type RemoveAdsProductState = "loading" | "ready" | "unavailable";
type RemoveAdsOperation = "idle" | "purchasing" | "restoring";
type RemoveAdsAction = "purchase" | "restore";
type RemoveAdsActionContext = {
  kind: RemoveAdsAction;
  token: number;
};
type RemoveAdsResult =
  | "success"
  | "already-active"
  | "pending"
  | "cancelled"
  | "none"
  | "failed";
type ReminderKind = "snap-balance" | "wic-review" | "wic-expiry";
type ReminderLocale = "en-US" | "es-PR";

type NativeReminderSpec = {
  id: string;
  kind: ReminderKind;
  fireAt: string;
  locale: ReminderLocale;
};

type WebViewHandle = {
  injectJavaScript: (script: string) => void;
  reload: () => void;
};

const NativeWebView = PackageWebView as unknown as React.ForwardRefExoticComponent<
  IOSWebViewProps & React.RefAttributes<WebViewHandle>
>;

type BridgeMessage =
  | { type: "bridge-ready" }
  | { type: "legal-ready"; ready: boolean }
  | { type: "ad-eligibility"; eligible: boolean }
  | {
      type: "ad-presentation";
      state: string;
      height: number;
      eligible: boolean;
    }
  | { type: "privacy-choices" }
  | { type: "purchase-remove-ads" }
  | { type: "restore-remove-ads" }
  | { type: "share-text"; title?: string; text?: string; url?: string }
  | {
      type: "share-file";
      requestId?: string;
      name?: string;
      mimeType?: string;
      dataUrl?: string;
    }
  | {
      type: "notifications-reconcile";
      requestId?: string;
      optedIn?: boolean;
      requestPermission?: boolean;
      reminders?: unknown;
    }
  | { type: "clear-app-data"; requestId?: string };

function waitFor(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

const AD_RETRY_DELAYS_MS = [
  2_000,
  5_000,
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
] as const;
const OFFLINE_REACHABILITY_POLL_MS = 30_000;
const NETWORK_RECOVERY_DEBOUNCE_MS = 1_500;
const AD_NETWORK_PROBE_TIMEOUT_MS = 4_000;
const AD_NETWORK_PROBE_URL =
  "https://pagead2.googlesyndication.com/pagead/gen_204";

type AdDiagnostics = {
  attempts: number;
  loads: number;
  failures: number;
  reachabilityFailures: number;
  foregroundRecoveries: number;
  lastAttemptAt: number | null;
  lastLoadedAt: number | null;
  lastFailureAt: number | null;
};

function createAdDiagnostics(): AdDiagnostics {
  return {
    attempts: 0,
    loads: 0,
    failures: 0,
    reachabilityFailures: 0,
    foregroundRecoveries: 0,
    lastAttemptAt: null,
    lastLoadedAt: null,
    lastFailureAt: null,
  };
}

function nextAdRetryDelay(attempt: number) {
  const index = Math.min(
    Math.max(0, Math.trunc(attempt)),
    AD_RETRY_DELAYS_MS.length - 1,
  );
  return AD_RETRY_DELAYS_MS[index] ?? 300_000;
}

function withRetryJitter(delayMs: number, random = Math.random) {
  const jitter = (random() * 0.3 - 0.15) * delayMs;
  return Math.max(250, Math.round(delayMs + jitter));
}

async function probeAdNetworkReachability(
  timeoutMs = AD_NETWORK_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(AD_NETWORK_PROBE_URL, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "Cache-Control": "no-cache, no-store, max-age=0",
        Pragma: "no-cache",
      },
    });
    // Captive portals commonly return a page or redirect instead of Google's
    // expected 204. Treat anything else as not-yet-reachable.
    return response.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function hasMatchingProductionAdMobIdentifiers(
  approvedPublisherId: string,
  appId: string,
  bannerId: string,
) {
  const appMatch = /^ca-app-pub-(\d{16})~\d{10}$/.exec(appId);
  const bannerMatch = /^ca-app-pub-(\d{16})\/\d{10}$/.exec(bannerId);
  return Boolean(
    /^\d{16}$/.test(approvedPublisherId) &&
      approvedPublisherId !== GOOGLE_DEMO_PUBLISHER_ID &&
      appMatch?.[1] === approvedPublisherId &&
      bannerMatch?.[1] === approvedPublisherId,
  );
}

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const isOwned =
      notification.request.content.data?.owner === NOTIFICATION_OWNER;
    return {
      shouldShowBanner: isOwned,
      shouldShowList: isOwned,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});

const NATIVE_BRIDGE_SCRIPT = String.raw`
(function () {
  if (window.__GBT_NATIVE_BRIDGE_INSTALLED__) return;
  window.__GBT_NATIVE_BRIDGE_INSTALLED__ = true;
  const post = function (payload) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    } catch (_) {}
  };
  const bridgeError = function (code, message) {
    const error = new Error(String(message || code || "Native operation failed"));
    error.code = String(code || "NATIVE_OPERATION_FAILED");
    return error;
  };

  const pendingFileShares = Object.create(null);
  let fileShareInFlight = false;
  window.GBTNativeShareCompleted = function (requestId, ok, code, message) {
    const pending = pendingFileShares[String(requestId || "")];
    if (!pending) return;
    delete pendingFileShares[String(requestId || "")];
    window.clearTimeout(pending.timeout);
    fileShareInFlight = false;
    if (ok) pending.resolve();
    else pending.reject(bridgeError(code || "SHARE_FAILED", message || "File export failed"));
  };
  window.GBTNativeShareFile = function (blob, name, mimeType) {
    if (!(blob instanceof Blob)) {
      return Promise.reject(bridgeError("SHARE_INVALID_BLOB", "Invalid export file"));
    }
    if (fileShareInFlight) {
      return Promise.reject(bridgeError("SHARE_BUSY", "Another export is already open"));
    }
    if (blob.size <= 0 || blob.size > 20 * 1024 * 1024) {
      return Promise.reject(bridgeError("SHARE_SIZE_UNSUPPORTED", "Export file size is not supported"));
    }
    fileShareInFlight = true;
    const requestId = "share-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    return new Promise(function (resolve, reject) {
      const timeout = window.setTimeout(function () {
        delete pendingFileShares[requestId];
        fileShareInFlight = false;
        reject(bridgeError("SHARE_TIMEOUT", "The iPhone share sheet did not respond"));
      }, 120000);
      pendingFileShares[requestId] = { resolve: resolve, reject: reject, timeout: timeout };
      const reader = new FileReader();
      reader.onload = function () {
        const dataUrl = String(reader.result || "");
        if (!dataUrl || dataUrl.length > 28 * 1024 * 1024) {
          window.GBTNativeShareCompleted(
            requestId,
            false,
            "SHARE_SIZE_UNSUPPORTED",
            "Export file size is not supported"
          );
          return;
        }
        post({
          type: "share-file",
          requestId: requestId,
          name: String(name || "export"),
          mimeType: String(mimeType || blob.type || "application/octet-stream"),
          dataUrl: dataUrl
        });
      };
      reader.onerror = function () {
        window.GBTNativeShareCompleted(
          requestId,
          false,
          "SHARE_READ_FAILED",
          "Export file could not be read"
        );
      };
      try {
        reader.readAsDataURL(blob);
      } catch (_) {
        window.GBTNativeShareCompleted(
          requestId,
          false,
          "SHARE_READ_FAILED",
          "Export file could not be read"
        );
      }
    });
  };

  const pendingNotificationReconciles = Object.create(null);
  let notificationReconcileInFlight = false;
  window.GBTNativeNotificationReconciled = function (
    requestId,
    ok,
    code,
    scheduledCount,
    message
  ) {
    const pending = pendingNotificationReconciles[String(requestId || "")];
    if (!pending) return;
    delete pendingNotificationReconciles[String(requestId || "")];
    window.clearTimeout(pending.timeout);
    notificationReconcileInFlight = false;
    if (ok) {
      pending.resolve({
        code: String(code || "NOTIFICATIONS_RECONCILED"),
        scheduledCount: Number(scheduledCount) || 0
      });
    } else {
      pending.reject(
        bridgeError(
          code || "NOTIFICATIONS_FAILED",
          message || "Reminders could not be scheduled"
        )
      );
    }
  };
  window.GBTNativeReconcileNotifications = function (options) {
    if (
      !options ||
      typeof options !== "object" ||
      typeof options.optedIn !== "boolean" ||
      !Array.isArray(options.reminders)
    ) {
      return Promise.reject(
        bridgeError("NOTIFICATIONS_INVALID_REQUEST", "Invalid reminder request")
      );
    }
    if (notificationReconcileInFlight) {
      return Promise.reject(
        bridgeError("NOTIFICATIONS_BUSY", "Reminder settings are already being saved")
      );
    }
    notificationReconcileInFlight = true;
    const requestId = "notifications-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    return new Promise(function (resolve, reject) {
      const timeout = window.setTimeout(function () {
        delete pendingNotificationReconciles[requestId];
        notificationReconcileInFlight = false;
        reject(
          bridgeError("NOTIFICATIONS_TIMEOUT", "The iPhone reminder service did not respond")
        );
      }, 30000);
      pendingNotificationReconciles[requestId] = {
        resolve: resolve,
        reject: reject,
        timeout: timeout
      };
      post({
        type: "notifications-reconcile",
        requestId: requestId,
        optedIn: options.optedIn === true,
        requestPermission: options.requestPermission === true,
        reminders: options.reminders
      });
    });
  };

  const pendingAppDataClears = Object.create(null);
  let appDataClearInFlight = false;
  window.GBTNativeClearAppDataCompleted = function (requestId, ok, code, message) {
    const pending = pendingAppDataClears[String(requestId || "")];
    if (!pending) return;
    delete pendingAppDataClears[String(requestId || "")];
    window.clearTimeout(pending.timeout);
    appDataClearInFlight = false;
    if (ok) {
      pending.resolve({ code: String(code || "APP_DATA_CLEARED") });
    } else {
      pending.reject(
        bridgeError(
          code || "APP_DATA_CLEAR_FAILED",
          message || "Native app data could not be cleared"
        )
      );
    }
  };
  window.GBTNativeClearAppData = function () {
    if (appDataClearInFlight) {
      return Promise.reject(
        bridgeError("APP_DATA_CLEAR_BUSY", "App data is already being cleared")
      );
    }
    appDataClearInFlight = true;
    const requestId = "clear-app-data-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    return new Promise(function (resolve, reject) {
      const timeout = window.setTimeout(function () {
        delete pendingAppDataClears[requestId];
        appDataClearInFlight = false;
        reject(
          bridgeError("APP_DATA_CLEAR_TIMEOUT", "The iPhone data service did not respond")
        );
      }, 30000);
      pendingAppDataClears[requestId] = {
        resolve: resolve,
        reject: reject,
        timeout: timeout
      };
      post({ type: "clear-app-data", requestId: requestId });
    });
  };

  const nativeShare = async function (payload) {
    const files = payload && payload.files ? Array.from(payload.files) : [];
    if (files.length) {
      const file = files[0];
      return window.GBTNativeShareFile(
        file,
        file.name || "export",
        file.type || "application/octet-stream"
      );
    }
    post({
      type: "share-text",
      title: payload && payload.title ? String(payload.title) : "",
      text: payload && payload.text ? String(payload.text) : "",
      url: payload && payload.url ? String(payload.url) : ""
    });
  };

  try {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: function (payload) {
        return Boolean(payload && payload.files && payload.files.length);
      }
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: nativeShare
    });
  } catch (_) {}

  try {
    window.webkit = window.webkit || {};
    window.webkit.messageHandlers = window.webkit.messageHandlers || {};
    window.webkit.messageHandlers.openPrivacyChoices = {
      postMessage: function () { post({ type: "privacy-choices" }); }
    };
  } catch (_) {}

  let lastEligibility = null;
  let lastPresentation = "";
  const publishAdPresentation = function () {
    const runtime = window.GBTAdRuntime;
    if (!runtime || typeof runtime.getLayoutMetrics !== "function") return;
    const metrics = runtime.getLayoutMetrics();
    const eligible = Boolean(metrics.canRequestRealAd);
    if (eligible !== lastEligibility) {
      lastEligibility = eligible;
      post({ type: "ad-eligibility", eligible: eligible });
    }
    const presentation = String(metrics.state) + "|" + String(metrics.runtimeHeight) + "|" + String(eligible);
    if (presentation !== lastPresentation) {
      lastPresentation = presentation;
      post({
        type: "ad-presentation",
        state: String(metrics.state || ""),
        height: Number(metrics.runtimeHeight) || 0,
        eligible: eligible
      });
    }
  };
  window.addEventListener("gbt-ad-presentation-change", publishAdPresentation);
  window.setInterval(publishAdPresentation, 250);
  publishAdPresentation();

  post({ type: "bridge-ready" });
})();
true;
`;

class NativeBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeBridgeError";
    this.code = code;
  }
}

function sanitizedFileName(value: unknown) {
  const name = String(value || "export")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return name || "export";
}

function parseDataUrl(dataUrl: string) {
  if (!dataUrl || dataUrl.length > MAX_SHARE_DATA_URL_CHARS) {
    throw new NativeBridgeError(
      "SHARE_SIZE_UNSUPPORTED",
      "Export file size is not supported",
    );
  }
  const separator = dataUrl.indexOf(",");
  if (separator < 0) {
    throw new NativeBridgeError(
      "SHARE_INVALID_DATA_URL",
      "Invalid file payload",
    );
  }
  const header = dataUrl.slice(0, separator);
  const payload = dataUrl.slice(separator + 1);
  if (
    !/^data:[^,]*;base64$/i.test(header) ||
    payload.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)
  ) {
    throw new NativeBridgeError(
      "SHARE_INVALID_BASE64",
      "Invalid base64 file payload",
    );
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const byteLength = (payload.length / 4) * 3 - padding;
  if (byteLength <= 0 || byteLength > MAX_SHARE_BYTES) {
    throw new NativeBridgeError(
      "SHARE_SIZE_UNSUPPORTED",
      "Export file size is not supported",
    );
  }
  return { payload, byteLength };
}

function nativeBridgeFailure(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
) {
  return error instanceof NativeBridgeError
    ? error
    : new NativeBridgeError(fallbackCode, fallbackMessage);
}

function notificationIdentifier(id: string) {
  return `${NOTIFICATION_IDENTIFIER_PREFIX}${id}`;
}

function normalizeReminderSpecs(value: unknown): NativeReminderSpec[] {
  if (!Array.isArray(value)) {
    throw new NativeBridgeError(
      "NOTIFICATIONS_INVALID_REQUEST",
      "Reminder list is invalid",
    );
  }
  if (value.length > MAX_OWNED_REMINDERS) {
    throw new NativeBridgeError(
      "NOTIFICATIONS_TOO_MANY",
      `No more than ${MAX_OWNED_REMINDERS} local reminders can be scheduled`,
    );
  }

  const now = Date.now();
  const latest = now + 370 * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new NativeBridgeError(
        "NOTIFICATIONS_INVALID_REMINDER",
        `Reminder ${index + 1} is invalid`,
      );
    }
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const kind = record.kind;
    const fireAt =
      typeof record.fireAt === "string" ? record.fireAt.trim() : "";
    const locale = record.locale;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id) || seen.has(id)) {
      throw new NativeBridgeError(
        "NOTIFICATIONS_INVALID_REMINDER_ID",
        `Reminder ${index + 1} has an invalid or duplicate identifier`,
      );
    }
    if (
      kind !== "snap-balance" &&
      kind !== "wic-review" &&
      kind !== "wic-expiry"
    ) {
      throw new NativeBridgeError(
        "NOTIFICATIONS_INVALID_KIND",
        `Reminder ${index + 1} has an unsupported type`,
      );
    }
    if (locale !== "en-US" && locale !== "es-PR") {
      throw new NativeBridgeError(
        "NOTIFICATIONS_INVALID_LOCALE",
        `Reminder ${index + 1} has an unsupported locale`,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(fireAt)) {
      throw new NativeBridgeError(
        "NOTIFICATIONS_INVALID_DATE",
        `Reminder ${index + 1} must include a time zone`,
      );
    }
    const fireAtMs = Date.parse(fireAt);
    if (!Number.isFinite(fireAtMs) || fireAtMs <= now + 30_000 || fireAtMs > latest) {
      throw new NativeBridgeError(
        "NOTIFICATIONS_INVALID_DATE",
        `Reminder ${index + 1} is outside the supported scheduling window`,
      );
    }
    seen.add(id);
    return { id, kind, fireAt: new Date(fireAtMs).toISOString(), locale };
  });
}

function notificationCopy(kind: ReminderKind, locale: ReminderLocale) {
  if (locale === "es-PR") {
    if (kind === "snap-balance") {
      return {
        title: "Recordatorio de SNAP",
        body: "Abre la aplicación para revisar tu saldo guardado en este dispositivo.",
      };
    }
    return kind === "wic-review"
      ? {
          title: "Recordatorio de WIC",
          body: "Abre la aplicación para revisar tus beneficios mensuales de WIC.",
        }
      : {
          title: "Beneficios de WIC por vencer",
          body: "Abre la aplicación para revisar los beneficios que vencen pronto.",
        };
  }
  if (kind === "snap-balance") {
    return {
      title: "SNAP reminder",
      body: "Open the app to review the balance stored on this device.",
    };
  }
  return kind === "wic-review"
    ? {
        title: "WIC reminder",
        body: "Open the app to review your monthly WIC benefits.",
      }
    : {
        title: "WIC benefits expiring soon",
        body: "Open the app to review benefits that are nearing expiration.",
      };
}

function isOwnedNotification(request: Notifications.NotificationRequest) {
  return request.content.data?.owner === NOTIFICATION_OWNER;
}

async function cancelOwnedScheduledReminders(keep = new Set<string>()) {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter(
        (request) =>
          isOwnedNotification(request) && !keep.has(request.identifier),
      )
      .map((request) =>
        Notifications.cancelScheduledNotificationAsync(request.identifier),
      ),
  );
}

function purgeShareCacheRoot() {
  const shareCacheRoot = new Directory(Paths.cache, "gbt-share");
  if (shareCacheRoot.exists) shareCacheRoot.delete();
  if (shareCacheRoot.exists) {
    throw new NativeBridgeError(
      "APP_DATA_CACHE_CLEAR_FAILED",
      "Temporary export files could not be cleared",
    );
  }
}

function notificationsAllowed(
  permission: Notifications.NotificationPermissionsStatus,
) {
  return (
    permission.granted ||
    permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    permission.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL
  );
}

function fileUti(name: string, mimeType?: string) {
  const extension = name.toLowerCase().split(".").pop();
  if (extension === "pdf" || mimeType === "application/pdf") {
    return "com.adobe.pdf";
  }
  if (extension === "csv" || mimeType?.startsWith("text/csv")) {
    return "public.comma-separated-values-text";
  }
  if (
    extension === "xlsx" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "org.openxmlformats.spreadsheetml.sheet";
  }
  if (extension === "json" || mimeType?.startsWith("application/json")) {
    return "public.json";
  }
  if (extension === "txt" || mimeType?.startsWith("text/plain")) {
    return "public.plain-text";
  }
  return "public.data";
}

export default function App() {
  const webViewRef = useRef<WebViewHandle>(null);
  const adsInitializationRef = useRef<Promise<boolean> | null>(null);
  const trackingAuthorizationRef = useRef<Promise<boolean> | null>(null);
  const previousWebAdStateRef = useRef("AD_LOADING");
  const appStateRef = useRef(AppState.currentState);
  const adLoadInFlightRef = useRef(false);
  const adNetworkReachableRef = useRef<boolean | null>(null);
  const adDiagnosticsRef = useRef(createAdDiagnostics());
  const removeAdsEntitlementRef =
    useRef<RemoveAdsEntitlementState>("checking");
  const removeAdsEntitledRef = useRef(false);
  const removeAdsStoreRef = useRef<RemoveAdsStoreConnection | null>(null);
  const removeAdsOperationRef = useRef<RemoveAdsOperation>("idle");
  const removeAdsActionRef = useRef<RemoveAdsActionContext | null>(null);
  const removeAdsActionSequenceRef = useRef(0);
  const removeAdsDeliveryQueueRef = useRef<Promise<void>>(Promise.resolve());
  const removeAdsReconcileQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [webReady, setWebReady] = useState(false);
  const [legalReady, setLegalReady] = useState(false);
  const [privacyChoicesRequired, setPrivacyChoicesRequired] = useState(false);
  const [removeAdsEntitlement, setRemoveAdsEntitlement] =
    useState<RemoveAdsEntitlementState>("checking");
  const [removeAdsProductState, setRemoveAdsProductState] =
    useState<RemoveAdsProductState>("loading");
  const [removeAdsProduct, setRemoveAdsProduct] =
    useState<RemoveAdsProduct | null>(null);
  const [removeAdsStoreReady, setRemoveAdsStoreReady] = useState(false);
  const [removeAdsOperation, setRemoveAdsOperation] =
    useState<RemoveAdsOperation>("idle");
  const [consentState, setConsentState] =
    useState<ConsentState>("unresolved");
  const [adEligible, setAdEligible] = useState(false);
  const [nativeAdState, setNativeAdState] =
    useState<NativeAdState>("idle");
  const [webAdState, setWebAdState] = useState("AD_LOADING");
  const [adLoadAttempt, setAdLoadAttempt] = useState(0);
  const [bannerInstance, setBannerInstance] = useState(0);

  const productionBannerId =
    process.env.EXPO_PUBLIC_IOS_ADMOB_BANNER_ID?.trim() || "";
  const productionAppId =
    process.env.EXPO_PUBLIC_IOS_ADMOB_APP_ID?.trim() || "";
  const approvedPublisherId =
    process.env.EXPO_PUBLIC_ADMOB_PUBLISHER_ID?.trim() || "";
  const adProfile = process.env.EXPO_PUBLIC_AD_PROFILE?.trim() || "";
  const testAds = adProfile === "test";
  const productionAds = adProfile === "production";
  const productionAdsConfigured =
    productionAds &&
    hasMatchingProductionAdMobIdentifiers(
      approvedPublisherId,
      productionAppId,
      productionBannerId,
    );
  const adProfileConfigured = testAds || productionAdsConfigured;
  const bannerUnitId = testAds
    ? TestIds.BANNER
    : productionAdsConfigured
      ? productionBannerId
      : "";

  useEffect(() => {
    try {
      purgeShareCacheRoot();
    } catch (error) {
      console.warn("Stale export cache cleanup failed", error);
    }
    void Promise.allSettled([
      Notifications.setAutoServerRegistrationEnabledAsync(false),
      Notifications.unregisterForNotificationsAsync(),
    ]);
  }, []);

  const setRemoveAdsOperationState = useCallback(
    (operation: RemoveAdsOperation) => {
      removeAdsOperationRef.current = operation;
      setRemoveAdsOperation(operation);
    },
    [],
  );

  const applyRemoveAdsEntitlementState = useCallback(
    (entitlement: RemoveAdsEntitlementState) => {
      removeAdsEntitlementRef.current = entitlement;
      removeAdsEntitledRef.current = entitlement === "entitled";
      setRemoveAdsEntitlement(entitlement);
      if (entitlement === "entitled") {
        // Remove the ad path immediately. Any outstanding retry callback also
        // re-checks this ref before it can remount a banner.
        adLoadInFlightRef.current = false;
        adNetworkReachableRef.current = null;
        setNativeAdState("idle");
        setAdLoadAttempt(0);
      }
    },
    [],
  );

  const completeRemoveAdsAction = useCallback(
    (action: RemoveAdsAction, result: RemoveAdsResult) => {
      webViewRef.current?.injectJavaScript(`
        window.GBTPurchaseRuntime?.complete(
          ${JSON.stringify(action)},
          ${JSON.stringify(result)}
        );
        true;
      `);
    },
    [],
  );

  const refreshRemoveAdsProduct = useCallback(async () => {
    setRemoveAdsProductState("loading");
    try {
      const product = await fetchRemoveAdsProduct();
      if (!product) {
        setRemoveAdsProduct(null);
        setRemoveAdsProductState("unavailable");
        return null;
      }
      if (product.priceMatchesExpected === false) {
        const message =
          `StoreKit returned ${product.displayPrice} for the U.S. storefront, but Remove Ads is intended to be USD ${product.expectedUsdPrice.toFixed(2)}. Check App Store Connect. StoreKit remains authoritative and purchasing is not blocked.`;
        console.warn("[IAP PRICE MISMATCH]", message);
        if (testAds) {
          Alert.alert("Price configuration mismatch", message);
        }
      }
      setRemoveAdsProduct(product);
      setRemoveAdsProductState("ready");
      return product;
    } catch (error) {
      console.warn("StoreKit product lookup failed", error);
      setRemoveAdsProduct(null);
      setRemoveAdsProductState("unavailable");
      return null;
    }
  }, [testAds]);

  const reconcileRemoveAdsEntitlement = useCallback(() => {
    const reconciliation = removeAdsReconcileQueueRef.current.then(
      async (): Promise<boolean | null> => {
        for (const delay of STOREKIT_ENTITLEMENT_RETRY_DELAYS_MS) {
          if (delay > 0) await waitFor(delay);
          try {
            const result = await readVerifiedRemoveAdsEntitlement();
            applyRemoveAdsEntitlementState(
              result.entitled ? "entitled" : "not-entitled",
            );
            return result.entitled;
          } catch {}
        }
        applyRemoveAdsEntitlementState(
          removeAdsEntitledRef.current ? "entitled" : "unknown",
        );
        return null;
      },
    );
    removeAdsReconcileQueueRef.current = reconciliation.then(() => undefined);
    return reconciliation;
  }, [applyRemoveAdsEntitlementState]);

  const deliverRemoveAdsPurchase = useCallback(
    (
      purchase: Parameters<typeof isRemoveAdsPurchaseEvent>[0],
      purchaseAction: RemoveAdsActionContext | null,
    ) => {
      if (!isRemoveAdsPurchaseEvent(purchase)) return Promise.resolve();
      const delivery = removeAdsDeliveryQueueRef.current.then(async () => {
        if (purchase.purchaseState !== "purchased") {
          if (
            purchaseAction?.kind === "purchase" &&
            removeAdsActionRef.current === purchaseAction
          ) {
            removeAdsActionRef.current = null;
            completeRemoveAdsAction(
              "purchase",
              purchase.purchaseState === "pending" ? "pending" : "failed",
            );
            setRemoveAdsOperationState("idle");
          }
          return;
        }
        const ownsPurchaseAction =
          purchaseAction?.kind === "purchase" &&
          removeAdsActionRef.current === purchaseAction;
        if (ownsPurchaseAction) removeAdsActionRef.current = null;
        try {
          const entitled = await reconcileRemoveAdsEntitlement();
          if (entitled !== true) {
            if (ownsPurchaseAction) {
              completeRemoveAdsAction("purchase", "failed");
            }
            return;
          }
          if (ownsPurchaseAction) {
            completeRemoveAdsAction("purchase", "success");
          }
          try {
            await finishVerifiedRemoveAdsPurchase(purchase);
          } catch (error) {
            console.warn(
              "StoreKit will replay the unfinished transaction",
              error,
            );
            Alert.alert(
              "Purchase saved",
              "Your Remove Ads purchase is active, but Apple could not finish the transaction cleanly after several attempts. If ads ever return, use Restore Purchases or contact support.",
            );
          }
        } finally {
          if (ownsPurchaseAction) setRemoveAdsOperationState("idle");
        }
      });
      removeAdsDeliveryQueueRef.current = delivery.catch((error) => {
        console.warn("StoreKit transaction delivery failed", error);
      });
      return delivery;
    },
    [
      completeRemoveAdsAction,
      reconcileRemoveAdsEntitlement,
      setRemoveAdsOperationState,
    ],
  );

  const settleRemoveAdsPurchaseError = useCallback(
    async (error: unknown, action: RemoveAdsActionContext | null) => {
      if (
        action?.kind !== "purchase" ||
        removeAdsActionRef.current !== action
      ) {
        return;
      }
      removeAdsActionRef.current = null;
      try {
        if (isRemoveAdsAlreadyOwned(error)) {
          const entitled = await reconcileRemoveAdsEntitlement();
          completeRemoveAdsAction(
            "purchase",
            entitled === true ? "success" : "failed",
          );
          if (entitled !== true) {
            Alert.alert(
              "Purchase configuration issue",
              "Apple reports that Remove Ads is already owned, but the entitlement could not be confirmed. Please use Restore Purchases. If that does not work, contact support.",
            );
          }
        } else if (isRemoveAdsPurchaseCancelled(error)) {
          completeRemoveAdsAction("purchase", "cancelled");
        } else if (isRemoveAdsPurchasePending(error)) {
          completeRemoveAdsAction("purchase", "pending");
          Alert.alert(
            "Purchase pending",
            "Your purchase is being processed. You will be notified when it completes.",
          );
        } else {
          console.warn("Remove Ads purchase failed", error);
          completeRemoveAdsAction("purchase", "failed");
          Alert.alert(
            "Purchase unavailable",
            "Remove Ads could not be purchased right now. Please check your connection and try again.",
          );
        }
      } finally {
        setRemoveAdsOperationState("idle");
      }
    },
    [
      completeRemoveAdsAction,
      reconcileRemoveAdsEntitlement,
      setRemoveAdsOperationState,
    ],
  );

  useEffect(() => {
    let active = true;
    let connectionTask: Promise<void> | null = null;
    const listeners = {
      onPurchaseUpdated: (
        purchase: Parameters<typeof isRemoveAdsPurchaseEvent>[0],
      ) => {
        if (active) {
          const action = removeAdsActionRef.current;
          const purchaseAction = action?.kind === "purchase" ? action : null;
          void deliverRemoveAdsPurchase(purchase, purchaseAction).catch(
            (error) => {
              console.warn("StoreKit purchase update failed", error);
            },
          );
        }
      },
      onPurchaseError: (error: unknown) => {
        const action = removeAdsActionRef.current;
        if (active && action?.kind === "purchase") {
          void settleRemoveAdsPurchaseError(error, action);
        }
      },
    };
    const connectWithRetry = async () => {
      for (const delay of STOREKIT_CONNECTION_RETRY_DELAYS_MS) {
        if (!active || removeAdsStoreRef.current) return;
        if (delay > 0) await waitFor(delay);
        if (!active || removeAdsStoreRef.current) return;
        try {
          const connection = await connectRemoveAdsStore(listeners);
          if (!active) {
            connection.close();
            return;
          }
          removeAdsStoreRef.current = connection;
          setRemoveAdsStoreReady(true);
          await Promise.all([
            reconcileRemoveAdsEntitlement(),
            refreshRemoveAdsProduct(),
          ]);
          return;
        } catch (error) {
          console.warn("StoreKit Remove Ads setup is unavailable", error);
          if (active) {
            setRemoveAdsStoreReady(false);
            applyRemoveAdsEntitlementState("unknown");
            setRemoveAdsProduct(null);
            setRemoveAdsProductState("unavailable");
          }
        }
      }
    };
    const ensureStoreConnection = () => {
      if (removeAdsStoreRef.current) {
        return Promise.all([
          reconcileRemoveAdsEntitlement(),
          refreshRemoveAdsProduct(),
        ]).then(() => undefined);
      }
      if (!connectionTask) {
        connectionTask = connectWithRetry().finally(() => {
          connectionTask = null;
        });
      }
      return connectionTask;
    };
    const appStateSubscription = AppState.addEventListener(
      "change",
      (state) => {
        if (active && state === "active") void ensureStoreConnection();
      },
    );
    void ensureStoreConnection();
    return () => {
      active = false;
      appStateSubscription.remove();
      removeAdsStoreRef.current?.close();
      removeAdsStoreRef.current = null;
    };
  }, [
    applyRemoveAdsEntitlementState,
    completeRemoveAdsAction,
    deliverRemoveAdsPurchase,
    reconcileRemoveAdsEntitlement,
    refreshRemoveAdsProduct,
    settleRemoveAdsPurchaseError,
    setRemoveAdsOperationState,
  ]);

  const resolveTrackingAuthorization = useCallback(async () => {
    if (!trackingAuthorizationRef.current) {
      trackingAuthorizationRef.current = (async () => {
        const current = await getTrackingPermissionsAsync();
        if (current.status !== "undetermined") return true;
        const result = await requestTrackingPermissionsAsync();
        return result.status !== "undetermined";
      })().catch((error) => {
        trackingAuthorizationRef.current = null;
        throw error;
      });
    }
    const resolution = trackingAuthorizationRef.current;
    const resolved = await resolution;
    if (!resolved && trackingAuthorizationRef.current === resolution) {
      trackingAuthorizationRef.current = null;
    }
    return resolved;
  }, []);

  const ensureAdsInitialized = useCallback(async () => {
    if (removeAdsEntitlementRef.current !== "not-entitled") return false;
    if (!adProfileConfigured) return false;
    if (!(await resolveTrackingAuthorization())) return false;
    if (removeAdsEntitlementRef.current !== "not-entitled") return false;
    if (!adsInitializationRef.current) {
      adsInitializationRef.current = (async () => {
        await mobileAds().setRequestConfiguration({
          maxAdContentRating: MaxAdContentRating.PG,
        });
        if (removeAdsEntitlementRef.current !== "not-entitled") return false;
        await mobileAds().initialize();
        return true;
      })().catch((error) => {
        adsInitializationRef.current = null;
        throw error;
      });
    }
    const initialization = adsInitializationRef.current;
    const initialized = await initialization;
    if (!initialized && adsInitializationRef.current === initialization) {
      adsInitializationRef.current = null;
    }
    return (
      initialized &&
      removeAdsEntitlementRef.current === "not-entitled"
    );
  }, [adProfileConfigured, resolveTrackingAuthorization]);

  const startAdsIfAllowed = useCallback(
    async () => {
      if (removeAdsEntitlementRef.current !== "not-entitled") return false;
      // Google's demo app ID cannot be linked to this publisher's UMP
      // messages. Internal builds use only Google's fixed demo banner, so
      // initialize that test inventory directly. Production builds continue
      // to fail closed behind the publisher-owned UMP consent state.
      if (testAds) {
        setPrivacyChoicesRequired(false);
        return ensureAdsInitialized();
      }
      if (!productionAdsConfigured) return false;
      let currentInfo;
      try {
        currentInfo = await AdsConsent.getConsentInfo();
        setPrivacyChoicesRequired(
          currentInfo.privacyOptionsRequirementStatus ===
            AdsConsentPrivacyOptionsRequirementStatus.REQUIRED,
        );
      } catch {
        return false;
      }
      if (
        !currentInfo.canRequestAds ||
        removeAdsEntitlementRef.current !== "not-entitled"
      ) {
        return false;
      }
      return ensureAdsInitialized();
    },
    [ensureAdsInitialized, productionAdsConfigured, testAds],
  );

  const canAttemptBanner = useCallback(() => {
    return (
      appStateRef.current === "active" &&
      removeAdsEntitlementRef.current === "not-entitled" &&
      legalReady &&
      consentState === "permitted" &&
      adEligible &&
      webAdState !== "AD_TEMPORARILY_HIDDEN" &&
      Boolean(bannerUnitId)
    );
  }, [adEligible, bannerUnitId, consentState, legalReady, webAdState]);

  const triggerBannerReload = useCallback(
    (reason: string, resetBackoff = false) => {
      if (!canAttemptBanner() || adLoadInFlightRef.current) return false;
      if (resetBackoff) setAdLoadAttempt(0);
      adLoadInFlightRef.current = true;
      const diagnostics = adDiagnosticsRef.current;
      diagnostics.attempts += 1;
      diagnostics.lastAttemptAt = Date.now();
      if (testAds) {
        console.info("[AdMob QA] banner load", { reason, ...diagnostics });
      }
      setBannerInstance((instance) => instance + 1);
      setNativeAdState("loading");
      return true;
    },
    [canAttemptBanner, testAds],
  );

  useEffect(() => {
    if (
      removeAdsEntitlement !== "not-entitled" ||
      !legalReady ||
      consentState !== "unresolved"
    ) {
      return;
    }
    let active = true;
    void (async () => {
      if (!adProfileConfigured) {
        setConsentState("blocked");
        return;
      }
      if (testAds) {
        try {
          const started = await startAdsIfAllowed();
          if (active) setConsentState(started ? "permitted" : "blocked");
        } catch {
          if (active) setConsentState("blocked");
        }
        return;
      }
      try {
        const consent = await AdsConsent.gatherConsent();
        if (active) {
          setPrivacyChoicesRequired(
            consent.privacyOptionsRequirementStatus ===
              AdsConsentPrivacyOptionsRequirementStatus.REQUIRED,
          );
        }
      } catch {}
      if (!active) return;
      try {
        const started = await startAdsIfAllowed();
        if (active) {
          setConsentState(
            started || removeAdsEntitlementRef.current !== "not-entitled"
              ? "permitted"
              : "blocked",
          );
        }
      } catch {
        if (active) {
          setConsentState(
            removeAdsEntitlementRef.current === "not-entitled"
              ? "blocked"
              : "permitted",
          );
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [
    consentState,
    adProfileConfigured,
    legalReady,
    productionAds,
    testAds,
    removeAdsEntitlement,
    startAdsIfAllowed,
  ]);

  useEffect(() => {
    if (
      removeAdsEntitlement !== "not-entitled" ||
      !legalReady ||
      consentState !== "permitted"
    ) {
      return;
    }
    let active = true;
    void startAdsIfAllowed()
      .then((started) => {
        if (
          active &&
          !started &&
          removeAdsEntitlementRef.current === "not-entitled"
        ) {
          setConsentState("blocked");
        }
      })
      .catch(() => {
        if (
          active &&
          removeAdsEntitlementRef.current === "not-entitled"
        ) {
          setConsentState("blocked");
        }
      });
    return () => {
      active = false;
    };
  }, [
    consentState,
    legalReady,
    removeAdsEntitlement,
    startAdsIfAllowed,
  ]);

  useEffect(() => {
    if (!canAttemptBanner()) {
      adLoadInFlightRef.current = false;
      if (
        removeAdsEntitlement !== "not-entitled" ||
        !adEligible ||
        consentState !== "permitted"
      ) {
        setNativeAdState("idle");
        setAdLoadAttempt(0);
      }
      return;
    }
    if (nativeAdState === "idle") {
      triggerBannerReload("eligibility", true);
    }
  }, [
    adEligible,
    canAttemptBanner,
    consentState,
    nativeAdState,
    removeAdsEntitlement,
    triggerBannerReload,
  ]);

  useEffect(() => {
    if (nativeAdState !== "failed" || !canAttemptBanner()) return;

    let cancelled = false;
    const knownOffline = adNetworkReachableRef.current === false;
    const delay = knownOffline
      ? OFFLINE_REACHABILITY_POLL_MS
      : withRetryJitter(nextAdRetryDelay(adLoadAttempt));

    const retryTimer = setTimeout(() => {
      void (async () => {
        if (cancelled || !canAttemptBanner()) return;
        const reachable = await probeAdNetworkReachability();
        if (cancelled || !canAttemptBanner()) return;

        if (!reachable) {
          adNetworkReachableRef.current = false;
          adDiagnosticsRef.current.reachabilityFailures += 1;
          // Re-arm this effect without asking AdMob for inventory while the
          // network is demonstrably unavailable. Offline polling stays at 30s.
          setAdLoadAttempt((attempt) => Math.min(attempt + 1, 1_000));
          return;
        }

        const recoveredFromOffline = adNetworkReachableRef.current === false;
        adNetworkReachableRef.current = true;
        if (recoveredFromOffline) {
          // Debounce flapping Wi-Fi/cellular transitions before remounting.
          await waitFor(NETWORK_RECOVERY_DEBOUNCE_MS);
          if (cancelled || !canAttemptBanner()) return;
        }
        setAdLoadAttempt((attempt) => Math.min(attempt + 1, 1_000));
        triggerBannerReload(
          recoveredFromOffline ? "network-recovered" : "backoff-retry",
        );
      })();
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [
    adLoadAttempt,
    canAttemptBanner,
    nativeAdState,
    triggerBannerReload,
  ]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;
      if (nextState !== "active") {
        // iOS may suspend an in-flight request. The foreground path is allowed
        // to remount it exactly once when the user returns.
        adLoadInFlightRef.current = false;
        return;
      }
      if (previousState === "active" || !canAttemptBanner()) return;
      if (nativeAdState === "loaded") return;

      adDiagnosticsRef.current.foregroundRecoveries += 1;
      adNetworkReachableRef.current = null;
      adLoadInFlightRef.current = false;
      triggerBannerReload("foreground", true);
    });
    return () => subscription.remove();
  }, [canAttemptBanner, nativeAdState, triggerBannerReload]);

  useEffect(() => {
    const previous = previousWebAdStateRef.current;
    previousWebAdStateRef.current = webAdState;
    if (
      previous === "AD_TEMPORARILY_HIDDEN" &&
      webAdState !== "AD_TEMPORARILY_HIDDEN" &&
      adEligible &&
      consentState === "permitted" &&
      removeAdsEntitlement === "not-entitled"
    ) {
      adLoadInFlightRef.current = false;
      adNetworkReachableRef.current = null;
      triggerBannerReload("web-banner-visible", true);
    }
  }, [
    adEligible,
    consentState,
    removeAdsEntitlement,
    triggerBannerReload,
    webAdState,
  ]);

  const syncAdRuntime = useCallback(() => {
    if (!webReady) return;
    const consent =
      consentState === "permitted"
        ? "REQUEST_PERMITTED"
        : consentState === "blocked"
          ? "REQUEST_BLOCKED"
          : "UNRESOLVED";
    const state =
      removeAdsEntitlement !== "not-entitled" ||
      consentState === "blocked" ||
      !adEligible
        ? "AD_DISABLED"
        : nativeAdState === "loaded"
          ? "AD_LOADED"
          : nativeAdState === "failed"
            ? "AD_UNAVAILABLE"
            : "AD_LOADING";
    const height =
      removeAdsEntitlement === "not-entitled" &&
      nativeAdState === "loaded"
        ? AD_SLOT_HEIGHT
        : 0;
    webViewRef.current?.injectJavaScript(`
      (function () {
        const runtime = window.GBTAdRuntime;
        if (!runtime) return;
        runtime.setMode("REAL");
        runtime.setConsentStatus(${JSON.stringify(consent)});
        runtime.setRuntimeBannerHeight(${height});
        runtime.setState(${JSON.stringify(state)});
      })();
      true;
    `);
  }, [
    adEligible,
    consentState,
    nativeAdState,
    removeAdsEntitlement,
    webReady,
  ]);

  useEffect(() => {
    syncAdRuntime();
  }, [syncAdRuntime]);

  const syncRemoveAdsRuntime = useCallback(() => {
    if (!webReady) return;
    const status =
      removeAdsEntitlement === "entitled"
        ? "active"
        : removeAdsOperation === "purchasing"
          ? "purchasing"
          : removeAdsOperation === "restoring"
            ? "restoring"
            : removeAdsEntitlement === "checking"
              ? "checking"
              : removeAdsProductState === "ready"
                ? "ready"
                : "unavailable";
    webViewRef.current?.injectJavaScript(`
      window.GBTPurchaseRuntime?.setState({
        status: ${JSON.stringify(status)},
        adsRemoved: ${removeAdsEntitlement === "entitled"},
        displayPrice: ${JSON.stringify(removeAdsProduct?.displayPrice || "")},
        canPurchase: ${
          removeAdsStoreReady &&
          removeAdsProductState === "ready" &&
          removeAdsEntitlement === "not-entitled" &&
          removeAdsOperation === "idle"
        },
        canRestore: ${
          removeAdsStoreReady && removeAdsOperation === "idle"
        }
      });
      true;
    `);
  }, [
    removeAdsEntitlement,
    removeAdsOperation,
    removeAdsProduct?.displayPrice,
    removeAdsProductState,
    removeAdsStoreReady,
    webReady,
  ]);

  useEffect(() => {
    syncRemoveAdsRuntime();
  }, [syncRemoveAdsRuntime]);

  const syncAdvertisingPrivacyOptions = useCallback(() => {
    if (!webReady) return;
    webViewRef.current?.injectJavaScript(`
      window.GBTAdvertisingPrivacyOptions?.setRequired(${privacyChoicesRequired});
      true;
    `);
  }, [privacyChoicesRequired, webReady]);

  useEffect(() => {
    syncAdvertisingPrivacyOptions();
  }, [syncAdvertisingPrivacyOptions]);

  const completeNativeFileShare = useCallback(
    (
      requestId: string | undefined,
      ok: boolean,
      code: string,
      message = "",
    ) => {
      if (!requestId) return;
      webViewRef.current?.injectJavaScript(`
        window.GBTNativeShareCompleted?.(
          ${JSON.stringify(requestId)},
          ${ok ? "true" : "false"},
          ${JSON.stringify(code)},
          ${JSON.stringify(message)}
        );
        true;
      `);
    },
    [],
  );

  const shareFile = useCallback(async (message: BridgeMessage) => {
    if (message.type !== "share-file") return;
    if (!message.dataUrl) {
      completeNativeFileShare(
        message.requestId,
        false,
        "SHARE_MISSING_PAYLOAD",
        "Export file is missing",
      );
      return;
    }
    const name = sanitizedFileName(message.name);
    const shareDirectory = new Directory(
      Paths.cache,
      "gbt-share",
      sanitizedFileName(
        `${message.requestId || "share"}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ),
    );
    const file = new File(shareDirectory, name);
    try {
      const { payload: base64, byteLength } = parseDataUrl(message.dataUrl);
      shareDirectory.create({ idempotent: true, intermediates: true });
      file.create({ overwrite: true, intermediates: true });
      file.write(base64, { encoding: "base64" });
      if (!file.exists || Number(file.size) !== byteLength) {
        throw new NativeBridgeError(
          "SHARE_WRITE_FAILED",
          "Export file could not be prepared",
        );
      }
      if (!(await Sharing.isAvailableAsync())) {
        throw new NativeBridgeError(
          "SHARE_UNAVAILABLE",
          "System sharing is unavailable",
        );
      }
      await Sharing.shareAsync(file.uri, {
        dialogTitle: name,
        mimeType: message.mimeType || "application/octet-stream",
        UTI: fileUti(name, message.mimeType),
      });
      completeNativeFileShare(message.requestId, true, "SHARE_COMPLETED");
    } catch (error) {
      console.error("Native file export failed", error);
      const failure = nativeBridgeFailure(
        error,
        "SHARE_FAILED",
        "Export failed",
      );
      completeNativeFileShare(
        message.requestId,
        false,
        failure.code,
        failure.message,
      );
      Alert.alert(
        "Export unavailable",
        "The file could not be opened in the iPhone share sheet. Please try again.",
      );
    } finally {
      setTimeout(() => {
        try {
          shareDirectory.delete();
        } catch {}
      }, 15000);
    }
  }, [completeNativeFileShare]);

  const completeNativeNotificationReconcile = useCallback(
    (
      requestId: string | undefined,
      ok: boolean,
      code: string,
      scheduledCount: number,
      message = "",
    ) => {
      if (!requestId) return;
      webViewRef.current?.injectJavaScript(`
        window.GBTNativeNotificationReconciled?.(
          ${JSON.stringify(requestId)},
          ${ok ? "true" : "false"},
          ${JSON.stringify(code)},
          ${Math.max(0, Math.trunc(scheduledCount))},
          ${JSON.stringify(message)}
        );
        true;
      `);
    },
    [],
  );

  const completeNativeAppDataClear = useCallback(
    (
      requestId: string | undefined,
      ok: boolean,
      code: string,
      message = "",
    ) => {
      if (!requestId) return;
      webViewRef.current?.injectJavaScript(`
        window.GBTNativeClearAppDataCompleted?.(
          ${JSON.stringify(requestId)},
          ${ok ? "true" : "false"},
          ${JSON.stringify(code)},
          ${JSON.stringify(message)}
        );
        true;
      `);
    },
    [],
  );

  const clearNativeAppData = useCallback(
    async (message: BridgeMessage) => {
      if (message.type !== "clear-app-data") return;
      try {
        await cancelOwnedScheduledReminders();
        purgeShareCacheRoot();
        completeNativeAppDataClear(
          message.requestId,
          true,
          "APP_DATA_CLEARED",
        );
      } catch (error) {
        console.error("Native app-data cleanup failed", error);
        const failure = nativeBridgeFailure(
          error,
          "APP_DATA_CLEAR_FAILED",
          "Native app data could not be cleared",
        );
        completeNativeAppDataClear(
          message.requestId,
          false,
          failure.code,
          failure.message,
        );
      }
    },
    [completeNativeAppDataClear],
  );

  const reconcileNotifications = useCallback(
    async (message: BridgeMessage) => {
      if (message.type !== "notifications-reconcile") return;

      try {
        if (typeof message.optedIn !== "boolean") {
          throw new NativeBridgeError(
            "NOTIFICATIONS_INVALID_REQUEST",
            "Reminder opt-in state is missing",
          );
        }
        if (!message.optedIn) {
          await cancelOwnedScheduledReminders();
          completeNativeNotificationReconcile(
            message.requestId,
            true,
            "NOTIFICATIONS_DISABLED",
            0,
          );
          return;
        }

        const reminders = normalizeReminderSpecs(message.reminders);
        if (!reminders.length) {
          await cancelOwnedScheduledReminders();
          completeNativeNotificationReconcile(
            message.requestId,
            true,
            "NOTIFICATIONS_CLEARED",
            0,
          );
          return;
        }

        let permission = await Notifications.getPermissionsAsync();
        if (
          !notificationsAllowed(permission) &&
          message.requestPermission === true &&
          permission.canAskAgain
        ) {
          permission = await Notifications.requestPermissionsAsync({
            ios: {
              allowAlert: true,
              allowBadge: false,
              allowSound: false,
            },
          });
        }
        if (!notificationsAllowed(permission)) {
          throw new NativeBridgeError(
            permission.canAskAgain && message.requestPermission !== true
              ? "NOTIFICATIONS_PERMISSION_REQUIRED"
              : "NOTIFICATIONS_PERMISSION_DENIED",
            permission.canAskAgain && message.requestPermission !== true
              ? "Notification permission requires a direct opt-in action"
              : "Notification permission was not granted",
          );
        }

        const desiredIdentifiers = new Set(
          reminders.map((reminder) => notificationIdentifier(reminder.id)),
        );
        for (const reminder of reminders) {
          const copy = notificationCopy(reminder.kind, reminder.locale);
          await Notifications.scheduleNotificationAsync({
            identifier: notificationIdentifier(reminder.id),
            content: {
              ...copy,
              sound: false,
              data: {
                owner: NOTIFICATION_OWNER,
                reminderId: reminder.id,
                reminderKind: reminder.kind,
                fireAt: reminder.fireAt,
                schemaVersion: 1,
              },
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: new Date(reminder.fireAt),
            },
          });
        }
        await cancelOwnedScheduledReminders(desiredIdentifiers);
        completeNativeNotificationReconcile(
          message.requestId,
          true,
          "NOTIFICATIONS_RECONCILED",
          reminders.length,
        );
      } catch (error) {
        console.error("Native reminder reconciliation failed", error);
        const failure = nativeBridgeFailure(
          error,
          "NOTIFICATIONS_FAILED",
          "Reminders could not be scheduled",
        );
        completeNativeNotificationReconcile(
          message.requestId,
          false,
          failure.code,
          0,
          failure.message,
        );
      }
    },
    [completeNativeNotificationReconcile],
  );

  const shareText = useCallback(async (message: BridgeMessage) => {
    if (message.type !== "share-text") return;
    const remoteUrl =
      typeof message.url === "string" &&
      /^https:\/\//i.test(message.url) &&
      !message.url.startsWith(LOCAL_APP_ORIGIN)
        ? message.url
        : undefined;
    const text = [message.text, remoteUrl].filter(Boolean).join("\n");
    if (!text) return;
    try {
      await Share.share({
        title: message.title || undefined,
        message: text,
        url: remoteUrl,
      });
    } catch {}
  }, []);

  const showPrivacyChoices = useCallback(async () => {
    if (!productionAdsConfigured) {
      setPrivacyChoicesRequired(false);
      return;
    }
    try {
      await AdsConsent.showPrivacyOptionsForm();
      const info = await AdsConsent.getConsentInfo();
      setPrivacyChoicesRequired(
        info.privacyOptionsRequirementStatus ===
          AdsConsentPrivacyOptionsRequirementStatus.REQUIRED,
      );
      if (!info.canRequestAds) {
        setConsentState("blocked");
        return;
      }
      if (removeAdsEntitlementRef.current !== "not-entitled") {
        setConsentState("permitted");
        return;
      }
      try {
        const started = await startAdsIfAllowed();
        setConsentState(
          started || removeAdsEntitlementRef.current !== "not-entitled"
            ? "permitted"
            : "blocked",
        );
      } catch {
        if (removeAdsEntitlementRef.current === "not-entitled") {
          setConsentState("blocked");
          Alert.alert(
            "Advertising unavailable",
            "Advertising could not be initialized. Please try again later.",
          );
        } else {
          setConsentState("permitted");
        }
      }
    } catch {
      setConsentState("blocked");
      Alert.alert(
        "Advertising privacy choices",
        "No additional advertising privacy form is required on this device right now.",
      );
    }
  }, [productionAdsConfigured, startAdsIfAllowed]);

  const beginRemoveAdsPurchase = useCallback(async () => {
    if (removeAdsEntitlementRef.current === "entitled") {
      completeRemoveAdsAction("purchase", "already-active");
      return;
    }
    if (removeAdsEntitlementRef.current !== "not-entitled") {
      completeRemoveAdsAction("purchase", "failed");
      Alert.alert(
        "Purchase unavailable",
        "Apple is still checking your Remove Ads status. Please try again in a moment.",
      );
      return;
    }
    if (removeAdsOperationRef.current !== "idle") return;
    if (!removeAdsStoreRef.current) {
      completeRemoveAdsAction("purchase", "failed");
      Alert.alert(
        "App Store unavailable",
        "The App Store connection is not ready. Please check your connection and try again.",
      );
      return;
    }
    // Reserve the operation synchronously before any product lookup can yield.
    // This prevents rapid Purchase/Restore messages from starting overlapping
    // StoreKit operations while the product catalog is refreshing.
    const action: RemoveAdsActionContext = {
      kind: "purchase",
      token: ++removeAdsActionSequenceRef.current,
    };
    removeAdsActionRef.current = action;
    setRemoveAdsOperationState("purchasing");
    const product =
      removeAdsProductState === "ready" && removeAdsProduct
        ? removeAdsProduct
        : await refreshRemoveAdsProduct();
    // A replayed verified transaction can complete this action while the
    // product lookup is outstanding. Never issue a second StoreKit request
    // after another callback has consumed the operation token.
    if (removeAdsActionRef.current !== action) return;
    if (!product) {
      removeAdsActionRef.current = null;
      setRemoveAdsOperationState("idle");
      completeRemoveAdsAction("purchase", "failed");
      Alert.alert(
        "Purchase unavailable",
        "Remove Ads is not available from the App Store right now. Please try again later.",
      );
      return;
    }
    try {
      await requestRemoveAdsPurchase();
    } catch (error) {
      await settleRemoveAdsPurchaseError(error, action);
    }
  }, [
    completeRemoveAdsAction,
    reconcileRemoveAdsEntitlement,
    refreshRemoveAdsProduct,
    removeAdsProduct,
    removeAdsProductState,
    settleRemoveAdsPurchaseError,
    setRemoveAdsOperationState,
  ]);

  const beginRemoveAdsRestore = useCallback(async () => {
    if (removeAdsOperationRef.current !== "idle") return;
    if (removeAdsEntitlementRef.current === "entitled") {
      completeRemoveAdsAction("restore", "already-active");
      return;
    }
    if (!removeAdsStoreRef.current) {
      completeRemoveAdsAction("restore", "failed");
      Alert.alert(
        "Restore unavailable",
        "The App Store connection is not ready. Please check your connection and try again.",
      );
      return;
    }
    const action: RemoveAdsActionContext = {
      kind: "restore",
      token: ++removeAdsActionSequenceRef.current,
    };
    removeAdsActionRef.current = action;
    setRemoveAdsOperationState("restoring");
    try {
      await restoreRemoveAdsPurchase();
      const entitled = await reconcileRemoveAdsEntitlement();
      completeRemoveAdsAction(
        "restore",
        entitled === true ? "success" : entitled === false ? "none" : "failed",
      );
    } catch (error) {
      console.warn("Remove Ads restore failed", error);
      completeRemoveAdsAction("restore", "failed");
      Alert.alert(
        "Restore unavailable",
        "Purchases could not be restored right now. Please check your connection and try again.",
      );
    } finally {
      if (removeAdsActionRef.current === action) {
        removeAdsActionRef.current = null;
        setRemoveAdsOperationState("idle");
      }
    }
  }, [
    completeRemoveAdsAction,
    reconcileRemoveAdsEntitlement,
    setRemoveAdsOperationState,
  ]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: BridgeMessage;
      try {
        message = JSON.parse(event.nativeEvent.data) as BridgeMessage;
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || !("type" in message)) {
        return;
      }
      switch (message.type) {
        case "bridge-ready":
          setWebReady(true);
          break;
        case "legal-ready":
          setLegalReady(Boolean(message.ready));
          break;
        case "ad-eligibility":
          setAdEligible(Boolean(message.eligible));
          break;
        case "ad-presentation":
          setWebAdState(message.state);
          break;
        case "privacy-choices":
          if (legalReady && privacyChoicesRequired) void showPrivacyChoices();
          break;
        case "purchase-remove-ads":
          if (legalReady) void beginRemoveAdsPurchase();
          break;
        case "restore-remove-ads":
          if (legalReady) void beginRemoveAdsRestore();
          break;
        case "share-file":
          void shareFile(message);
          break;
        case "share-text":
          void shareText(message);
          break;
        case "notifications-reconcile":
          void reconcileNotifications(message);
          break;
        case "clear-app-data":
          void clearNativeAppData(message);
          break;
      }
    },
    [beginRemoveAdsPurchase, beginRemoveAdsRestore, clearNativeAppData, legalReady, privacyChoicesRequired, reconcileNotifications, shareFile, shareText, showPrivacyChoices],
  );

  const openExternalUrl = useCallback((url: string) => {
    if (!/^https:\/\//i.test(url)) return;
    void Linking.openURL(url).catch(() => {
      Alert.alert("Link unavailable", "This secure web page could not be opened.");
    });
  }, []);

  const shouldStartNavigation = useCallback(
    (request: ShouldStartLoadRequest) => {
      const url = request.url || "";
      if (
        url === "about:blank" ||
        url.startsWith(LOCAL_APP_ORIGIN)
      ) {
        return true;
      }
      if (/^https:\/\//i.test(url)) openExternalUrl(url);
      return false;
    },
    [openExternalUrl],
  );

  const source = useMemo(
    () => ({ html: APP_HTML, baseUrl: LOCAL_APP_ORIGIN }),
    [],
  );
  const showBanner =
    adProfileConfigured &&
    removeAdsEntitlement === "not-entitled" &&
    legalReady &&
    consentState === "permitted" &&
    adEligible &&
    nativeAdState !== "failed";
  const bannerMounted =
    showBanner && webAdState !== "AD_TEMPORARILY_HIDDEN";
  const bannerVisible =
    bannerMounted &&
    nativeAdState === "loaded" &&
    webAdState === "AD_LOADED";

  return (
    <SafeAreaProvider style={styles.root}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}>
        <NativeWebView
          ref={webViewRef}
          source={source}
          originWhitelist={["https://*", "about:*"]}
          injectedJavaScript={NATIVE_BRIDGE_SCRIPT}
          javaScriptEnabled
          cacheEnabled
          incognito={false}
          sharedCookiesEnabled={false}
          allowsLinkPreview={false}
          pullToRefreshEnabled={false}
          automaticallyAdjustContentInsets={false}
          mediaPlaybackRequiresUserAction
          onMessage={onMessage}
          onLoadStart={() => setWebReady(false)}
          onLoadEnd={() => setWebReady(true)}
          onShouldStartLoadWithRequest={shouldStartNavigation}
          onOpenWindow={(event: WebViewOpenWindowEvent) =>
            openExternalUrl(event.nativeEvent.targetUrl || "")
          }
          onContentProcessDidTerminate={() => webViewRef.current?.reload()}
          style={styles.webView}
        />
        {bannerMounted ? (
          <View
            pointerEvents={bannerVisible ? "auto" : "none"}
            style={[
              styles.bannerOverlay,
              !bannerVisible && styles.bannerHidden,
            ]}
          >
            <BannerAd
              key={`banner-${bannerInstance}`}
              unitId={bannerUnitId}
              size={BannerAdSize.BANNER}
              requestOptions={{ requestNonPersonalizedAdsOnly: true }}
              onAdLoaded={() => {
                adLoadInFlightRef.current = false;
                adNetworkReachableRef.current = true;
                const diagnostics = adDiagnosticsRef.current;
                diagnostics.loads += 1;
                diagnostics.lastLoadedAt = Date.now();
                setAdLoadAttempt(0);
                setNativeAdState("loaded");
                if (testAds) {
                  console.info("[AdMob QA] banner loaded", { ...diagnostics });
                }
              }}
              onAdFailedToLoad={(error) => {
                adLoadInFlightRef.current = false;
                const diagnostics = adDiagnosticsRef.current;
                diagnostics.failures += 1;
                diagnostics.lastFailureAt = Date.now();
                if (testAds) {
                  console.warn("[AdMob QA] banner failed", error, {
                    ...diagnostics,
                  });
                }
                setNativeAdState("failed");
              }}
            />
          </View>
        ) : null}
        {testAds ? (
          <View accessibilityElementsHidden style={styles.testMarker} />
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#f2f2f7",
  },
  safeArea: {
    flex: 1,
    backgroundColor: "#f2f2f7",
  },
  webView: {
    flex: 1,
    backgroundColor: "#f2f2f7",
  },
  bannerOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: AD_SLOT_BOTTOM,
    height: AD_SLOT_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  bannerHidden: {
    opacity: 0,
  },
  testMarker: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
  },
});
