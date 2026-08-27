import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const nativeSource = readFileSync(resolve(root, "App.tsx"), "utf8");
const webSource = readFileSync(resolve(root, "app.html"), "utf8");
const purchaseSource = readFileSync(
  resolve(root, "src/removeAdsPurchase.ts"),
  "utf8",
);
const iosNoticeSource = readFileSync(
  resolve(root, "scripts/finalize-ios-notices.mjs"),
  "utf8",
);

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

function sourceSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

test("keeps one non-personalized banner behind StoreKit, legal, UMP, and ATT gates", () => {
  for (const obsolete of [
    "publisherAdsAllowed",
    "publisher-ad-choice",
    "onAdvertisingAllowed",
    "advertisingPermissionSetting",
    "savePublisherAdvertisingChoice",
    "confirmPublisherAdvertisingChoice",
    "AD_DISCLOSURE_VERSION",
    "ADS_REMOVED",
    "ads-removed",
  ]) {
    expect(nativeSource).not.toContain(obsolete);
    expect(webSource).not.toContain(obsolete);
  }

  expect(occurrences(nativeSource, "AdsConsent.gatherConsent()")).toBe(1);
  expect(occurrences(nativeSource, "mobileAds().initialize()")).toBe(1);
  expect(occurrences(nativeSource, "getTrackingPermissionsAsync()")).toBe(1);
  expect(occurrences(nativeSource, "requestTrackingPermissionsAsync()")).toBe(1);
  expect(occurrences(nativeSource, "<BannerAd")).toBe(1);
  expect(occurrences(nativeSource, "requestNonPersonalizedAdsOnly: true")).toBe(1);
  expect(nativeSource).toContain('const testAds = adProfile === "test";');
  expect(nativeSource).toContain(
    'const productionAds = adProfile === "production";',
  );
  expect(nativeSource).toContain(
    "const adProfileConfigured = testAds || productionAdsConfigured;",
  );
  expect(nativeSource).toContain(
    "productionAds &&\n    hasMatchingProductionAdMobIdentifiers(",
  );
  expect(nativeSource).toContain(
    "process.env.EXPO_PUBLIC_IOS_ADMOB_APP_ID?.trim()",
  );
  expect(nativeSource).toContain(
    "process.env.EXPO_PUBLIC_IOS_ADMOB_BANNER_ID?.trim()",
  );
  expect(nativeSource).toContain(
    "process.env.EXPO_PUBLIC_ADMOB_PUBLISHER_ID?.trim()",
  );
  const productionIdentifierGate = sourceSection(
    nativeSource,
    "function hasMatchingProductionAdMobIdentifiers(",
    "\n\nNotifications.setNotificationHandler",
  );
  expect(productionIdentifierGate).toContain(
    "approvedPublisherId !== GOOGLE_DEMO_PUBLISHER_ID",
  );
  expect(productionIdentifierGate).toContain("/^\\d{16}$/.test(approvedPublisherId)");
  expect(productionIdentifierGate).toContain(
    "/^ca-app-pub-(\\d{16})~\\d{10}$/",
  );
  expect(productionIdentifierGate).toContain(
    "/^ca-app-pub-(\\d{16})\\/\\d{10}$/",
  );
  expect(productionIdentifierGate).toContain(
    "appMatch?.[1] === approvedPublisherId",
  );
  expect(productionIdentifierGate).toContain(
    "bannerMatch?.[1] === approvedPublisherId",
  );
  expect(nativeSource).toContain("if (!adProfileConfigured) return false;");
  expect(nativeSource).not.toContain(
    "productionAds ? productionBannerId : TestIds.BANNER",
  );
  expect(nativeSource).not.toContain(
    ": productionAds\n      ? productionBannerId",
  );
  expect(nativeSource).not.toContain(
    "if (!productionAds) return ensureAdsInitialized();",
  );
  expect(nativeSource).toMatch(
    /const bannerUnitId\s*=\s*testAds\s*\?\s*TestIds\.BANNER\s*:\s*productionAdsConfigured\s*\?\s*productionBannerId\s*:\s*"";/,
  );

  const sharedAdGate = sourceSection(
    nativeSource,
    "  const startAdsIfAllowed =",
    "  useEffect(() => {",
  );
  expect(sharedAdGate).toContain("if (testAds) {");
  expect(sharedAdGate).toContain("return ensureAdsInitialized();");
  expect(sharedAdGate).toContain("if (!productionAdsConfigured) return false;");
  expect(sharedAdGate.indexOf("AdsConsent.getConsentInfo()")).toBeGreaterThan(
    sharedAdGate.indexOf("if (!productionAdsConfigured) return false;"),
  );
  expect(sharedAdGate).toContain("} catch {\n        return false;\n      }");
  expect(sharedAdGate.indexOf("!currentInfo.canRequestAds")).toBeGreaterThan(
    sharedAdGate.indexOf("AdsConsent.getConsentInfo()"),
  );
  expect(sharedAdGate).not.toContain("reportedCanRequestAds");

  const trackingGate = sourceSection(
    nativeSource,
    "  const resolveTrackingAuthorization =",
    "  const ensureAdsInitialized =",
  );
  expect(trackingGate).toContain("getTrackingPermissionsAsync()");
  expect(trackingGate).toContain('current.status !== "undetermined"');
  expect(trackingGate).toContain("requestTrackingPermissionsAsync()");
  expect(trackingGate).toContain('result.status !== "undetermined"');

  const initializationGate = sourceSection(
    nativeSource,
    "  const ensureAdsInitialized =",
    "  const startAdsIfAllowed =",
  );
  expect(initializationGate.indexOf("await resolveTrackingAuthorization()")).toBeLessThan(
    initializationGate.indexOf("mobileAds().setRequestConfiguration"),
  );
  expect(initializationGate.indexOf("mobileAds().setRequestConfiguration")).toBeLessThan(
    initializationGate.indexOf("mobileAds().initialize()"),
  );

  const consentEffect = sourceSection(
    nativeSource,
    '  useEffect(() => {\n    if (\n      removeAdsEntitlement !== "not-entitled"',
    '  useEffect(() => {\n    if (!canAttemptBanner())',
  );
  expect(consentEffect).toContain("AdsConsent.gatherConsent()");
  expect(consentEffect).toContain("if (!adProfileConfigured)");
  expect(consentEffect).toContain("if (testAds)");
  const testConsentBranch = sourceSection(
    consentEffect,
    "      if (testAds) {",
    "      try {\n        const consent = await AdsConsent.gatherConsent();",
  );
  expect(testConsentBranch).toContain("startAdsIfAllowed()");
  expect(testConsentBranch).toContain("return;");
  expect(consentEffect).toContain("startAdsIfAllowed()");
  expect(consentEffect).not.toContain("reportedCanRequestAds");
  expect(consentEffect).toContain('removeAdsEntitlement !== "not-entitled"');
  expect(consentEffect).not.toContain("publisher");

  const bannerGate = sourceSection(
    nativeSource,
    "  const showBanner =",
    "  const bannerMounted =",
  );
  expect(bannerGate).toContain("adProfileConfigured &&");
  expect(bannerGate).toContain("legalReady &&");
  expect(bannerGate).toContain('consentState === "permitted"');
  expect(bannerGate).toContain('removeAdsEntitlement === "not-entitled"');
  expect(bannerGate).not.toContain("publisher");

  const bannerStyle = sourceSection(
    nativeSource,
    "  bannerOverlay: {",
    "  bannerHidden: {",
  );
  expect(bannerStyle).toContain("left: 0");
  expect(bannerStyle).toContain("right: 0");
  expect(nativeSource).toContain("BannerAdSize.BANNER");
  expect(nativeSource).not.toMatch(/\b(?:InterstitialAd|RewardedAd|RewardedInterstitialAd|AppOpenAd|NativeAd)\b/);
  expect(nativeSource).toContain('from "expo-tracking-transparency"');

  expect(nativeSource).toContain("AdsConsentPrivacyOptionsRequirementStatus.REQUIRED");
  expect(nativeSource).toContain(
    "if (legalReady && privacyChoicesRequired) void showPrivacyChoices();",
  );
  const privacyChoicesGate = sourceSection(
    nativeSource,
    "  const showPrivacyChoices = useCallback(async () => {",
    "  const beginRemoveAdsPurchase = useCallback(async () => {",
  );
  expect(privacyChoicesGate).toContain("if (!productionAdsConfigured) {");
  expect(privacyChoicesGate).toContain(
    "[productionAdsConfigured, startAdsIfAllowed]",
  );
  expect(privacyChoicesGate).toContain(
    '} catch {\n      setConsentState("blocked");\n      Alert.alert(\n        "Advertising privacy choices"',
  );
  expect(nativeSource).toContain("{testAds ? (");
  expect(webSource).toContain("window.GBTAdvertisingPrivacyOptions=Object.freeze");
  expect(webSource).toContain(
    "advertisingPrivacyChoicesRequired?legalRow('privacy-choices'",
  );

  expect(webSource).toContain("delete out.settings.advertisingConsent;");
  expect(webSource).toContain("delete s.entryDrafts.onboarding.advertisingAllowed;");
  expect(occurrences(webSource, "advertisingConsent")).toBe(1);
  expect(occurrences(webSource, "advertisingAllowed")).toBe(2);
  expect(webSource).toContain("tr('onboarding.advertisingNotice')");
  expect(webSource).toContain("tr('legal.adSupportedBody')");
  expect(webSource).toContain("drawerOpen||!adPlacementAllowed()");
  expect(webSource).toContain("state.route!=='removeAds'");
  expect(webSource).toContain("Google AdMob may process your IP address/coarse location");
  expect(webSource).toContain("Google AdMob puede procesar tu dirección IP/ubicación aproximada");
  expect(webSource).not.toContain("You can decline and still use all core tracker features without ads");
  expect(webSource).not.toContain("Puedes rechazarlo y seguir usando todas las funciones principales sin anuncios");

  expect(nativeSource).toContain('type: "purchase-remove-ads"');
  expect(nativeSource).toContain('type: "restore-remove-ads"');
  expect(nativeSource).toContain("readVerifiedRemoveAdsEntitlement()");
  expect(nativeSource).toContain(
    "const STOREKIT_CONNECTION_RETRY_DELAYS_MS = [0, 1000, 3000] as const;",
  );
  expect(nativeSource).toContain(
    "const STOREKIT_ENTITLEMENT_RETRY_DELAYS_MS = [0, 500, 2000] as const;",
  );
  const entitlementReconciliation = sourceSection(
    nativeSource,
    "  const reconcileRemoveAdsEntitlement = useCallback(",
    "  const deliverRemoveAdsPurchase = useCallback(",
  );
  expect(entitlementReconciliation).toContain(
    "for (const delay of STOREKIT_ENTITLEMENT_RETRY_DELAYS_MS)",
  );
  expect(entitlementReconciliation).toContain(
    'removeAdsEntitledRef.current ? "entitled" : "unknown"',
  );
  const storeConnectionEffect = sourceSection(
    nativeSource,
    "  useEffect(() => {\n    let active = true;\n    let connectionTask",
    "  const ensureAdsInitialized = useCallback(",
  );
  expect(storeConnectionEffect).toContain(
    "for (const delay of STOREKIT_CONNECTION_RETRY_DELAYS_MS)",
  );
  expect(storeConnectionEffect).toContain("const ensureStoreConnection = () =>");
  expect(storeConnectionEffect).toContain("if (!connectionTask) {");
  expect(storeConnectionEffect).toContain("connectionTask = null;");
  expect(storeConnectionEffect).toContain("AppState.addEventListener(");
  expect(storeConnectionEffect).toContain(
    'if (active && state === "active") void ensureStoreConnection();',
  );
  expect(storeConnectionEffect).toContain("appStateSubscription.remove();");
  expect(storeConnectionEffect).toContain("removeAdsStoreRef.current?.close();");
  expect(storeConnectionEffect).toContain("removeAdsStoreRef.current = null;");
  expect(storeConnectionEffect.indexOf("AppState.addEventListener(")).toBeLessThan(
    storeConnectionEffect.lastIndexOf("void ensureStoreConnection();"),
  );
  expect(nativeSource).toContain(
    'removeAdsEntitlementRef.current !== "not-entitled"',
  );
  expect(nativeSource).toContain("finishVerifiedRemoveAdsPurchase(purchase)");
  expect(nativeSource).toContain("triggerBannerReload");
  expect(nativeSource).toContain("probeAdNetworkReachability");
  expect(nativeSource).toContain("OFFLINE_REACHABILITY_POLL_MS");
  expect(nativeSource).toContain("foregroundRecoveries");
  expect(nativeSource).toContain('reason, ...diagnostics');
  expect(nativeSource).toContain("removeAdsReconcileQueueRef.current.then(");
  expect(nativeSource).toContain("removeAdsDeliveryQueueRef.current.then(");
  expect(nativeSource).not.toContain("entitlementGenerationRef");
  expect(nativeSource).not.toContain("removeAdsDeliveryRef");
  expect(nativeSource).toContain("token: ++removeAdsActionSequenceRef.current");
  const purchaseActionGate = sourceSection(
    nativeSource,
    "  const beginRemoveAdsPurchase = useCallback(async () => {",
    "  const beginRemoveAdsRestore = useCallback(async () => {",
  );
  expect(
    purchaseActionGate.indexOf("removeAdsActionRef.current = action;"),
  ).toBeLessThan(
    purchaseActionGate.indexOf("await refreshRemoveAdsProduct()"),
  );
  expect(purchaseActionGate).toContain(
    "if (removeAdsActionRef.current !== action) return;",
  );
  expect(purchaseActionGate).toContain(
    'setRemoveAdsOperationState("purchasing");',
  );
  expect(nativeSource).toContain(
    "Consent gathering can fail when production starts offline.",
  );
  expect(nativeSource).toContain(
    'adStartupTransientFailureRef.current = true;\n        if (active) setConsentState("blocked");\n        return;',
  );
  expect(nativeSource).toContain('purchase.purchaseState !== "purchased"');
  expect(nativeSource).toContain("isRemoveAdsAlreadyOwned(error)");
  expect(nativeSource).toContain("onLoadStart={() => setWebReady(false)}");
  const adGateCalls = Array.from(
    nativeSource.matchAll(/startAdsIfAllowed\(([^)]*)\)/g),
    (match) => match[1].trim(),
  );
  expect(adGateCalls.length).toBeGreaterThanOrEqual(4);
  expect(adGateCalls.every((argument) => argument === "")).toBe(true);
  expect(purchaseSource).toContain(
    'export const REMOVE_ADS_PRODUCT_ID = "remove_ads_lifetime";',
  );
  expect(purchaseSource).toContain("currentEntitlementIOS(REMOVE_ADS_PRODUCT_ID)");
  expect(purchaseSource).toContain(
    "isTransactionVerifiedIOS(REMOVE_ADS_PRODUCT_ID)",
  );
  expect(purchaseSource).toContain("purchaseUpdatedListener(");
  expect(purchaseSource.indexOf("purchaseUpdatedListener(")).toBeLessThan(
    purchaseSource.indexOf("await initConnection()"),
  );
  expect(purchaseSource).toContain("if (!connected) throw new Error");
  expect(purchaseSource).toContain("restorePurchases()");
  expect(purchaseSource).toContain("product.displayPrice");
  expect(purchaseSource).toContain('candidate.platform === "ios"');
  expect(purchaseSource).toContain('candidate.typeIOS === "non-consumable"');
  expect(purchaseSource).toContain('purchase.store === "apple"');
  expect(purchaseSource).toContain(
    "await finishTransaction({ purchase, isConsumable: false });",
  );
  for (const literal of ["$4.99", "$9.99", "$12.99"]) {
    expect(nativeSource).not.toContain(literal);
    expect(webSource).not.toContain(literal);
    expect(purchaseSource).not.toContain(literal);
  }
});

test("keeps Clear All fail-closed across native cache, reminders, and web stores", () => {
  expect(nativeSource).toContain('| { type: "clear-app-data"; requestId?: string };');
  expect(nativeSource).toContain(
    'const shareCacheRoot = new Directory(Paths.cache, "gbt-share");',
  );
  expect(nativeSource).toContain("await cancelOwnedScheduledReminders();");
  expect(nativeSource).toContain("purgeShareCacheRoot();");
  expect(nativeSource).toContain("window.GBTNativeClearAppDataCompleted?.(");

  const nativeClear = sourceSection(
    nativeSource,
    "  const clearNativeAppData = useCallback(",
    "  const reconcileNotifications = useCallback(",
  );
  expect(nativeClear.indexOf("await cancelOwnedScheduledReminders();")).toBeLessThan(
    nativeClear.indexOf("purgeShareCacheRoot();"),
  );
  expect(nativeClear).toContain('"APP_DATA_CLEARED"');
  expect(nativeClear).toContain('"APP_DATA_CLEAR_FAILED"');

  const verifiedLegacyClear = sourceSection(
    webSource,
    "function clearLegacyAndRecoveryStorage()",
    "function resetTransientAppState()",
  );
  expect(verifiedLegacyClear).toContain("localStorage.removeItem(key)");
  expect(verifiedLegacyClear).toContain("localStorage.getItem(key)!==null");
  expect(verifiedLegacyClear).toContain("catch(_){return false;}");

  const webClear = sourceSection(
    webSource,
    "async function clearAllStoredData()",
    "async function resetMalformedLocalStorage()",
  );
  const nativeIndex = webClear.indexOf("clearOwnedNativeData()");
  const legacyIndex = webClear.indexOf("clearLegacyAndRecoveryStorage()");
  const durableIndex = webClear.indexOf("durableStore.clear(");
  expect(nativeIndex).toBeGreaterThanOrEqual(0);
  expect(nativeIndex).toBeLessThan(legacyIndex);
  expect(legacyIndex).toBeLessThan(durableIndex);
  expect(occurrences(webClear, "await reconcileNativeReminders()")).toBe(3);
  expect(webClear).toContain("state=C.canonicalState()");
  expect(nativeClear).not.toContain("removeAds");
  expect(webClear).not.toContain("purchaseRuntime");
});

test("moves the localized safety disclosure from the drawer into Help", () => {
  expect(webSource).not.toContain('id="drawerDisclaimer"');
  expect(webSource).not.toContain("el('drawerDisclaimer')");
  expect(webSource).not.toContain(".drawer-note{");

  const drawerSource = sourceSection(
    webSource,
    '<aside id="drawer" class="drawer">',
    "</aside>",
  );
  expect(drawerSource).not.toContain("app.disclaimer");

  const helpSource = sourceSection(
    webSource,
    "function renderHelp(){",
    "\n\nfunction initialOnboardingDraft",
  );
  expect(helpSource).toContain('id="helpDisclaimer"');
  expect(helpSource).toContain("tr('app.disclaimer')");
  expect(occurrences(helpSource, "tr('app.disclaimer')")).toBe(1);
  expect(webSource).toContain(
    ".main{padding-bottom:calc(var(--ad-nav-height) + var(--ad-visible-height) + var(--ad-visible-separator-height) + var(--ad-content-gap))!important}",
  );

  const localizedCopy: Array<[string, number]> = [
    ["Independent local-first tracker. No account, profile, or publisher-operated analytics or telemetry. Core tracker data is stored in the app on this device and is not uploaded to an operator-controlled server; exports and device backups are explained in the Privacy Policy. Without an active one-time Remove Ads purchase, the app displays one fixed non-personalized banner ad. Google may process device and advertising data as explained in the Privacy Policy. The app never asks for an EBT/WIC PIN or connects to a government benefit account.", 2],
    ["Rastreador independiente y local. No requiere cuenta ni perfil y no contiene analítica o telemetría operada por el editor. Los datos principales del rastreador se almacenan en la aplicación en este dispositivo y no se cargan a un servidor controlado por el operador; las exportaciones y copias de seguridad se explican en la Política de Privacidad. Sin una compra única activa para eliminar anuncios, la aplicación muestra un anuncio fijo de banner no personalizado. Google puede procesar datos del dispositivo y de publicidad según se explica en la Política de Privacidad. La aplicación nunca solicita un PIN de EBT/WIC ni se conecta a una cuenta gubernamental de beneficios.", 2],
    ["Locally entered balances, benefits, grocery items, budgets, and History are not sent as ad parameters.", 2],
    ["No hay cuenta ni perfil. Los saldos, beneficios, artículos, presupuestos e Historial introducidos localmente no se envían como parámetros publicitarios.", 2],
    ["Independent app—not affiliated with or endorsed by USDA Food and Nutrition Administration (FNA; formerly FNS), Puerto Rico ADSEF, any SNAP/PAN or WIC agency, retailer, or card issuer. It does not provide official balances, eligibility decisions, retailer acceptance, or product authorization. Official sources control.", 3],
    ["Aplicación independiente: no está afiliada ni respaldada por Administración de Alimentos y Nutrición del USDA (FNA; anteriormente FNS), ADSEF de Puerto Rico, una agencia de SNAP/PAN o WIC, un comercio ni un emisor de tarjeta. No ofrece saldos oficiales, decisiones de elegibilidad, aceptación de comercios ni autorización de productos. Prevalecen las fuentes oficiales.", 3],
  ];
  for (const [value, expectedOccurrences] of localizedCopy) {
    expect(occurrences(webSource, value)).toBe(expectedOccurrences);
  }
});

test("ships one reviewed native non-consumable and no Benefits & Resources directory", () => {
  expect(nativeSource).not.toContain('case "publisher-ad-choice"');
  expect(nativeSource).toContain('case "clear-app-data"');
  expect(nativeSource).toContain("automaticallyAdjustContentInsets={false}");
  expect(nativeSource).toContain('./src/removeAdsPurchase');
  expect(purchaseSource).toContain('from "expo-iap"');
  expect(nativeSource).not.toMatch(/react-native-iap|\.\/src\/billing/);
  expect(purchaseSource).not.toMatch(/react-native-iap|QA_PURCHASES|subscription/);
  expect(webSource).not.toMatch(/expo-iap|react-native-iap|anonymousReport/);
  expect(iosNoticeSource).toContain("expo-iap@5.2.4");
  expect(iosNoticeSource).toContain("expo-tracking-transparency@57.0.1");
  expect(iosNoticeSource).toContain('["openiap"]');
  expect(iosNoticeSource).toContain(
    "Pods-SNAPEBTGroceryTrackerQA-acknowledgements.markdown",
  );
  expect(occurrences(webSource, "data-action=\"restore-remove-ads\"")).toBe(1);
  expect(occurrences(webSource, "data-action=\"purchase-remove-ads\"")).toBe(1);
  expect(webSource).toContain(
    "{route:'removeAds',key:purchaseRuntime.adsRemoved?'drawer.adsRemoved':'drawer.removeAds'",
  );
  for (const removed of [
    "SUPPORT_RESOURCES",
    "resourceFilters",
    "renderResources",
    "drawer.resources",
    "nav.resources",
    "resources.subtitle",
    "resourceSearch",
    "resource-section",
    "open-resource",
  ]) {
    expect(webSource).not.toContain(removed);
  }

  const injectedBridge = sourceSection(
    nativeSource,
    "const NATIVE_BRIDGE_SCRIPT = String.raw`",
    "\n\nclass NativeBridgeError",
  )
    .replace("const NATIVE_BRIDGE_SCRIPT = String.raw`", "")
    .replace(/\n`;\s*$/, "");
  expect(() => new Function(injectedBridge)).not.toThrow();
});
