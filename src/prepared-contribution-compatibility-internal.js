import {
  createLocalPreparedContributionContext,
} from "./application/local-prepared-contribution.js";
import {
  createOwnerOnlyPreparedContributionStorageContext,
} from "./platform/owner-only-prepared-contribution-storage.js";

export const preparedContributionStorage =
  createOwnerOnlyPreparedContributionStorageContext();

export const preparedContributionContext =
  createLocalPreparedContributionContext({
    storage: preparedContributionStorage,
    sha256Hex: preparedContributionStorage.sha256Hex,
  });
