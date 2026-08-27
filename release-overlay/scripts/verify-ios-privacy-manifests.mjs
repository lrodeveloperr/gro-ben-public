#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EXPECTED_VENDOR_MANIFEST_SHA256 = Object.freeze({
  GoogleMobileAds: "69fb112582fc23fc06c635c961d262a3f7b4b5654d284787491de3000dadf9d2",
  UserMessagingPlatform: "45b7adb99fcd2d962a1c800fbfcc1325b57a7fa4165f416182323bb5ffe9c900",
});
const EXPECTED_GMA_DEVICE_ID_PURPOSES = Object.freeze([
  "NSPrivacyCollectedDataTypePurposeAnalytics",
  "NSPrivacyCollectedDataTypePurposeDeveloperAdvertising",
  "NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising",
]);

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) {
    throw new Error("Arguments must be supplied as --name value pairs.");
  }
  values.set(key.slice(2), value);
}

const appManifestPath = values.get("app-manifest");
const sdkRoot = values.get("sdk-root");
const bundleRoot = values.get("bundle-root");
const reportPath = values.get("report");
if (!appManifestPath || !sdkRoot || !reportPath) {
  throw new Error("--app-manifest, --sdk-root, and --report are required.");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalized = (value) => value.split(path.sep).join("/");

async function walk(root) {
  const found = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name === "PrivacyInfo.xcprivacy") {
        found.push(candidate);
      }
    }
  }
  await visit(root);
  return found.sort();
}

function parsePlist(file) {
  execFileSync("/usr/bin/plutil", ["-lint", file], { stdio: "pipe" });
  const output = execFileSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", file],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

function componentFor(file) {
  if (path.resolve(file) === path.resolve(appManifestPath)) {
    return "AppOwned";
  }
  if (/Google(?:-Mobile-Ads-SDK|MobileAds)/i.test(file)) {
    return "GoogleMobileAds";
  }
  if (/GoogleUserMessagingPlatform|UserMessagingPlatform/i.test(file)) {
    return "UserMessagingPlatform";
  }
  return "Unclassified";
}

function validateTrackingShape(document, label) {
  const domains = document.NSPrivacyTrackingDomains;
  if (domains !== undefined && !Array.isArray(domains)) {
    throw new Error(`${label}: NSPrivacyTrackingDomains must be an array.`);
  }
  if (document.NSPrivacyTracking === true) {
    if (!domains || domains.length === 0) {
      throw new Error(`${label}: NSPrivacyTracking=true requires nonempty NSPrivacyTrackingDomains.`);
    }
  } else if (domains && domains.length > 0) {
    throw new Error(`${label}: nonempty tracking domains require NSPrivacyTracking=true.`);
  }
  for (const domain of domains || []) {
    if (
      typeof domain !== "string" ||
      domain.length === 0 ||
      domain !== domain.toLowerCase() ||
      domain.includes("/") ||
      domain.includes("?") ||
      domain.includes("#") ||
      domain.includes(":") ||
      !domain.includes(".")
    ) {
      throw new Error(`${label}: malformed tracking domain in privacy manifest.`);
    }
  }
}

function summarize(document) {
  return {
    tracking: document.NSPrivacyTracking === true,
    trackingDomains: [...(document.NSPrivacyTrackingDomains || [])].sort(),
    collectedDataTypes: (document.NSPrivacyCollectedDataTypes || []).map((entry) => ({
      dataType: entry.NSPrivacyCollectedDataType,
      linked: entry.NSPrivacyCollectedDataTypeLinked === true,
      tracking: entry.NSPrivacyCollectedDataTypeTracking === true,
      purposes: [...(entry.NSPrivacyCollectedDataTypePurposes || [])].sort(),
    })),
    accessedAPITypes: (document.NSPrivacyAccessedAPITypes || []).map((entry) => ({
      apiType: entry.NSPrivacyAccessedAPIType,
      reasons: [...(entry.NSPrivacyAccessedAPITypeReasons || [])].sort(),
    })),
  };
}

async function inventory(root, scope) {
  const entries = [];
  for (const file of await walk(root)) {
    const component = componentFor(file);
    const relativePath = normalized(path.relative(root, file));
    const document = parsePlist(file);
    validateTrackingShape(document, `${scope} ${relativePath}`);
    const digest = sha256(await readFile(file));
    if (
      Object.prototype.hasOwnProperty.call(
        EXPECTED_VENDOR_MANIFEST_SHA256,
        component,
      ) &&
      digest !== EXPECTED_VENDOR_MANIFEST_SHA256[component]
    ) {
      throw new Error(`${scope}: unexpected ${component} privacy-manifest hash ${digest}.`);
    }
    entries.push({
      scope,
      component,
      classified: component !== "Unclassified",
      relativePath,
      sha256: digest,
      ...summarize(document),
    });
  }
  for (const component of ["GoogleMobileAds", "UserMessagingPlatform"]) {
    if (!entries.some((entry) => entry.component === component)) {
      throw new Error(`${scope}: ${component} privacy manifest was not found.`);
    }
  }
  for (const entry of entries.filter((item) => item.component === "GoogleMobileAds")) {
    const deviceID = entry.collectedDataTypes.find(
      (item) => item.dataType === "NSPrivacyCollectedDataTypeDeviceID",
    );
    if (
      !deviceID ||
      !deviceID.linked ||
      !deviceID.tracking ||
      JSON.stringify(deviceID.purposes) !==
        JSON.stringify(EXPECTED_GMA_DEVICE_ID_PURPOSES)
    ) {
      throw new Error(
        `${scope}: GoogleMobileAds Device ID tracking disclosure changed.`,
      );
    }
    if (entry.tracking || entry.trackingDomains.length > 0) {
      throw new Error(
        `${scope}: GoogleMobileAds 13.5.0 unexpectedly gained top-level tracking domains.`,
      );
    }
  }
  const unclassifiedPaths = entries
    .filter((entry) => !entry.classified)
    .map((entry) => entry.relativePath);
  if (unclassifiedPaths.length > 0) {
    console.warn(
      `${scope}: included ${unclassifiedPaths.length} unclassified privacy manifests: ${unclassifiedPaths.join(", ")}`,
    );
  }
  return entries;
}

const appDocument = parsePlist(appManifestPath);
if (appDocument.NSPrivacyTracking !== false) {
  throw new Error("The app-owned privacy manifest must set NSPrivacyTracking=false.");
}
if ("NSPrivacyTrackingDomains" in appDocument) {
  throw new Error("The app-owned privacy manifest must not list SDK tracking domains.");
}
if ("NSPrivacyCollectedDataTypes" in appDocument) {
  throw new Error("The app-owned privacy manifest must not duplicate SDK collection rows.");
}
validateTrackingShape(appDocument, `app-owned ${normalized(appManifestPath)}`);

const installed = await inventory(sdkRoot, "installed");
const packaged = bundleRoot ? await inventory(bundleRoot, "packaged") : [];
const allManifestEntries = [...installed, ...packaged];
const vendorEntries = allManifestEntries.filter(
  (entry) => entry.component !== "AppOwned",
);
const report = {
  appOwnedManifest: {
    relativePath: path.basename(appManifestPath),
    sha256: sha256(await readFile(appManifestPath)),
    ...summarize(appDocument),
  },
  installed,
  packaged,
  inventory: {
    installedManifestCount: installed.length,
    packagedManifestCount: packaged.length,
    unclassifiedInstalledPaths: installed
      .filter((entry) => !entry.classified)
      .map((entry) => entry.relativePath),
    unclassifiedPackagedPaths: packaged
      .filter((entry) => !entry.classified)
      .map((entry) => entry.relativePath),
  },
  aggregate: {
    tracking: allManifestEntries.some(
      (entry) =>
        entry.tracking || entry.collectedDataTypes.some((item) => item.tracking),
    ),
    deviceIDLinkedAndUsedForTracking: allManifestEntries.some((entry) =>
      entry.collectedDataTypes.some(
        (item) =>
          item.dataType === "NSPrivacyCollectedDataTypeDeviceID" &&
          item.linked &&
          item.tracking,
      ),
    ),
    topLevelTrackingDomainsDeclaredByVendor: vendorEntries.some(
      (entry) => entry.trackingDomains.length > 0,
    ),
    trackingDomains: [
      ...new Set(allManifestEntries.flatMap((entry) => entry.trackingDomains)),
    ].sort(),
    collectedDataTypes: [
      ...new Set(
        allManifestEntries.flatMap((entry) =>
          entry.collectedDataTypes.map((item) => item.dataType),
        ),
      ),
    ].sort(),
  },
  appStoreConnectLabelReconciliationRequired: true,
};

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Privacy manifest verification passed: app-owned tracking=false; exact Google/UMP manifest hashes and GoogleMobileAds Device ID tracking semantics verified across ${installed.length} installed and ${packaged.length} packaged manifests.`,
);
console.log(JSON.stringify(report, null, 2));
