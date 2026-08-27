import {
  ErrorCode,
  currentEntitlementIOS,
  endConnection,
  fetchProducts,
  finishTransaction,
  initConnection,
  isTransactionVerifiedIOS,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  restorePurchases,
} from "expo-iap";
import type {
  ExpoPurchaseError,
  Purchase,
  PurchaseIOS,
} from "expo-iap";

export const REMOVE_ADS_PRODUCT_ID = "remove_ads_lifetime";
export const EXPECTED_REMOVE_ADS_USD_PRICE = 9.99;

const RESTORE_ENTITLEMENT_SETTLE_DELAYS_MS = [0, 400, 1200, 2400] as const;

export type RemoveAdsProduct = {
  displayName: string;
  displayPrice: string;
  description: string;
  currency: string;
  price: number | null;
  expectedUsdPrice: number;
  priceMatchesExpected: boolean | null;
};

export type RemoveAdsStoreListeners = {
  onPurchaseUpdated: (purchase: Purchase) => void;
  onPurchaseError: (error: ExpoPurchaseError) => void;
};

export type RemoveAdsStoreConnection = {
  close: () => void;
};

export type VerifiedRemoveAdsEntitlement = {
  entitled: boolean;
  purchase: PurchaseIOS | null;
};

type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  onRetry?: (error: unknown, nextAttempt: number) => void;
};

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 3));
  const baseDelayMs = Math.max(0, Math.trunc(options.baseDelayMs ?? 500));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      options.onRetry?.(error, attempt + 1);
      await wait(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("StoreKit operation failed after retrying");
}

function isUsableEntitlement(
  purchase: PurchaseIOS | null,
  verified: boolean,
): purchase is PurchaseIOS {
  return Boolean(
    verified &&
      purchase &&
      purchase.store === "apple" &&
      purchase.productId === REMOVE_ADS_PRODUCT_ID &&
      purchase.purchaseState === "purchased" &&
      !purchase.revocationDateIOS,
  );
}

function expectedPriceNumber(expectedPrice: string) {
  const normalized = expectedPrice.trim().replace(/[^0-9.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : EXPECTED_REMOVE_ADS_USD_PRICE;
}

export async function connectRemoveAdsStore(
  listeners: RemoveAdsStoreListeners,
): Promise<RemoveAdsStoreConnection> {
  const updateSubscription = purchaseUpdatedListener(
    listeners.onPurchaseUpdated,
  );
  const errorSubscription = purchaseErrorListener(listeners.onPurchaseError);
  try {
    const connected = await initConnection();
    if (!connected) throw new Error("StoreKit connection was not established");
  } catch (error) {
    updateSubscription.remove();
    errorSubscription.remove();
    throw error;
  }
  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      updateSubscription.remove();
      errorSubscription.remove();
      void endConnection().catch((error) => {
        console.warn("StoreKit connection cleanup failed", error);
      });
    },
  };
}

export async function fetchRemoveAdsProductWithValidation(
  expectedPrice: string,
): Promise<RemoveAdsProduct | null> {
  const products = await fetchProducts({
    skus: [REMOVE_ADS_PRODUCT_ID],
    type: "in-app",
  });
  const product = (products || []).find(
    (candidate) =>
      candidate.id === REMOVE_ADS_PRODUCT_ID &&
      candidate.platform === "ios" &&
      candidate.type === "in-app" &&
      candidate.typeIOS === "non-consumable",
  );
  if (!product?.displayPrice) return null;

  const expectedUsdPrice = expectedPriceNumber(expectedPrice);
  const price = typeof product.price === "number" ? product.price : null;
  const currency = String(product.currency || "").toUpperCase();

  // StoreKit always owns the customer-facing localized price. Only compare the
  // numeric price when StoreKit says this storefront is USD. A Canadian tester
  // can legitimately see a localized Canadian price for a USD 9.99 base price,
  // so comparing the raw display string would create a false production alarm.
  const priceMatchesExpected =
    currency === "USD" && price !== null
      ? Math.abs(price - expectedUsdPrice) < 0.005
      : null;

  if (priceMatchesExpected === false) {
    console.warn(
      `[IAP PRICE MISMATCH] ${REMOVE_ADS_PRODUCT_ID} returned ${product.displayPrice} ` +
        `(${currency} ${price}) but the intended U.S. price is USD ${expectedUsdPrice.toFixed(2)}. ` +
        "Check App Store Connect before release. The purchase remains available because StoreKit is authoritative.",
    );
  }

  return {
    displayName:
      product.displayName?.trim() || product.title?.trim() || "Remove Ads Forever",
    displayPrice: product.displayPrice,
    description: product.description?.trim() || "",
    currency,
    price,
    expectedUsdPrice,
    priceMatchesExpected,
  };
}

export async function fetchRemoveAdsProduct(): Promise<RemoveAdsProduct | null> {
  const configuredExpectedPrice =
    process.env.EXPO_PUBLIC_REMOVE_ADS_EXPECTED_USD_PRICE?.trim() || "9.99";
  return fetchRemoveAdsProductWithValidation(configuredExpectedPrice);
}

export async function readVerifiedRemoveAdsEntitlement(): Promise<VerifiedRemoveAdsEntitlement> {
  const purchase = await currentEntitlementIOS(REMOVE_ADS_PRODUCT_ID);
  if (!purchase) return { entitled: false, purchase: null };
  const verified = await isTransactionVerifiedIOS(REMOVE_ADS_PRODUCT_ID);
  return isUsableEntitlement(purchase, verified)
    ? { entitled: true, purchase }
    : { entitled: false, purchase: null };
}

export async function requestRemoveAdsPurchase(): Promise<void> {
  await requestPurchase({
    request: {
      apple: {
        sku: REMOVE_ADS_PRODUCT_ID,
        andDangerouslyFinishTransactionAutomatically: false,
      },
    },
    type: "in-app",
  });
}

export async function restoreRemoveAdsPurchase(): Promise<void> {
  // Keep the full-lifetime purchaseUpdated listener as the primary delivery
  // path, but allow StoreKit a short bounded settle window before App.tsx
  // concludes that no entitlement exists. On physical devices the restored
  // transaction callback/current entitlement can arrive shortly after the
  // restore request itself resolves. This avoids a false "none found" result
  // without ever granting entitlement speculatively.
  await restorePurchases();

  let lastReadError: unknown = null;
  for (const delay of RESTORE_ENTITLEMENT_SETTLE_DELAYS_MS) {
    if (delay > 0) await wait(delay);
    try {
      const entitlement = await readVerifiedRemoveAdsEntitlement();
      if (entitlement.entitled) return;
      lastReadError = null;
    } catch (error) {
      lastReadError = error;
    }
  }

  // A clean sequence of non-entitled reads means there simply was no restored
  // Remove Ads purchase; App.tsx performs its normal final reconciliation and
  // reports that result. If StoreKit itself could not be read, surface the last
  // error so the UI reports a restore failure rather than a false "none".
  if (lastReadError) throw lastReadError;
}

export async function finishVerifiedRemoveAdsPurchase(
  purchase: Purchase,
): Promise<void> {
  // The entitlement is applied by App.tsx before this function is called. If
  // StoreKit finishing fails transiently, retry it here; otherwise StoreKit will
  // replay the unfinished transaction on a later launch.
  await withRetry(
    async () => {
      await finishTransaction({ purchase, isConsumable: false });
    },
    {
      attempts: 3,
      baseDelayMs: 500,
      onRetry: (error, nextAttempt) => {
        console.warn(
          `StoreKit finishTransaction failed; retrying attempt ${nextAttempt}/3`,
          error,
        );
      },
    },
  );
}

export function removeAdsPurchaseErrorCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
  return code;
}

export function isRemoveAdsPurchaseCancelled(error: unknown): boolean {
  return removeAdsPurchaseErrorCode(error) === ErrorCode.UserCancelled;
}

export function isRemoveAdsAlreadyOwned(error: unknown): boolean {
  return removeAdsPurchaseErrorCode(error) === ErrorCode.AlreadyOwned;
}

export function isRemoveAdsPurchasePending(error: unknown): boolean {
  const code = removeAdsPurchaseErrorCode(error);
  return code === ErrorCode.Pending || code === ErrorCode.DeferredPayment;
}

export function isRemoveAdsPurchaseEvent(purchase: Purchase): boolean {
  return (
    purchase.store === "apple" &&
    purchase.productId === REMOVE_ADS_PRODUCT_ID
  );
}
