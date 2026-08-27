const TEST_ANDROID_APP_ID = "ca-app-pub-3940256099942544~3347511713";
const TEST_IOS_APP_ID = "ca-app-pub-3940256099942544~1458002511";
const TEST_IOS_BANNER_ID = "ca-app-pub-3940256099942544/2934735716";
const GOOGLE_TEST_PUBLISHER_ID = "3940256099942544";

const IOS_PRODUCTION_KEYS = [
  "EXPO_PUBLIC_ADMOB_PUBLISHER_ID",
  "EXPO_PUBLIC_IOS_ADMOB_APP_ID",
  "EXPO_PUBLIC_IOS_ADMOB_BANNER_ID",
];

function qaTestDeviceIdentifiers() {
  return String(process.env.EXPO_PUBLIC_QA_ADMOB_TEST_DEVICE_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    // RN's "EMULATOR" token is useful from JavaScript, but native iOS
    // simulators are already test devices and should not receive that token.
    .filter((value) => value.toUpperCase() !== "EMULATOR");
}

module.exports = ({ config }) => {
  const profile = process.env.EXPO_PUBLIC_BUILD_PROFILE || "qa";
  const production = profile === "production";
  const qaIosBannerId = String(
    process.env.EXPO_PUBLIC_QA_IOS_ADMOB_BANNER_ID || TEST_IOS_BANNER_ID,
  ).trim();
  const qaDeviceIds = qaTestDeviceIdentifiers();

  if (production) {
    const missing = IOS_PRODUCTION_KEYS.filter((key) => !process.env[key]);
    if (missing.length) {
      throw new Error(
        `Production iOS AdMob configuration rejected. Missing: ${missing.join(", ")}.`,
      );
    }

    const publisherId = String(
      process.env.EXPO_PUBLIC_ADMOB_PUBLISHER_ID || "",
    ).trim();
    const iosAppId = String(
      process.env.EXPO_PUBLIC_IOS_ADMOB_APP_ID || "",
    ).trim();
    const iosBannerId = String(
      process.env.EXPO_PUBLIC_IOS_ADMOB_BANNER_ID || "",
    ).trim();
    const appMatch = iosAppId.match(/^ca-app-pub-(\d{16})~(\d{10})$/);
    const bannerMatch = iosBannerId.match(/^ca-app-pub-(\d{16})\/(\d{10})$/);

    if (
      publisherId === GOOGLE_TEST_PUBLISHER_ID ||
      !/^\d{16}$/.test(publisherId) ||
      appMatch?.[1] !== publisherId ||
      bannerMatch?.[1] !== publisherId
    ) {
      throw new Error(
        "Production iOS AdMob identifiers are malformed, test-owned, or publisher-mismatched.",
      );
    }

    if (process.env.EXPO_PUBLIC_QA_PURCHASES === "1") {
      throw new Error("Production builds cannot enable simulated purchases.");
    }
  } else if (!/^ca-app-pub-\d{16}\/\d{10}$/.test(qaIosBannerId)) {
    throw new Error(
      "QA iOS AdMob banner ID is malformed. Leave EXPO_PUBLIC_QA_IOS_ADMOB_BANNER_ID blank to use Google's official test banner ID.",
    );
  }

  const androidAppId = production
    ? config.plugins
        ?.find(
          (plugin) =>
            Array.isArray(plugin) &&
            plugin[0] === "react-native-google-mobile-ads",
        )?.[1]?.androidAppId
    : TEST_ANDROID_APP_ID;
  const iosAppId = production
    ? process.env.EXPO_PUBLIC_IOS_ADMOB_APP_ID
    : TEST_IOS_APP_ID;
  const qaSuffix = production ? "" : ".qa";

  return {
    ...config,
    name: production ? config.name : `${config.name} QA`,
    android: {
      ...config.android,
      package: `${config.android.package}${qaSuffix}`,
    },
    ios: {
      ...config.ios,
      bundleIdentifier: `${config.ios.bundleIdentifier}${qaSuffix}`,
      infoPlist: {
        ...(config.ios?.infoPlist || {}),
        // AppDelegate reads these before React Native initializes AdMob.
        // Production always receives an empty test-device list so a release
        // build cannot accidentally remain in test mode.
        GBTAdMobBuildProfile: profile,
        GBTAdMobTestDeviceIdentifiers: production ? [] : qaDeviceIds,
      },
    },
    extra: {
      ...(config.extra || {}),
      buildProfile: profile,
      qaIosAdMobBannerId: production ? null : qaIosBannerId,
      qaAdMobTestDeviceIds: production ? [] : qaDeviceIds,
      expectedRemoveAdsUsdPrice:
        process.env.EXPO_PUBLIC_REMOVE_ADS_EXPECTED_USD_PRICE || "9.99",
    },
    plugins: (config.plugins || []).map((plugin) => {
      if (
        !Array.isArray(plugin) ||
        plugin[0] !== "react-native-google-mobile-ads"
      ) {
        return plugin;
      }
      return [plugin[0], { ...plugin[1], androidAppId, iosAppId }];
    }),
  };
};
