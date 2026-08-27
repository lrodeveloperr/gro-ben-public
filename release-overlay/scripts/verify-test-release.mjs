import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const EXPECTED_ICON_SHA256 =
  "a2893e96e83fed237c7063747c1f41c10c30ea85e3911149c13b02bfa861f808";
const EXPECTED_BRAND_LOGO_SHA256 =
  "a2893e96e83fed237c7063747c1f41c10c30ea85e3911149c13b02bfa861f808";
const EXPECTED_BRAND_MASTER_SHA256 =
  "6dc4daf09634cf419056c20be1ccbcfb3af9694a66909d579194100a1e740ff0";
const TEST_APP_ID = "ca-app-pub-3940256099942544~1458002511";
const PRODUCTION_PUBLISHER_ID = "8054612600809568";
const PRODUCTION_APP_ID = "ca-app-pub-8054612600809568~1748518282";
const PRODUCTION_BANNER_ID = "ca-app-pub-8054612600809568/3872496047";
const adProfile = process.env.EXPO_PUBLIC_AD_PROFILE;

if (!["test", "production"].includes(adProfile)) {
  throw new Error("Release verifier requires an explicit test or production ad profile.");
}
const expectedBuildProfile = adProfile === "production" ? "production" : "qa";
if (process.env.EXPO_PUBLIC_BUILD_PROFILE !== expectedBuildProfile) {
  throw new Error(
    `${adProfile} ads require the ${expectedBuildProfile} build profile.`,
  );
}

const expectedAppId =
  adProfile === "production" ? PRODUCTION_APP_ID : TEST_APP_ID;

if (adProfile === "production") {
  const productionInputs = {
    publisherId: process.env.EXPO_PUBLIC_ADMOB_PUBLISHER_ID,
    appId: process.env.EXPO_PUBLIC_IOS_ADMOB_APP_ID,
    bannerId: process.env.EXPO_PUBLIC_IOS_ADMOB_BANNER_ID,
  };
  const expectedInputs = {
    publisherId: PRODUCTION_PUBLISHER_ID,
    appId: PRODUCTION_APP_ID,
    bannerId: PRODUCTION_BANNER_ID,
  };
  for (const [key, expected] of Object.entries(expectedInputs)) {
    if (productionInputs[key] !== expected) {
      throw new Error(`Production AdMob ${key} must exactly match the reviewed live identifier.`);
    }
  }
  if (
    !productionInputs.appId.startsWith(`ca-app-pub-${productionInputs.publisherId}~`) ||
    !productionInputs.bannerId.startsWith(`ca-app-pub-${productionInputs.publisherId}/`)
  ) {
    throw new Error("Production AdMob identifiers do not share the approved publisher.");
  }
  if (
    productionInputs.publisherId === "3940256099942544" ||
    productionInputs.appId.includes("3940256099942544") ||
    productionInputs.bannerId.includes("3940256099942544")
  ) {
    throw new Error("Google demo identifiers are forbidden in a production build.");
  }
}

const read = (path) => readFile(path, "utf8");
const readBytes = (path) => readFile(path);
const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");


function requireText(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: missing ${JSON.stringify(needle)}`);
  }
}

function forbidText(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`${label}: forbidden ${JSON.stringify(needle)}`);
  }
}

const [html, app, purchase, iosNotices, delegate, plist, embedded, packageJson, packageLock, skadText, iconBase64, brandLogo, brandMaster, privacyManifest, englishInfoPlist, spanishInfoPlist] =
  await Promise.all([
    read("app.html"),
    read("App.tsx"),
    read("src/removeAdsPurchase.ts"),
    read("scripts/finalize-ios-notices.mjs"),
    read("ios/SNAPEBTGroceryTrackerQA/AppDelegate.swift"),
    read("ios/SNAPEBTGroceryTrackerQA/Info.plist"),
    read("src/appHtml.ts"),
    read("package.json"),
    read("package-lock.json"),
    read("ios/skadnetwork-ids.txt"),
    read("assets/app-icon.png.base64"),
    readBytes("assets/brand-logo-ui.png"),
    readBytes("assets/brand-logo-master.jpeg"),
    read("ios/SNAPEBTGroceryTrackerQA/PrivacyInfo.xcprivacy"),
    read("ios/SNAPEBTGroceryTrackerQA/Supporting/en.lproj/InfoPlist.strings"),
    read("ios/SNAPEBTGroceryTrackerQA/Supporting/es-PR.lproj/InfoPlist.strings"),
  ]);

const EXPECTED_HTML_SHA256 = sha256(html);
requireText(
  embedded,
  `export const APP_HTML_SHA256 = "${EXPECTED_HTML_SHA256}";`,
  "embedded source",
);
requireText(html, '<div class="drawer-logo"><img src="assets/brand-logo-ui.png"', "brand logo source");
requireText(html, '${ICONS.brandLogo}', "onboarding brand logo");
requireText(html, "ICONS.brandLogo=brandLogoMount?brandLogoMount.innerHTML:'';", "brand logo reuse");
requireText(
  html,
  ".drawer{width:min(88vw,360px);background:#f7f7fa;box-shadow:none;",
  "closed drawer shadow",
);
requireText(
  html,
  ".drawer.open{box-shadow:20px 0 60px rgba(0,0,0,.18)}",
  "open drawer shadow",
);
requireText(
  html,
  ".drawer-shade{background:transparent;visibility:hidden;backdrop-filter:none;-webkit-backdrop-filter:none}",
  "closed drawer shade compositor hardening",
);
requireText(
  app,
  "automaticallyAdjustContentInsets={false}",
  "WebView inset hardening",
);
if ((app.match(/backgroundColor: "#f2f2f7"/g) || []).length !== 3) {
  throw new Error("Native root, safe-area, and WebView backgrounds must match the web surface.");
}
if ((html.match(/assets\/brand-logo-ui\.png/g) || []).length !== 1) {
  throw new Error("The canonical web app must reference the brand logo exactly once.");
}
if ((embedded.match(/data:image\/png;base64,/g) || []).length !== 1) {
  throw new Error("The native embedded app must inline the reviewed brand logo exactly once.");
}
forbidText(embedded, "assets/brand-logo-ui.png", "native embedded brand logo");
for (const fingerprint of ["M15 28" + "h34l-4 25H19z", "#ffd" + "66e", "#f39" + "a47", "drawApp" + "BasketLogo"]) {
  forbidText(html, fingerprint, "legacy colorful basket branding");
  forbidText(embedded, fingerprint, "embedded legacy colorful basket branding");
}

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
if (scripts.length < 2) throw new Error("Expected multiple inline application scripts.");
for (const [index, match] of scripts.entries()) {
  try {
    new Function(match[1]);
  } catch (error) {
    throw new Error(`Inline script ${index + 1} failed syntax validation: ${error}`);
  }
}

const messagesMarker = "const MESSAGES=";
const messagesStart = html.indexOf(messagesMarker);
const messagesEnd = html.indexOf(";\n\nObject.assign(MESSAGES", messagesStart);
if (messagesStart < 0 || messagesEnd <= messagesStart) {
  throw new Error("Could not inspect the localization catalogs.");
}
const catalogs = JSON.parse(
  html.slice(messagesStart + messagesMarker.length, messagesEnd),
);
const catalogPatchPattern =
  /Object\.assign\(MESSAGES\['(en-US|es-PR)'\],\s*(\{[\s\S]*?\})\s*\);/g;
for (const match of html.matchAll(catalogPatchPattern)) {
  Object.assign(catalogs[match[1]], vm.runInNewContext(`(${match[2]})`));
}
const englishKeys = Object.keys(catalogs["en-US"]).sort();
const spanishKeys = Object.keys(catalogs["es-PR"]).sort();
if (JSON.stringify(englishKeys) !== JSON.stringify(spanishKeys)) {
  const english = new Set(englishKeys);
  const spanish = new Set(spanishKeys);
  throw new Error(
    `Localization catalogs differ: missing es-PR=${englishKeys.filter((key) => !spanish.has(key)).join(",")}; missing en-US=${spanishKeys.filter((key) => !english.has(key)).join(",")}`,
  );
}
for (const key of [
  "drawer.removeAds",
  "drawer.adsRemoved",
  "settings.purchases",
  "purchase.title",
  "purchase.buyWithPrice",
  "purchase.restore",
  "purchase.restoreSuccess",
  "purchase.restoreNone",
  "purchase.restoreFailed",
]) {
  if (!catalogs["en-US"][key] || !catalogs["es-PR"][key]) {
    throw new Error(`The bilingual purchase catalog is missing ${key}.`);
  }
}
for (const key of englishKeys) {
  if (
    key === "drawer.resources" ||
    key === "nav.resources" ||
    key.startsWith("resources.")
  ) {
    throw new Error(`Removed Benefits & Resources key remains: ${key}.`);
  }
}

const sandbox = {
  console,
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  Uint32Array,
  ArrayBuffer,
  DataView,
  Intl,
  Date,
  Math,
  JSON,
  Map,
  Set,
  Promise,
  structuredClone,
  Blob,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(scripts[0][1], sandbox, { filename: "GBTCore.inline.js" });
vm.runInContext(scripts[3][1], sandbox, { filename: "GBTRemediation.inline.js" });
const Core = sandbox.GBTCore;
const Reports = sandbox.GBTRemediation;
if (!Core || !Reports) throw new Error("Could not load pure application/report logic.");

const currentFormat = Reports.APP_METADATA.transferFormat;
const legacyFormat = Reports.LEGACY_TRANSFER_FORMATS[0];
const currentProduct = Reports.APP_METADATA.productName;
const legacyProduct = Reports.LEGACY_PRODUCT_NAMES[0];
if (currentFormat !== "grocery-benefits-tracker-history" || currentProduct !== "Grocery Benefits Tracker") {
  throw new Error("The canonical generic transfer identity changed.");
}
if (legacyFormat !== ["snap","ebt","wic","history"].join("-") || legacyProduct !== ["SNAP-EBT & WIC","Benefits Tracker"].join(" ")) {
  throw new Error("The exact legacy transfer identity changed.");
}
for (const parserWiring of [
  "!isAcceptedTransferFormat(raw.format)",
  "!isAcceptedProductName(raw.appName)",
  "!isAcceptedEncryptedTransferFormat(raw.format)",
]) {
  requireText(html, parserWiring, "legacy transfer parser wiring");
}
if (!Reports.isAcceptedTransferFormat(currentFormat) || !Reports.isAcceptedTransferFormat(legacyFormat)) {
  throw new Error("Current or legacy plain transfer compatibility is missing.");
}
if (
  !Reports.isAcceptedEncryptedTransferFormat(currentFormat + "-encrypted") ||
  !Reports.isAcceptedEncryptedTransferFormat(legacyFormat + "-encrypted")
) {
  throw new Error("Current or legacy encrypted transfer compatibility is missing.");
}
if (!Reports.isAcceptedProductName(currentProduct) || !Reports.isAcceptedProductName(legacyProduct)) {
  throw new Error("Current or legacy product-name compatibility is missing.");
}
for (const wrongValue of ["third-party-history", "Other Application"]) {
  if (Reports.isAcceptedTransferFormat(wrongValue) || Reports.isAcceptedEncryptedTransferFormat(wrongValue) || Reports.isAcceptedProductName(wrongValue)) {
    throw new Error("An unrelated transfer identity was accepted.");
  }
}

const legacyAdState = Core.canonicalState();
const legacyAdOn = Core.clone(legacyAdState);
const legacyAdOff = Core.clone(legacyAdState);
legacyAdOn.settings.advertisingConsent = {
  allowed: true,
  disclosureVersion: "legacy",
  updatedAt: "2026-08-11T00:00:00.000Z",
};
legacyAdOff.settings.advertisingConsent = {
  allowed: false,
  disclosureVersion: "legacy",
  updatedAt: "2026-08-11T00:00:00.000Z",
};
const normalizedLegacyAdOn = Core.normalizeState(legacyAdOn);
const normalizedLegacyAdOff = Core.normalizeState(legacyAdOff);
if (
  Object.prototype.hasOwnProperty.call(normalizedLegacyAdOn.settings, "advertisingConsent") ||
  Object.prototype.hasOwnProperty.call(normalizedLegacyAdOff.settings, "advertisingConsent") ||
  JSON.stringify(normalizedLegacyAdOn.settings) !== JSON.stringify(normalizedLegacyAdOff.settings)
) {
  throw new Error("Legacy publisher ad choices still influence normalized state.");
}
const legacyOnboardingDraft = Core.clone(legacyAdState);
legacyOnboardingDraft.entryDrafts = {
  shop: null,
  onboarding: { advertisingAllowed: false },
  cash: null,
};
const normalizedLegacyDraft = Reports.migrateStateForRemediation(legacyOnboardingDraft);
if (
  Object.prototype.hasOwnProperty.call(
    normalizedLegacyDraft.entryDrafts.onboarding,
    "advertisingAllowed",
  )
) {
  throw new Error("Legacy onboarding ad choice survived migration.");
}

const bridgeMatch = app.match(
  /const NATIVE_BRIDGE_SCRIPT = String\.raw`([\s\S]*?)`;/,
);
if (!bridgeMatch) throw new Error("Could not inspect the native share bridge.");
const bridgeMessages = [];
class TestFileReader {
  readAsDataURL(blob) {
    this.result = `data:${blob.type || "application/octet-stream"};base64,WA==`;
    queueMicrotask(() => this.onload?.());
  }
}
const bridgeWindow = {
  ReactNativeWebView: {
    postMessage(value) {
      bridgeMessages.push(JSON.parse(value));
    },
  },
  setTimeout,
  clearTimeout,
  setInterval: () => 1,
  addEventListener: () => {},
  GBTAdRuntime: null,
};
bridgeWindow.window = bridgeWindow;
const bridgeSandbox = {
  window: bridgeWindow,
  navigator: {},
  Blob,
  FileReader: TestFileReader,
  console,
  JSON,
  Math,
  Date,
  Promise,
  Error,
  Object,
  Array,
  String,
  Boolean,
};
vm.createContext(bridgeSandbox);
vm.runInContext(bridgeMatch[1], bridgeSandbox, { filename: "native-bridge.js" });
const firstShare = bridgeWindow.GBTNativeShareFile(
  new Blob(["first"], { type: "application/pdf" }),
  "same-name.pdf",
  "application/pdf",
);
await Promise.resolve();
await Promise.resolve();
const firstMessage = bridgeMessages.find((message) => message.type === "share-file");
if (!firstMessage?.requestId) throw new Error("Native share request was not posted.");
const concurrentError = await bridgeWindow
  .GBTNativeShareFile(new Blob(["second"]), "same-name.pdf", "application/pdf")
  .then(() => "", (error) => error.message);
if (!concurrentError.includes("already open")) {
  throw new Error("Concurrent native exports were not rejected.");
}
bridgeWindow.GBTNativeShareCompleted("stale-request", true, "SHARE_COMPLETED", "");
const staleStillBlocked = await bridgeWindow
  .GBTNativeShareFile(new Blob(["stale"]), "same-name.pdf", "application/pdf")
  .then(() => "", (error) => error.message);
if (!staleStillBlocked.includes("already open")) {
  throw new Error("A stale native acknowledgement unlocked the active export.");
}
bridgeWindow.GBTNativeShareCompleted(firstMessage.requestId, true, "SHARE_COMPLETED", "");
await firstShare;
const secondShare = bridgeWindow.GBTNativeShareFile(
  new Blob(["second"], { type: "application/pdf" }),
  "same-name.pdf",
  "application/pdf",
);
await Promise.resolve();
await Promise.resolve();
const shareMessages = bridgeMessages.filter((message) => message.type === "share-file");
const secondMessage = shareMessages.at(-1);
if (!secondMessage?.requestId || secondMessage.requestId === firstMessage.requestId) {
  throw new Error("Repeated same-name exports reused a native request ID.");
}
bridgeWindow.GBTNativeShareCompleted(
  secondMessage.requestId,
  false,
  "SHARE_CANCELLED",
  "cancelled",
);
const shareFailure = await secondShare.then(
  () => ({ code: "", message: "" }),
  (error) => ({ code: error.code, message: error.message }),
);
if (shareFailure.code !== "SHARE_CANCELLED" || shareFailure.message !== "cancelled") {
  throw new Error("Native export failure acknowledgement was not propagated.");
}
const recoveredShare = bridgeWindow.GBTNativeShareFile(
  new Blob(["third"], { type: "text/csv" }),
  "same-name.csv",
  "text/csv",
);
await Promise.resolve();
await Promise.resolve();
const recoveredMessage = bridgeMessages.filter((message) => message.type === "share-file").at(-1);
bridgeWindow.GBTNativeShareCompleted(
  recoveredMessage.requestId,
  true,
  "SHARE_COMPLETED",
  "",
);
await recoveredShare;

const prefixCases = [
  ["Walmart", "w", true],
  ["Walmart", "wa", true],
  ["Walmart", "wal", true],
  ["Waffles", "WA", true],
  ["Água", "ag", true],
  ["Safeway", "wa", false],
  ["Super Walmart", "wal", false],
  ["Walmart", "", false],
];
for (const [label, query, expected] of prefixCases) {
  if (Reports.prefixSearchMatch(label, query) !== expected) {
    throw new Error(`Prefix matching failed for ${JSON.stringify({ label, query })}.`);
  }
}

const moneyShortcutCases = [
  ["12", "00", false, "1200"],
  ["12", "99", false, "1299"],
  ["", "99", false, "99"],
  ["24000", "00", true, "24000"],
  ["24000", "99", true, "24099"],
];
for (const [digits, suffix, replaceExistingCents, expected] of moneyShortcutCases) {
  const actual = Reports.moneyDigitsWithCentsShortcut(digits, suffix, {
    replaceExistingCents,
  });
  if (actual !== expected) {
    throw new Error(`Money shortcut failed: ${digits} + .${suffix} = ${actual}.`);
  }
}
const maxMoneyDigits = String(Reports.LIMITS.maxMoneyCents);
if (Reports.moneyDigitsWithCentsShortcut(maxMoneyDigits, "99") !== maxMoneyDigits) {
  throw new Error("Money shortcut exceeded the supported maximum.");
}
if (Reports.appendMoneyDigit("99999999999", "9") !== "99999999999") {
  throw new Error("Money digit entry exceeded the supported maximum.");
}
const firstCentsShortcut = Reports.moneyDigitsWithCentsShortcut("12", "99");
const replacedCentsShortcut = Reports.moneyDigitsWithCentsShortcut(
  firstCentsShortcut,
  "00",
  { replaceExistingCents: true },
);
if (firstCentsShortcut !== "1299" || replacedCentsShortcut !== "1200") {
  throw new Error("Repeated cent shortcuts did not replace the current cents.");
}

const newSnapReconciliation = Reports.reconcileSnap({
  snapCards: [
    {
      id: "new-card",
      startingBalance: 10000,
      balance: 10000,
      transactions: [],
    },
  ],
});
if (
  newSnapReconciliation[0]?.calculatedClosingBalance !== 10000 ||
  newSnapReconciliation[0]?.reconciliationVariance !== 0
) {
  throw new Error("A new SNAP card double-counted its opening balance.");
}
const snapAdjustmentReconciliation = Reports.reconcileSnap({
  snapCards: [
    {
      id: "adjusted-card",
      startingBalance: 333333,
      balance: 212222,
      transactions: [
        { date: "2026-08-08", kind: "MANUAL_ADJUSTMENT", deltaCents: -111111 },
        { date: "2026-08-09", kind: "PURCHASE", deltaCents: -10000 },
      ],
    },
  ],
});
const adjustedSnap = snapAdjustmentReconciliation[0];
if (
  adjustedSnap?.negativeAdjustments !== 111111 ||
  adjustedSnap?.purchases !== 10000 ||
  adjustedSnap?.calculatedClosingBalance !== 212222 ||
  adjustedSnap?.reconciliationVariance !== 0
) {
  throw new Error("SNAP purchase/adjustment reconciliation failed.");
}

const wicLedgerState = {
  wicCards: [
    {
      id: "wic-ledger-card",
      allowances: [
        {
          id: "wic-ledger-benefit",
          label: "WIC ledger benefit",
          unit: "oz",
          starting: 10,
          remaining: 7.3,
          startDate: "2026-08-01",
          expiryDate: "2026-08-31",
          transactions: [
            { date: "2026-08-01", kind: "ISSUANCE", delta: 0.1, unit: "oz" },
            { date: "2026-08-02", kind: "RELOAD", delta: 0.2, unit: "oz" },
            { date: "2026-08-03", kind: "MANUAL_ADJUSTMENT", delta: -1, unit: "oz" },
            { date: "2026-08-04", kind: "PURCHASE", delta: -2, unit: "oz" },
          ],
        },
      ],
    },
  ],
};
const fullWicReconciliation = Reports.reconcileWic(wicLedgerState)[0];
const scopedWicReconciliation = Reports.reconcileWic(wicLedgerState, {
  from: "2026-08-03",
})[0];
if (
  fullWicReconciliation?.additions !== 0.3 ||
  fullWicReconciliation?.negativeAdjustments !== 1 ||
  fullWicReconciliation?.redeemedQuantity !== 2 ||
  fullWicReconciliation?.calculatedRemainingQuantity !== 7.3 ||
  fullWicReconciliation?.reconciliationVariance !== 0
) {
  throw new Error("WIC additions/purchases/adjustments did not reconcile precisely.");
}
if (
  scopedWicReconciliation?.openingQuantity !== 10.3 ||
  scopedWicReconciliation?.negativeAdjustments !== 1 ||
  scopedWicReconciliation?.redeemedQuantity !== 2 ||
  scopedWicReconciliation?.calculatedRemainingQuantity !== 7.3
) {
  throw new Error("Date-scoped WIC opening balance did not reconcile.");
}

const reportState = Core.canonicalState();
reportState.onboarded = true;
reportState.settings.language = "en-US";
reportState.settings.programJurisdiction = Reports.PROGRAM_JURISDICTION.US_SNAP;
reportState.snapCards = [
  {
    id: "snap-sentinel",
    name: "SNAP source",
    active: true,
    balance: 100000,
    startingBalance: 100000,
    transactions: [],
  },
];
reportState.wicCards = [
  {
    id: "wic-sentinel",
    name: "WIC source",
    active: true,
    transactions: [],
    allowances: [
      {
        id: "wic-benefit-sentinel",
        label: "Sentinel benefit",
        unit: "oz",
        starting: 100,
        remaining: 26.875,
        startDate: "2026-08-01",
        expiryDate: "2026-08-31",
        active: true,
        transactions: [],
      },
    ],
  },
];
reportState.history = [
  {
    id: "transaction-sentinel",
    status: "COMPLETED",
    transactionDate: "2026-08-10",
    createdAt: "2026-08-10T12:00:00Z",
    recordedAt: "2026-08-10T12:00:00Z",
    storeDisplayName: "Walmart",
    programJurisdiction: Reports.PROGRAM_JURISDICTION.US_SNAP,
    items: [
      {
        id: "split-item-sentinel",
        name: "Water",
        quantity: 1,
        quantityRaw: "1",
        quantityUnit: "each",
        priceKnown: true,
        unitPriceCents: 98765,
        priceEntryMode: "UNIT_PRICE",
        lineTotalCents: null,
        category: "beverages",
        allocations: [
          { type: "SNAP", amountCents: 60001, cardId: "snap-sentinel" },
          { type: "CASH", amountCents: 38764 },
        ],
      },
      {
        id: "wic-item-sentinel",
        name: "Waffles",
        quantity: 1,
        quantityRaw: "1",
        quantityUnit: "each",
        priceKnown: true,
        unitPriceCents: 12345,
        priceEntryMode: "UNIT_PRICE",
        lineTotalCents: null,
        category: "other",
        allocations: [
          {
            type: "WIC",
            amountCents: 12345,
            cardId: "wic-sentinel",
            allowanceId: "wic-benefit-sentinel",
            quantity: 73.125,
            unit: "oz",
            wicBenefitLabel: "Sentinel benefit",
          },
        ],
      },
    ],
  },
];

const reportSnapshot = await Reports.buildReportSnapshot(
  reportState,
  { funding: "ALL", includeFullSplitContext: true },
  { locale: "en-US" },
);
const reportCsv = Reports.buildReportCsv(reportSnapshot);
const reportCsvLines = reportCsv.split(/\r?\n/);
if (reportCsvLines.length !== 3) {
  throw new Error(`Item-level CSV expected 2 data rows; found ${reportCsvLines.length - 1}.`);
}
if ((reportCsv.match(/987\.65/g) || []).length !== 1) {
  throw new Error("Split-payment CSV repeated or omitted the item total.");
}
const csvHeader = reportCsvLines[0].replace(/^\ufeff/, "").split(",");
const waterRow = reportCsvLines.find((line) => line.includes(",Water,"))?.split(",");
if (!waterRow) throw new Error("Split-payment item is missing from CSV.");
for (const [column, expected] of [
  ["itemTotalUSD", "987.65"],
  ["snapUSD", "600.01"],
  ["cashUSD", "387.64"],
]) {
  if (waterRow[csvHeader.indexOf(column)] !== expected) {
    throw new Error(`CSV ${column} did not reconcile to ${expected}.`);
  }
}

const strictSnapSnapshot = await Reports.buildReportSnapshot(
  reportState,
  { funding: "SNAP", includeFullSplitContext: false },
  { locale: "en-US" },
);
const fullSplitSnapSnapshot = await Reports.buildReportSnapshot(
  reportState,
  { funding: "SNAP", includeFullSplitContext: true },
  { locale: "en-US" },
);
const strictSnapLines = Reports.buildReportCsv(strictSnapSnapshot).split(/\r?\n/);
const fullSplitSnapLines = Reports.buildReportCsv(fullSplitSnapSnapshot).split(/\r?\n/);
const strictSnapHeader = strictSnapLines[0].replace(/^\ufeff/, "").split(",");
const strictWater = strictSnapLines.find((line) => line.includes(",Water,"))?.split(",");
const fullSplitWater = fullSplitSnapLines.find((line) => line.includes(",Water,"))?.split(",");
if (!strictWater || !fullSplitWater) {
  throw new Error("Filtered split-payment CSV item is missing.");
}
if (strictWater[strictSnapHeader.indexOf("cashUSD")] !== "") {
  throw new Error("Strict SNAP CSV leaked out-of-scope Cash context.");
}
if (fullSplitWater[strictSnapHeader.indexOf("cashUSD")] !== "387.64") {
  throw new Error("Full split-context SNAP CSV omitted the Cash remainder.");
}

const precisionSnapshot = structuredClone(reportSnapshot);
const sourceWicAllocation = reportSnapshot.allocations.find(
  (allocation) => allocation.fundingType === "WIC",
);
if (!sourceWicAllocation) throw new Error("WIC report precision fixture is missing.");
precisionSnapshot.allocations = [
  { ...sourceWicAllocation, amountCents: 6000, wicQuantity: 0.1 },
  {
    ...sourceWicAllocation,
    amountCents: 6345,
    allowanceId: "wic-benefit-precision-second",
    wicQuantity: 0.2,
  },
];
precisionSnapshot.splitContextAllocations = structuredClone(precisionSnapshot.allocations);
precisionSnapshot.wicReconciliations = [fullWicReconciliation];
const precisionCsvLines = Reports.buildReportCsv(precisionSnapshot).split(/\r?\n/);
const precisionHeader = precisionCsvLines[0].replace(/^\ufeff/, "").split(",");
const precisionWicRow = precisionCsvLines.find((line) => line.includes(",Waffles,"))?.split(",");
if (precisionWicRow?.[precisionHeader.indexOf("wicQuantity")] !== "0.3") {
  throw new Error("CSV emitted a binary floating-point WIC quantity.");
}
const precisionXlsxText = new TextDecoder().decode(
  Reports.buildReportXlsx(precisionSnapshot),
);
if (
  precisionXlsxText.includes("0.30000000000000004") ||
  !precisionXlsxText.includes("<v>0.3</v>")
) {
  throw new Error("XLSX emitted an imprecise WIC reconciliation quantity.");
}

const maskedReport = Reports.maskedSnapshot(reportSnapshot);
if (
  maskedReport.totals.knownGrocerySpendCents !== "MASKED" ||
  Object.values(maskedReport.totals.funding).some((value) => value !== "MASKED")
) {
  throw new Error("Masked report totals retain unmasked monetary values.");
}
for (const key of [
  "openingBalance",
  "issuances",
  "refunds",
  "positiveAdjustments",
  "purchases",
  "negativeAdjustments",
  "correctionEffects",
  "calculatedClosingBalance",
  "recordedClosingBalance",
  "reconciliationVariance",
]) {
  if (maskedReport.snapReconciliations[0]?.[key] !== "MASKED") {
    throw new Error(`Masked SNAP reconciliation leaked ${key}.`);
  }
}
for (const key of [
  "openingQuantity",
  "authorizedStartQuantity",
  "additions",
  "restorations",
  "positiveAdjustments",
  "redeemedQuantity",
  "negativeAdjustments",
  "correctionEffects",
  "expiredQuantity",
  "calculatedRemainingQuantity",
  "recordedRemainingQuantity",
  "reconciliationVariance",
]) {
  if (maskedReport.wicReconciliations[0]?.[key] !== "MASKED") {
    throw new Error(`Masked WIC reconciliation leaked ${key}.`);
  }
}
const maskedCsv = Reports.buildReportCsv(maskedReport);
const maskedXlsxBytes = Reports.buildReportXlsx(maskedReport);
const maskedPdfBytes = Reports.buildReportPdf(maskedReport);
const maskedXlsxText = new TextDecoder().decode(maskedXlsxBytes);
const maskedPdfText = new TextDecoder().decode(maskedPdfBytes);
for (const sentinel of ["987.65", "600.01", "387.64", "123.45", "73.125", "26.875"]) {
  if ([maskedCsv, maskedXlsxText, maskedPdfText].some((value) => value.includes(sentinel))) {
    throw new Error(`Masked report leaked sentinel ${sentinel}.`);
  }
}
if (!maskedCsv.includes("MASKED") || !maskedXlsxText.includes("MASKED") || !maskedPdfText.includes("MASKED")) {
  throw new Error("Masked report formats do not visibly mark protected values.");
}
function assertPdfXref(bytes) {
  const text = new TextDecoder().decode(bytes);
  const startMatch = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (!startMatch) throw new Error("PDF startxref marker is missing.");
  const xrefOffset = Number(startMatch[1]);
  const xrefText = new TextDecoder().decode(bytes.slice(xrefOffset));
  const lines = xrefText.split(/\r?\n/);
  if (lines[0] !== "xref") throw new Error("PDF startxref does not point to xref.");
  const [, objectCountText] = String(lines[1] || "").split(/\s+/);
  const objectCount = Number(objectCountText);
  if (!Number.isSafeInteger(objectCount) || objectCount < 2) {
    throw new Error("PDF xref object count is invalid.");
  }
  for (let objectId = 1; objectId < objectCount; objectId += 1) {
    const entry = lines[2 + objectId] || "";
    const objectOffset = Number(entry.slice(0, 10));
    const objectHeader = new TextDecoder().decode(
      bytes.slice(objectOffset, objectOffset + 32),
    );
    if (!objectHeader.startsWith(`${objectId} 0 obj`)) {
      throw new Error(`PDF xref entry ${objectId} points to the wrong object.`);
    }
  }
}

function assertTaggedPdfAccessibility(bytes) {
  const text = new TextDecoder().decode(bytes);
  for (const marker of [
    "/MarkInfo << /Marked true /Suspects false >>",
    "/StructTreeRoot",
    "/ParentTree",
    "/StructParents",
    "/MCID",
    "/Artifact BMC",
    "/ToUnicode",
    "/Title",
    "/S /Document",
    "/S /H1",
    "/S /H2",
    "/S /P",
    "/S /Table",
    "/S /TR",
    "/S /TH",
    "/S /TD",
  ]) {
    if (!text.includes(marker)) throw new Error(`Tagged PDF is missing ${marker}.`);
  }
  const pageCount = (text.match(/\/Type \/Page\b/g) || []).length;
  const structParentCount = (text.match(/\/StructParents\s+\d+/g) || []).length;
  const fontUnicodeCount = (text.match(/\/ToUnicode\s+\d+\s+0\s+R/g) || []).length;
  if (!pageCount || structParentCount !== pageCount) {
    throw new Error("Tagged PDF does not map every page into the ParentTree.");
  }
  if (fontUnicodeCount !== 2) {
    throw new Error("Tagged PDF fonts do not both expose a ToUnicode map.");
  }
}

function assertZipCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("XLSX ZIP end-of-central-directory is missing.");
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  let cursor = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error(`XLSX central-directory entry ${index} is invalid.`);
    }
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`XLSX local-file entry ${index} is invalid.`);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (entries < 5 || cursor !== centralOffset + centralSize) {
    throw new Error("XLSX central-directory size or entry count is invalid.");
  }
}
if (!new TextDecoder().decode(maskedPdfBytes.slice(0, 8)).startsWith("%PDF-1.4")) {
  throw new Error("Generated PDF signature is invalid.");
}
if (maskedXlsxBytes[0] !== 0x50 || maskedXlsxBytes[1] !== 0x4b) {
  throw new Error("Generated XLSX ZIP signature is invalid.");
}
assertPdfXref(maskedPdfBytes);
assertTaggedPdfAccessibility(maskedPdfBytes);
assertZipCentralDirectory(maskedXlsxBytes);

const stressReport = structuredClone(reportSnapshot);
const sourceAllocation = reportSnapshot.allocations[0];
const sourceItem = reportSnapshot.items[0];
const sourceTransaction = reportSnapshot.transactions[0];
stressReport.allocations = Array.from({ length: 1000 }, (_, index) => ({
  ...sourceAllocation,
  transactionId: `stress-transaction-${index}`,
  itemId: `stress-item-${index}`,
  itemName: `Stress item ${index}`,
}));
stressReport.splitContextAllocations = structuredClone(stressReport.allocations);
stressReport.items = Array.from({ length: 1000 }, (_, index) => ({
  ...sourceItem,
  transactionId: `stress-transaction-${index}`,
  itemId: `stress-item-${index}`,
  itemName: `Stress item ${index}`,
}));
stressReport.transactions = Array.from({ length: 1000 }, (_, index) => ({
  ...sourceTransaction,
  transactionId: `stress-transaction-${index}`,
}));
stressReport.totals.transactionCount = 1000;
stressReport.totals.itemCount = 1000;
stressReport.totals.allocationCount = 1000;
const stressCsv = Reports.buildReportCsv(stressReport);
const stressXlsx = Reports.buildReportXlsx(stressReport);
const stressPdf = Reports.buildReportPdf(stressReport);
if (stressCsv.split(/\r?\n/).length !== 1001 || stressXlsx.length < 10000 || stressPdf.length < 10000) {
  throw new Error("1,000-row report stress generation failed.");
}
assertPdfXref(stressPdf);
assertTaggedPdfAccessibility(stressPdf);
assertZipCentralDirectory(stressXlsx);
const oversizedPdf = structuredClone(stressReport);
oversizedPdf.allocations = Array.from({ length: 2001 }, () => sourceAllocation);
oversizedPdf.splitContextAllocations = structuredClone(oversizedPdf.allocations);
let oversizedPdfCode = "";
try {
  Reports.buildReportPdf(oversizedPdf);
} catch (error) {
  oversizedPdfCode = error?.code || "";
}
if (oversizedPdfCode !== Reports.ERROR.PDF_TOO_LARGE) {
  throw new Error("Oversized PDF did not fail safely with PDF_TOO_LARGE.");
}

requireText(html, "window.GBTAdRuntime=Object.freeze", "web ad runtime");
requireText(html, "downloadBlob('grocery-benefits-tracker-local-recovery.txt',blob)", "recovery export");
requireText(html, "R.prefixSearchMatch(entry.label,query)", "item prefix-only suggestions");
requireText(html, "R.prefixSearchMatch(name,query)", "store prefix-only suggestions");
requireText(html, 'data-action="money-pad-cents" data-cents="00"', "quick .00 money entry");
requireText(html, 'data-action="money-pad-cents" data-cents="99"', "quick .99 money entry");
requireText(html, "moneyPadState.centsShortcutApplied", "idempotent cent shortcuts");
requireText(html, "moneyInputAttributes(a.unit==='$'", "conditional WIC dollar keypad");
requireText(html, "moneyInputAttributes(true,d.priceEntryMode", "transaction price keypad");
requireText(html, "input.dispatchEvent(new Event('change',{bubbles:true}))", "money keypad change synchronization");
requireText(html, "function adPlacementAllowed(){return state.route!=='cards'&&state.route!=='removeAds'&&!modalState;}", "Cards, Remove Ads, and modal ad exclusion");
requireText(html, "window.dispatchEvent(new Event('gbt-ad-presentation-change'))", "immediate ad-placement bridge");
requireText(html, "window.GBTNativeShareFile(blob,name", "explicit native report-share bridge");
requireText(html, "SNAP_ITEM_NOT_ELIGIBLE", "SNAP/PAN eligibility checkout guard");
requireText(html, "buildHistoryBackupParts", "multipart History backup");
requireText(html, "Payment Allocations", "allocation-detail spreadsheet export");
requireText(html, "window.GBTNativeReconcileNotifications", "local reminder bridge");
requireText(html, "const TERMS_VERSION='2026-08-13';", "versioned Terms acceptance");
requireText(html, 'id="onAgeConfirmed" type="checkbox"', "separate adult confirmation");
requireText(html, 'id="onTermsAccepted" type="checkbox"', "separate Terms and Privacy confirmation");
requireText(html, "if(step==='legal'&&(!d.ageConfirmed||!d.termsAccepted))", "mandatory first-run legal gate");
requireText(html, "next.settings.legalAcceptance=makeLegalAcceptance()", "persisted legal acceptance");
requireText(html, "tr('onboarding.advertisingNotice')", "non-interactive first-run ad disclosure");
requireText(html, "tr('legal.adSupportedBody')", "static legal advertising disclosure");
requireText(
  html,
  "advertisingPrivacyChoicesRequired?legalRow('privacy-choices'",
  "UMP-required privacy choices row",
);
requireText(html, "delete out.settings.advertisingConsent;", "legacy ad preference removal");
requireText(
  html,
  "delete s.entryDrafts.onboarding.advertisingAllowed;",
  "legacy onboarding ad preference removal",
);
requireText(
  html,
  "function criticalAdFlowActive(){return drawerOpen||!adPlacementAllowed()",
  "drawer-open banner suppression",
);
for (const obsolete of [
  "AD_DISCLOSURE_VERSION",
  "makeAdvertisingConsent",
  "publisherAdsAllowed",
  "normalizeAdvertisingConsent",
  "onAdvertisingAllowed",
  "advertisingPermissionSetting",
  "savePublisherAdvertisingChoice",
  "confirmPublisherAdvertisingChoice",
  "confirm-publisher-ads",
  "privacyChoicesAdsOff",
  "onboarding.advertisingChoice",
  "publisher-ad-choice",
  "ADS_REMOVED",
  "ads-removed",
]) {
  forbidText(html, obsolete, "obsolete free ad-off path");
}
if ((html.split("advertisingConsent").length - 1) !== 1) {
  throw new Error("advertisingConsent must remain only as a migration deletion.");
}
if ((html.split("advertisingAllowed").length - 1) !== 2) {
  throw new Error("advertisingAllowed must remain only in migration deletions.");
}
requireText(html, "renderTermsReaccept()", "material Terms reacceptance gate");
requireText(html, "window.GBTNativeClearAppData", "acknowledged native Clear All bridge");
requireText(html, "localStorage.removeItem(key);if(localStorage.getItem(key)!==null)return false;", "verified legacy tracker deletion");
requireText(html, "await reconcileNativeReminders()", "Clear All failure reminder rollback");
requireText(html, "surviving temporary export-cache copies", "Clear All native-cache boundary");
requireText(html, "Masking hides financial amounts and WIC quantities only.", "masked-report scope warning");
const helpStart = html.indexOf("function renderHelp(){");
const helpEnd = html.indexOf("\n\nfunction initialOnboardingDraft", helpStart);
if (helpStart < 0 || helpEnd <= helpStart) {
  throw new Error("Help renderer boundaries are missing.");
}
const helpSource = html.slice(helpStart, helpEnd);
requireText(helpSource, 'id="helpDisclaimer"', "Help disclosure destination");
if ((helpSource.split("tr('app.disclaimer')").length - 1) !== 1) {
  throw new Error("Help must render the canonical disclosure exactly once.");
}
forbidText(html, 'id="drawerDisclaimer"', "ad-adjacent drawer disclosure");
forbidText(html, "el('drawerDisclaimer')", "drawer disclosure locale binding");
forbidText(html, ".drawer-note{", "obsolete drawer disclosure styling");
requireText(
  html,
  ".main{padding-bottom:calc(var(--ad-nav-height) + var(--ad-visible-height) + var(--ad-visible-separator-height) + var(--ad-content-gap))!important}",
  "ad-aware Help scrolling",
);
for (const [label, value, expectedOccurrences] of [
  ["English disclosure", "Independent local-first tracker. No account, profile, or publisher-operated analytics or telemetry. Core tracker data is stored in the app on this device and is not uploaded to an operator-controlled server; exports and device backups are explained in the Privacy Policy. Without an active one-time Remove Ads purchase, the app displays one fixed non-personalized banner ad. Google may process device and advertising data as explained in the Privacy Policy. The app never asks for an EBT/WIC PIN or connects to a government benefit account.", 2],
  ["Puerto Rico Spanish disclosure", "Rastreador independiente y local. No requiere cuenta ni perfil y no contiene analítica o telemetría operada por el editor. Los datos principales del rastreador se almacenan en la aplicación en este dispositivo y no se cargan a un servidor controlado por el operador; las exportaciones y copias de seguridad se explican en la Política de Privacidad. Sin una compra única activa para eliminar anuncios, la aplicación muestra un anuncio fijo de banner no personalizado. Google puede procesar datos del dispositivo y de publicidad según se explica en la Política de Privacidad. La aplicación nunca solicita un PIN de EBT/WIC ni se conecta a una cuenta gubernamental de beneficios.", 2],
  ["English Privacy supplement", "Locally entered balances, benefits, grocery items, budgets, and History are not sent as ad parameters.", 2],
  ["Puerto Rico Spanish Privacy supplement", "No hay cuenta ni perfil. Los saldos, beneficios, artículos, presupuestos e Historial introducidos localmente no se envían como parámetros publicitarios.", 2],
  ["English independence copy", "Independent app—not affiliated with or endorsed by USDA Food and Nutrition Administration (FNA; formerly FNS), Puerto Rico ADSEF, any SNAP/PAN or WIC agency, retailer, or card issuer. It does not provide official balances, eligibility decisions, retailer acceptance, or product authorization. Official sources control.", 3],
  ["Puerto Rico Spanish independence copy", "Aplicación independiente: no está afiliada ni respaldada por Administración de Alimentos y Nutrición del USDA (FNA; anteriormente FNS), ADSEF de Puerto Rico, una agencia de SNAP/PAN o WIC, un comercio ni un emisor de tarjeta. No ofrece saldos oficiales, decisiones de elegibilidad, aceptación de comercios ni autorización de productos. Prevalecen las fuentes oficiales.", 3],
]) {
  if ((html.split(value).length - 1) !== expectedOccurrences) {
    throw new Error(`${label} must remain synchronized across its required placements.`);
  }
}
requireText(html, "No account, profile, or publisher-operated analytics or telemetry.", "qualified local-first disclosure");
forbidText(html, "anonymousReport", "overbroad report anonymity claim");
forbidText(html, "Anonymous report", "overbroad report anonymity claim");
forbidText(html, "Reporte anónimo", "overbroad report anonymity claim");
forbidText(html, "Core tracker data stays on this device unless you export it.", "device-backup overstatement");
forbidText(html, "Los datos principales del rastreador permanecen en este dispositivo salvo que los exportes.", "device-backup overstatement");
requireText(html, "window.GBTPurchaseRuntime=Object.freeze", "ephemeral purchase runtime");
requireText(html, "postPurchaseIntent('purchase-remove-ads')", "purchase intent bridge");
requireText(html, "postPurchaseIntent('restore-remove-ads')", "restore intent bridge");
requireText(html, "purchaseRuntime.displayPrice", "StoreKit localized display price");
requireText(html, "data-action=\"purchase-remove-ads\"", "Remove Ads purchase action");
if ((html.match(/data-action="restore-remove-ads"/g) || []).length !== 1) {
  throw new Error("Settings must contain exactly one Restore Purchase action.");
}
if ((html.match(/\{route:'removeAds'/g) || []).length !== 1) {
  throw new Error("The drawer must contain exactly one Remove Ads destination.");
}
const removeAdsRendererStart = html.indexOf("function renderRemoveAds(){");
const settingsRendererStart = html.indexOf("function renderSettings(){");
const helpRendererStart = html.indexOf("function renderHelp(){");
if (
  removeAdsRendererStart < 0 ||
  settingsRendererStart <= removeAdsRendererStart ||
  helpRendererStart <= settingsRendererStart
) {
  throw new Error("Purchase renderer boundaries are missing.");
}
const removeAdsRenderer = html.slice(removeAdsRendererStart, settingsRendererStart);
const settingsRenderer = html.slice(settingsRendererStart, helpRendererStart);
if ((removeAdsRenderer.match(/data-action="purchase-remove-ads"/g) || []).length !== 1) {
  throw new Error("Remove Ads must contain exactly one native purchase action.");
}
if ((settingsRenderer.match(/data-action="restore-remove-ads"/g) || []).length !== 1) {
  throw new Error("Settings must contain exactly one native restore action.");
}
for (const removedResource of [
  "SUPPORT_RESOURCES",
  "resourceFilters",
  "renderResources",
  "drawer.resources",
  "nav.resources",
  "resources.subtitle",
  "resourceSearch",
  "resource-section",
  "open-resource",
  "resources-page",
  "resource-grid",
  "resource-card",
  "{route:'resources'",
  "Benefits & Resources",
  "Benefits and Resources",
  "Beneficios y recursos",
]) {
  forbidText(html, removedResource, "removed Benefits & Resources directory");
}
for (const priceLiteral of ["$4.99", "$9.99", "$12.99"]) {
  forbidText(html, priceLiteral, "hard-coded App Store price");
}
requireText(html, "USDA Food and Nutrition Administration (FNA; formerly FNS)", "current English agency attribution");
requireText(html, "Administración de Alimentos y Nutrición del USDA (FNA; anteriormente FNS)", "current Spanish agency attribution");
forbidText(html, "USDA/FNS", "obsolete agency attribution");
for (const legacyPublicMarker of [
  ["snap-wic-benefits-tracker-legal", "legacy public legal URL"],
  [["SNAP-EBT & WIC","Benefits Tracker"].join(" "), "legacy public app title"],
  ["SNAP-EBT · WIC · Shopping budget", "legacy drawer subtitle"],
  ["snap-ebt-wic-local-recovery.txt", "legacy public recovery filename"],
]) {
  forbidText(html, legacyPublicMarker[0], legacyPublicMarker[1]);
}
for (const requiredPublicMarker of [
  ["Grocery Benefits Tracker", "current English product name"],
  ["Rastreador de Beneficios", "current Spanish product name"],
  ["https://lrodeveloperr.github.io/grocery-benefits-tracker/privacy/", "current English privacy URL"],
  ["https://lrodeveloperr.github.io/grocery-benefits-tracker/es/privacidad/", "current Spanish privacy URL"],
  ["grocery-benefits-tracker-local-recovery.txt", "current recovery filename"],
  ["id=\"drawerAppTitle\"", "localized drawer title binding"],
  ["isAcceptedProductName(raw.appName)", "backward-compatible backup app-name validation"],
  ["transferFormat:'grocery-benefits-tracker-history'", "current cross-platform backup wire-format identifier"],
  ["LEGACY_TRANSFER_FORMATS", "legacy transfer compatibility list"],
  ["isAcceptedEncryptedTransferFormat(raw.format)", "legacy encrypted transfer compatibility"],
  ["function publicProductName(value){return R.isAcceptedProductName(value)?APP_METADATA.productName:String(value||APP_METADATA.productName);}", "legacy public product-name mapper"],
  ["esc(publicProductName(b.sourceProduct))", "generic import-batch product rendering"],
  ["esc(publicProductName(x.sourceProduct))", "generic import-review product rendering"],
]) {
  requireText(html, requiredPublicMarker[0], requiredPublicMarker[1]);
}
requireText(html, "if(window.ReactNativeWebView?.postMessage)throw R.err(R.ERROR.SHARE_FAILED", "native blob-navigation fail-close");
requireText(html, "\'legal.reportAd\':\'Report an Ad\'", "English Report an Ad label");
requireText(html, "\'legal.reportAdBody\':\'Report inappropriate or age-inappropriate advertising.\'", "English inappropriate-ad disclosure");
requireText(html, "\'legal.reportAd\':\'Reportar un anuncio\'", "Spanish Report an Ad label");
requireText(html, "\'legal.reportAdBody\':\'Reporta publicidad inapropiada o no adecuada para la edad.\'", "Spanish inappropriate-ad disclosure");
requireText(html, "function reportAd(){\n  openLegalUrl(\'support\');\n}", "Report an Ad support route");
requireText(html, "else if(a===\'report-ad\'){reportAd();}", "Report an Ad action");
requireText(html, "MAX_PDF_DETAIL_ROWS=2000", "bounded iPhone PDF generation");
requireText(html, "if(delta&&!isNew)", "new SNAP opening-balance ledger guard");
requireText(html, "k==='CHECKOUT'||k==='PURCHASE'", "explicit purchase ledger classification");
forbidText(html, "errors.push(['itemInput','UNRESOLVED_FUNDING'])", "shop item validation");
forbidText(html, "confirm-remove-ads-preview", "simulated purchase path");
forbidText(html, "haptic(", "haptic-free interface");
forbidText(html, 'id="hapticSetting"', "haptic-free settings");
forbidText(html, "navigator.vibrate", "haptic-free web runtime");

const secondaryStart = html.indexOf("const secondary=[");
const secondaryEnd = html.indexOf("];", secondaryStart);
if (secondaryStart < 0 || secondaryEnd < 0) {
  throw new Error("Could not inspect the navigation drawer.");
}
const drawerSource = html.slice(secondaryStart, secondaryEnd);
forbidText(drawerSource, "share-app", "navigation drawer");
requireText(drawerSource, "{route:'removeAds'", "Remove Ads drawer destination");
forbidText(drawerSource, "resources", "removed drawer resource destination");

requireText(app, 'const testAds = adProfile === "test";', "explicit test ad profile");
requireText(app, 'const productionAds = adProfile === "production";', "ad profile gate");
requireText(
  app,
  "process.env.EXPO_PUBLIC_IOS_ADMOB_APP_ID?.trim()",
  "production AdMob app ID input",
);
requireText(
  app,
  "process.env.EXPO_PUBLIC_IOS_ADMOB_BANNER_ID?.trim()",
  "production AdMob banner ID input",
);
requireText(
  app,
  "process.env.EXPO_PUBLIC_ADMOB_PUBLISHER_ID?.trim()",
  "approved AdMob publisher ID input",
);
requireText(
  app,
  "function hasMatchingProductionAdMobIdentifiers(",
  "production AdMob identifier validator",
);
requireText(
  app,
  "const appMatch = /^ca-app-pub-(\\d{16})~\\d{10}$/.exec(appId);",
  "production AdMob app ID format",
);
requireText(
  app,
  "const bannerMatch = /^ca-app-pub-(\\d{16})\\/\\d{10}$/.exec(bannerId);",
  "production AdMob banner ID format",
);
requireText(
  app,
  "/^\\d{16}$/.test(approvedPublisherId)",
  "approved AdMob publisher ID format",
);
requireText(
  app,
  "approvedPublisherId !== GOOGLE_DEMO_PUBLISHER_ID",
  "Google demo publisher rejection",
);
requireText(
  app,
  "appMatch?.[1] === approvedPublisherId",
  "production app/publisher ownership match",
);
requireText(
  app,
  "bannerMatch?.[1] === approvedPublisherId",
  "production banner/publisher ownership match",
);
if (
  !/const bannerUnitId\s*=\s*testAds\s*\?\s*TestIds\.BANNER\s*:\s*productionAdsConfigured\s*\?\s*productionBannerId\s*:\s*"";/.test(
    app,
  )
) {
  throw new Error(
    "Ad unit selection must use test inventory only for the explicit test profile and fail closed otherwise.",
  );
}
for (const unsafeFallback of [
  "productionAds ? productionBannerId : TestIds.BANNER",
  ": productionAds\n      ? productionBannerId",
  "if (!productionAds) return ensureAdsInitialized();",
  "{!productionAds ? (",
]) {
  forbidText(app, unsafeFallback, "implicit test-ad fallback");
}
requireText(app, "{testAds ? (", "test-profile-only build marker");
if ((app.match(/TestIds\.BANNER/g) || []).length !== 1) {
  throw new Error(
    "Google test banner must have exactly one explicit, profile-gated selection point.",
  );
}
requireText(app, "unitId={bannerUnitId}", "native banner");
requireText(app, "size={BannerAdSize.BANNER}", "fixed 320x50 banner");
requireText(app, "const AD_SLOT_BOTTOM = 66", "HTML/native banner alignment");
requireText(app, "requestNonPersonalizedAdsOnly: true", "non-personalized request");
requireText(app, "AdsConsent.gatherConsent()", "UMP consent update");
requireText(app, "AdsConsent.getConsentInfo()", "cached UMP consent check");
requireText(app, 'type: "legal-ready"; ready: boolean', "native legal-readiness bridge");
requireText(app, 'if (legalReady && privacyChoicesRequired) void showPrivacyChoices();', "UMP-required privacy-choice gate");
requireText(
  app,
  'const showBanner =\n    adProfileConfigured &&\n    removeAdsEntitlement === "not-entitled" &&\n    legalReady &&',
  "banner StoreKit and legal gate",
);
requireText(app, 'consentState === "permitted"', "banner UMP gate");
requireText(
  app,
  "AdsConsentPrivacyOptionsRequirementStatus.REQUIRED",
  "UMP privacy-options requirement status",
);
for (const obsolete of ["publisherAdsAllowed", "setPublisherAdsAllowed", "publisher-ad-choice"]) {
  forbidText(app, obsolete, "obsolete native free ad-off path");
}
if ((app.match(/<BannerAd\b/g) || []).length !== 1) {
  throw new Error("The release must render exactly one fixed banner component.");
}
if ((app.match(/requestNonPersonalizedAdsOnly: true/g) || []).length !== 1) {
  throw new Error("The release must make exactly one non-personalized banner request.");
}
requireText(app, "left: 0,\n    right: 0,", "unclipped 320-point banner host");
for (const unsupportedFormat of ["InterstitialAd", "RewardedAd", "RewardedInterstitialAd", "AppOpenAd"]) {
  forbidText(app, unsupportedFormat, "unsupported ad format");
}
forbidText(app, "AppTrackingTransparency", "tracking-free wrapper");
forbidText(app, "requestTrackingAuthorization", "tracking-free wrapper");
forbidText(app, "ATTrackingManager", "tracking-free wrapper");
requireText(app, "startAdsIfAllowed", "shared consent ad gate");
requireText(
  app,
  "if (testAds) {",
  "official demo-ad UMP isolation",
);
requireText(
  app,
  "if (!productionAdsConfigured) return false;",
  "unconfigured ad-profile fail-close",
);
requireText(app, "if (!adProfileConfigured) return false;", "SDK profile fail-close");
requireText(
  app,
  "if (!productionAdsConfigured) {\n      setPrivacyChoicesRequired(false);",
  "privacy-options production identifier gate",
);
requireText(
  app,
  '} catch {\n      setConsentState("blocked");\n      Alert.alert(\n        "Advertising privacy choices"',
  "privacy-options post-form failure fail-close",
);
requireText(app, "return ensureAdsInitialized();", "idempotent SDK initialization");
requireText(app, "await mobileAds().initialize()", "SDK initialization");
requireText(
  app,
  'if (removeAdsEntitlementRef.current !== "not-entitled") return false;',
  "last-moment paid-user SDK initialization guard",
);
requireText(
  app,
  "if (!initialized && adsInitializationRef.current === initialization)",
  "guarded ad-initialization cache reset",
);
requireText(app, "adLoadAttempt >= 2", "bounded banner retry");
requireText(
  app,
  'webAdState !== "AD_TEMPORARILY_HIDDEN"',
  "critical-flow banner unmount",
);
requireText(app, "{bannerMounted ? (", "native banner lifecycle gate");
requireText(app, "type: \"share-file\"", "native file-share bridge");
requireText(app, "type: \"notifications-reconcile\"", "native notification bridge");
requireText(app, "type: \"clear-app-data\"", "native Clear All bridge");
requireText(app, "NOTIFICATIONS_RECONCILED", "native notification acknowledgement");
requireText(app, "APP_DATA_CLEARED", "native Clear All acknowledgement");
requireText(app, "window.GBTNativeClearAppDataCompleted", "native Clear All completion callback");
requireText(app, 'new Directory(Paths.cache, "gbt-share")', "native temporary export-cache root");
requireText(app, "purgeShareCacheRoot()", "native temporary export-cache purge");
requireText(app, "await cancelOwnedScheduledReminders()", "native owned-reminder purge");
requireText(app, 'type ReminderKind = "snap-balance" | "wic-review" | "wic-expiry"', "bounded local reminder kinds");
requireText(app, "requestId?: string", "native file-share acknowledgement ID");
requireText(app, "window.GBTNativeShareCompleted", "native file-share acknowledgement");
requireText(app, 'file.write(base64, { encoding: "base64" })', "validated native file write");
requireText(app, "fileUti(name, message.mimeType)", "native file type mapping");
requireText(app, "const shareDirectory = new Directory(", "unique native export directory");
requireText(app, "shareDirectory.delete()", "unique native export cleanup");
forbidText(app, "new File(Paths.cache, name)", "same-name native export collision");
requireText(app, "onShouldStartLoadWithRequest", "external-link bridge");
requireText(app, "SafeAreaView", "safe-area layout");
forbidText(app, "Vibration", "haptic-free native wrapper");
forbidText(app, 'type: "haptic"', "haptic-free native bridge");
forbidText(app, 'navigator, "vibrate"', "haptic-free native bridge");
forbidText(app, 'url.startsWith("blob:")', "top-level blob navigation");
forbidText(app, 'url.startsWith("data:")', "top-level data navigation");
forbidText(app, '"blob:*"', "WebView origin allowlist");
forbidText(app, '"data:*"', "WebView origin allowlist");
forbidText(app, "Buffer.from", "native export memory duplication");
requireText(app, 'type: "purchase-remove-ads"', "native purchase intent");
requireText(app, 'type: "restore-remove-ads"', "native restore intent");
requireText(app, "readVerifiedRemoveAdsEntitlement()", "native entitlement reconciliation");
requireText(app, "finishVerifiedRemoveAdsPurchase(purchase)", "delivered transaction finish");
requireText(app, "removeAdsEntitlement === \"not-entitled\"", "native ad entitlement gate");
requireText(app, "removeAdsReconcileQueueRef.current.then(", "serialized StoreKit entitlement reconciliation");
requireText(app, "removeAdsDeliveryQueueRef.current.then(", "serialized StoreKit transaction delivery");
requireText(
  app,
  "const STOREKIT_CONNECTION_RETRY_DELAYS_MS = [0, 1000, 3000] as const;",
  "bounded StoreKit connection retry schedule",
);
requireText(
  app,
  "const STOREKIT_ENTITLEMENT_RETRY_DELAYS_MS = [0, 500, 2000] as const;",
  "bounded StoreKit entitlement retry schedule",
);
requireText(
  app,
  "for (const delay of STOREKIT_CONNECTION_RETRY_DELAYS_MS)",
  "StoreKit connection retry loop",
);
requireText(
  app,
  "for (const delay of STOREKIT_ENTITLEMENT_RETRY_DELAYS_MS)",
  "StoreKit entitlement retry loop",
);
requireText(app, "const ensureStoreConnection = () =>", "StoreKit reconnect gate");
const storeEffectStart = app.indexOf(
  "useEffect(() => {\n    let active = true;\n    let connectionTask",
);
const storeEffectEnd = app.indexOf(
  "\n\n  const ensureAdsInitialized = useCallback(",
  storeEffectStart,
);
const storeEffectSource = app.slice(storeEffectStart, storeEffectEnd);
const appStateRetryIndex = storeEffectSource.indexOf("AppState.addEventListener(");
const foregroundReconnectBranchIndex = storeEffectSource.indexOf(
  'if (active && state === "active")',
  appStateRetryIndex,
);
const foregroundReconnectCallIndex = storeEffectSource.indexOf(
  "void ensureStoreConnection();",
  foregroundReconnectBranchIndex,
);
const initialStoreConnectIndex = storeEffectSource.lastIndexOf(
  "void ensureStoreConnection();",
);
if (
  storeEffectStart < 0 ||
  storeEffectEnd <= storeEffectStart ||
  appStateRetryIndex < 0 ||
  foregroundReconnectBranchIndex <= appStateRetryIndex ||
  foregroundReconnectCallIndex <= foregroundReconnectBranchIndex ||
  initialStoreConnectIndex <= foregroundReconnectCallIndex
) {
  throw new Error(
    "StoreKit must install its foreground reconnect path before the initial connection attempt.",
  );
}
for (const [needle, label] of [
  ["if (!connectionTask) {", "single-flight StoreKit reconnect"],
  ["connectionTask = null;", "StoreKit reconnect task reset"],
  ["appStateSubscription.remove();", "StoreKit foreground-listener cleanup"],
  ["removeAdsStoreRef.current?.close();", "StoreKit connection cleanup"],
  ["removeAdsStoreRef.current = null;", "StoreKit connection reference cleanup"],
]) {
  requireText(storeEffectSource, needle, label);
}
const entitlementRetryStart = app.indexOf(
  "const reconcileRemoveAdsEntitlement = useCallback(",
);
const entitlementRetryEnd = app.indexOf(
  "\n\n  const deliverRemoveAdsPurchase = useCallback(",
  entitlementRetryStart,
);
const entitlementRetrySource = app.slice(
  entitlementRetryStart,
  entitlementRetryEnd,
);
requireText(
  entitlementRetrySource,
  'removeAdsEntitledRef.current ? "entitled" : "unknown"',
  "paid-user-preserving StoreKit retry exhaustion state",
);
requireText(app, 'purchase.purchaseState !== "purchased"', "non-purchased transaction rejection");
requireText(app, "isRemoveAdsAlreadyOwned(error)", "already-owned reconciliation");
requireText(app, "token: ++removeAdsActionSequenceRef.current", "purchase operation ownership token");
const purchaseActionStart = app.indexOf(
  "const beginRemoveAdsPurchase = useCallback(async () => {",
);
const purchaseActionEnd = app.indexOf(
  "\n\n  const beginRemoveAdsRestore = useCallback(async () => {",
  purchaseActionStart,
);
const purchaseActionSource = app.slice(purchaseActionStart, purchaseActionEnd);
const purchaseReservationIndex = purchaseActionSource.indexOf(
  "removeAdsActionRef.current = action;",
);
const purchaseLookupIndex = purchaseActionSource.indexOf(
  "await refreshRemoveAdsProduct()",
);
if (
  purchaseActionStart < 0 ||
  purchaseActionEnd <= purchaseActionStart ||
  purchaseReservationIndex < 0 ||
  purchaseLookupIndex <= purchaseReservationIndex
) {
  throw new Error(
    "Remove Ads must reserve its operation token before an asynchronous product lookup.",
  );
}
requireText(
  purchaseActionSource,
  "if (removeAdsActionRef.current !== action) return;",
  "post-lookup purchase operation ownership check",
);
requireText(
  app,
  "Consent gathering can fail when production starts offline.",
  "offline UMP gathering recovery",
);
requireText(
  app,
  'adStartupTransientFailureRef.current = true;\n        if (active) setConsentState("blocked");\n        return;',
  "fail-closed transient UMP startup marker",
);
forbidText(app, "entitlementGenerationRef", "stale-generation entitlement race");
forbidText(app, "removeAdsDeliveryRef", "transaction single-flight event drop");
requireText(app, "onLoadStart={() => setWebReady(false)}", "WebView runtime reload reset");
for (const priceLiteral of ["$4.99", "$9.99", "$12.99"]) {
  forbidText(app, priceLiteral, "hard-coded native App Store price");
  forbidText(purchase, priceLiteral, "hard-coded StoreKit fallback price");
}
for (const obsoletePurchasePath of [
  "EXPO_PUBLIC_QA_PURCHASES",
  "QA_PURCHASES",
  "resetQaPurchase",
  "react-native-iap",
]) {
  forbidText(app, obsoletePurchasePath, "obsolete or simulated purchase path");
  forbidText(purchase, obsoletePurchasePath, "obsolete or simulated purchase path");
}
requireText(
  purchase,
  'export const REMOVE_ADS_PRODUCT_ID = "remove_ads_lifetime";',
  "reviewed non-consumable product ID",
);
requireText(purchase, "currentEntitlementIOS(REMOVE_ADS_PRODUCT_ID)", "StoreKit current entitlement");
requireText(
  purchase,
  "isTransactionVerifiedIOS(REMOVE_ADS_PRODUCT_ID)",
  "StoreKit transaction verification",
);
requireText(purchase, "purchaseUpdatedListener(", "StoreKit transaction updates");
requireText(purchase, "purchaseErrorListener(", "StoreKit purchase errors");
requireText(purchase, "if (!connected) throw new Error", "failed StoreKit connection guard");
if (purchase.indexOf("purchaseUpdatedListener(") > purchase.indexOf("await initConnection()")) {
  throw new Error("StoreKit listeners must be registered before the connection is initialized.");
}
requireText(purchase, "restorePurchases()", "user-initiated StoreKit restore");
requireText(purchase, "product.displayPrice", "localized StoreKit display price");
requireText(purchase, 'candidate.platform === "ios"', "iOS product catalog gate");
requireText(purchase, 'candidate.typeIOS === "non-consumable"', "non-consumable product catalog gate");
requireText(purchase, 'purchase.store === "apple"', "Apple transaction gate");
requireText(
  purchase,
  "await finishTransaction({ purchase, isConsumable: false });",
  "non-consumable transaction finish",
);
forbidText(purchase, "SecureStore", "non-authoritative entitlement cache");
forbidText(purchase, "localStorage", "WebView entitlement persistence");

const deliveryStart = app.indexOf("const deliverRemoveAdsPurchase");
const deliveryEnd = app.indexOf("\n\n  useEffect(() => {", deliveryStart);
if (deliveryStart < 0 || deliveryEnd <= deliveryStart) {
  throw new Error("Could not inspect purchase delivery order.");
}
const deliverySource = app.slice(deliveryStart, deliveryEnd);
if (
  deliverySource.indexOf("reconcileRemoveAdsEntitlement()") < 0 ||
  deliverySource.indexOf("finishVerifiedRemoveAdsPurchase(purchase)") <
    deliverySource.indexOf("reconcileRemoveAdsEntitlement()")
) {
  throw new Error("A StoreKit transaction may be finished before verified delivery.");
}

const adGateStart = app.indexOf("  const startAdsIfAllowed = useCallback(");
const adGateEnd = app.indexOf("\n\n  const canAttemptBanner = useCallback(", adGateStart);
const adGateSource = app.slice(adGateStart, adGateEnd);
const bypassIndex = adGateSource.indexOf("if (testAds) {");
const bypassInitIndex = adGateSource.indexOf(
  "return ensureAdsInitialized();",
  bypassIndex,
);
const infoIndex = adGateSource.indexOf("AdsConsent.getConsentInfo()");
const infoFailureMatch = adGateSource
  .slice(infoIndex)
  .match(/}\s*catch(?:\s*\([^)]*\))?\s*{[\s\S]*?return false;/);
const infoFailureIndex =
  infoFailureMatch && typeof infoFailureMatch.index === "number"
    ? infoIndex + infoFailureMatch.index + infoFailureMatch[0].length
    : -1;
const rejectIndex = adGateSource.indexOf("!currentInfo.canRequestAds");
const initIndex = adGateSource.lastIndexOf("return ensureAdsInitialized();");
if (
  !(
    adGateStart >= 0 &&
    adGateEnd > adGateStart &&
    bypassIndex >= 0 &&
    bypassInitIndex > bypassIndex &&
    infoIndex > bypassIndex &&
    infoIndex > bypassInitIndex &&
    infoFailureIndex > infoIndex &&
    rejectIndex > infoFailureIndex &&
    initIndex > rejectIndex
  )
) {
  throw new Error(
    `Only test ads may bypass UMP; production must enforce canRequestAds before SDK initialization. ${JSON.stringify({
      adGateStart,
      adGateEnd,
      bypassIndex,
      bypassInitIndex,
      infoIndex,
      infoFailureIndex,
      rejectIndex,
      initIndex,
    })}`,
  );
}
forbidText(
  adGateSource,
  "reportedCanRequestAds",
  "caller-supplied UMP permission fallback",
);
forbidText(app, "reportedCanRequestAds", "caller-supplied UMP permission fallback");

const gatherIndex = app.indexOf("AdsConsent.gatherConsent()");
const gatherEffectIndex = app.lastIndexOf("useEffect(() => {", gatherIndex);
const gatherGateSource = app.slice(gatherEffectIndex, gatherIndex);
const sharedGateIndex = app.indexOf("startAdsIfAllowed()", gatherIndex);
if (
  gatherIndex < 0 ||
  gatherEffectIndex < 0 ||
  !gatherGateSource.includes("!legalReady") ||
  !gatherGateSource.includes('removeAdsEntitlement !== "not-entitled"') ||
  !gatherGateSource.includes('consentState !== "unresolved"') ||
  sharedGateIndex < gatherIndex
) {
  throw new Error("The initial UMP update does not gate SDK initialization.");
}
if (
  !gatherGateSource.includes("if (testAds)") ||
  !gatherGateSource.includes("startAdsIfAllowed()")
) {
  throw new Error(
    "The internal Google demo-ad path is not isolated from publisher UMP.",
  );
}
const testStart = gatherGateSource.indexOf("startAdsIfAllowed()");
const testReturn = gatherGateSource.indexOf("return;", testStart);
if (testStart < 0 || testReturn < testStart || gatherIndex < testReturn) {
  throw new Error("The test-ad path does not return before production UMP gathering.");
}
if ((app.match(/AdsConsent\.gatherConsent\(\)/g) || []).length !== 1) {
  throw new Error("UMP gathering must have one legal-gated entry point.");
}
if ((app.match(/startAdsIfAllowed\(/g) || []).length < 2) {
  throw new Error("Every UMP consent path must use the shared initialization gate.");
}
for (const match of app.matchAll(/startAdsIfAllowed\(([^)]*)\)/g)) {
  if (match[1].trim()) {
    throw new Error("The shared UMP gate must not accept caller-supplied permission state.");
  }
}


const trackingGateStart = app.indexOf("const resolveTrackingAuthorization");
const trackingGateEnd = app.indexOf("\n\n  const ensureAdsInitialized", trackingGateStart);
const trackingGateSource = app.slice(trackingGateStart, trackingGateEnd);
if (
  trackingGateStart < 0 ||
  trackingGateEnd <= trackingGateStart ||
  !trackingGateSource.includes("getTrackingPermissionsAsync()") ||
  !trackingGateSource.includes('current.status !== "undetermined"') ||
  !trackingGateSource.includes("requestTrackingPermissionsAsync()") ||
  !trackingGateSource.includes('result.status !== "undetermined"')
) {
  throw new Error("ATT must resolve every authorization outcome without treating denial as an app-functionality block.");
}
if ((app.match(/getTrackingPermissionsAsync\(\)/g) || []).length !== 1) {
  throw new Error("ATT status must have one shared read path.");
}
if ((app.match(/requestTrackingPermissionsAsync\(\)/g) || []).length !== 1) {
  throw new Error("ATT must have one shared request path.");
}
const initializationGateStart = app.indexOf("const ensureAdsInitialized");
const initializationGateEnd = app.indexOf("\n\n  const startAdsIfAllowed", initializationGateStart);
const initializationGateSource = app.slice(initializationGateStart, initializationGateEnd);
const trackingResolutionIndex = initializationGateSource.indexOf(
  "await resolveTrackingAuthorization()",
);
const requestConfigurationIndex = initializationGateSource.indexOf(
  "mobileAds().setRequestConfiguration",
);
const mobileAdsInitializationIndex = initializationGateSource.indexOf(
  "mobileAds().initialize()",
);
if (
  trackingResolutionIndex < 0 ||
  requestConfigurationIndex <= trackingResolutionIndex ||
  mobileAdsInitializationIndex <= requestConfigurationIndex
) {
  throw new Error("Google Mobile Ads configuration and initialization must remain behind resolved ATT.");
}

requireText(
  delegate,
  "publisherPrivacyPersonalizationState = .disabled",
  "global non-personalized treatment",
);
requireText(
  delegate,
  "setPublisherFirstPartyIDEnabled(false)",
  "publisher first-party ID treatment",
);
if (delegate.indexOf("configureAdvertisingPrivacy()") > delegate.indexOf("factory.startReactNative")) {
  throw new Error("Advertising privacy is configured after application startup.");
}

requireText(plist, expectedAppId, `Info.plist ${adProfile} app ID`);
if (!/<key>GADDelayAppMeasurementInit<\/key>\s*<true\s*\/>/.test(plist)) {
  throw new Error("Info.plist must delay Google app measurement until UMP permits ad requests.");
}
requireText(plist, "<key>SKAdNetworkItems</key>", "Info.plist SKAdNetwork list");
requireText(plist, "<key>NSUserTrackingUsageDescription</key>", "ATT usage-description key");
if (!/<key>CFBundleName<\/key>\s*<string>Grocery Benefits Tracker<\/string>/.test(plist)) {
  throw new Error("CFBundleName must use the generic public product identity.");
}
requireText(plist, "Your permission allows this app and its advertising partners to use a device identifier to measure non-personalized ads. Denying permission does not limit app features.", "base ATT usage description");
requireText(englishInfoPlist, "NSUserTrackingUsageDescription = \"Your permission allows this app and its advertising partners to use a device identifier to measure non-personalized ads. Denying permission does not limit app features.\";", "English ATT localization");
requireText(spanishInfoPlist, "NSUserTrackingUsageDescription = \"Tu permiso permite que esta app y sus socios publicitarios usen un identificador del dispositivo para medir anuncios no personalizados. Negarte no limita las funciones de la app.\";", "Spanish ATT localization");
if (!/<key>NSPrivacyTracking<\/key>\s*<false\s*\/>/.test(privacyManifest)) {
  throw new Error("The app-owned privacy manifest must not claim SDK-owned tracking.");
}
forbidText(privacyManifest, "NSPrivacyTrackingDomains", "app-owned tracking domains");
forbidText(privacyManifest, "NSPrivacyCollectedDataTypes", "SDK collection rows in the app-owned manifest");
forbidText(plist, "WKAppBoundDomains", "Google Mobile Ads compatibility");

const skadIds = skadText.split(/\r?\n/).filter(Boolean);
if (skadIds.length !== 50 || new Set(skadIds).size !== skadIds.length) {
  throw new Error(`Expected 50 unique SKAdNetwork IDs; found ${skadIds.length}.`);
}
for (const skadId of skadIds) requireText(plist, skadId, "Info.plist SKAdNetwork list");

const parsedPackage = JSON.parse(packageJson);
const parsedLock = JSON.parse(packageLock);
if (parsedPackage.dependencies?.["react-native-webview"] !== "14.0.1") {
  throw new Error("react-native-webview must stay pinned to 14.0.1.");
}
if (parsedPackage.dependencies?.["react-native-google-mobile-ads"] !== "16.4.0") {
  throw new Error("react-native-google-mobile-ads must stay pinned to 16.4.0.");
}
if (parsedPackage.dependencies?.["expo-notifications"] !== "~57.0.10") {
  throw new Error("expo-notifications must stay compatible with Expo 57.");
}
if (parsedPackage.dependencies?.["expo-iap"] !== "5.2.4") {
  throw new Error("expo-iap must be an exact 5.2.4 runtime dependency.");
}
if (parsedPackage.dependencies?.["expo-tracking-transparency"] !== "~57.0.0") {
  throw new Error("expo-tracking-transparency must stay compatible with Expo 57.");
}
if (parsedLock.packages?.["node_modules/expo-tracking-transparency"]?.version !== "57.0.1") {
  throw new Error("The lockfile must pin expo-tracking-transparency 57.0.1.");
}
if (parsedLock.packages?.["node_modules/expo-iap"]?.version !== "5.2.4") {
  throw new Error("The lockfile must pin expo-iap 5.2.4.");
}
if (
  parsedPackage.dependencies?.["react-native-iap"] ||
  parsedPackage.devDependencies?.["react-native-iap"] ||
  parsedLock.packages?.["node_modules/react-native-iap"]
) {
  throw new Error("The obsolete react-native-iap package must not be shipped.");
}
for (const noticeGate of [
  "Pods-SNAPEBTGroceryTrackerQA-acknowledgements.markdown",
  'const marker = "iOS CocoaPods acknowledgements (generated from Podfile.lock)";',
  'for (const component of ["openiap"])',
  'npmNotices.includes("expo-iap@5.2.4")',
  'npmNotices.includes("expo-tracking-transparency@57.0.1")',
  'writeFileSync(noticePath, combinedNotices)',
  'writeFileSync(\n  sourcePath,',
]) {
  requireText(iosNotices, noticeGate, "final iOS third-party notices");
}

const appConfig = JSON.parse(await read("app.json"));
if (appConfig?.expo?.name !== "Grocery Benefits Tracker") {
  throw new Error("The public Expo app name must be Grocery Benefits Tracker.");
}
const configuredPlugins = appConfig?.expo?.plugins || [];
let expoIapPluginCount = 0;
for (const plugin of configuredPlugins) {
  const pluginName = Array.isArray(plugin) ? plugin[0] : plugin;
  if (pluginName === "expo-iap") expoIapPluginCount += 1;
  if (pluginName === "react-native-iap") {
    throw new Error("The obsolete react-native-iap config plugin must not be configured.");
  }
}
if (expoIapPluginCount !== 1) {
  throw new Error(`Expected exactly one expo-iap config plugin; found ${expoIapPluginCount}.`);
}
if (parsedLock.packages?.["node_modules/react-native-google-mobile-ads"]?.version !== "16.4.0") {
  throw new Error("The lockfile does not pin react-native-google-mobile-ads 16.4.0.");
}
if (parsedLock.packages?.["node_modules/expo-notifications"]?.version !== "57.0.10") {
  throw new Error("The lockfile does not pin expo-notifications 57.0.10.");
}

const iconBytes = Buffer.from(iconBase64.replace(/\s/g, ""), "base64");
if (sha256(iconBytes) !== EXPECTED_ICON_SHA256) {
  throw new Error("The reviewed App Store icon digest changed.");
}
if (sha256(brandLogo) !== EXPECTED_BRAND_LOGO_SHA256) {
  throw new Error("The reviewed in-app brand logo digest changed.");
}
if (sha256(brandMaster) !== EXPECTED_BRAND_MASTER_SHA256) {
  throw new Error("The exact user-supplied brand master digest changed.");
}
if (!iconBytes.equals(brandLogo)) {
  throw new Error("The App Store icon and in-app brand image must use the same reviewed derivative.");
}

console.log(
  `Release checks passed for the ${adProfile} profile: ${scripts.length} scripts, ${skadIds.length} SKAdNetwork IDs, verified StoreKit Remove Ads entitlement, localized ATT before Google Mobile Ads, one fixed NPA banner with production UMP fail-closed, Benefits & Resources removed, and file/link/reminder bridges.`,
);
