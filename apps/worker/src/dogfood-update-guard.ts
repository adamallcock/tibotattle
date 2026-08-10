import dogfoodSparkleReleaseContract from "./dogfood-sparkle-release-contract.json";
import { ApiError, errorResponse } from "./errors";
import { handleSparkleAppcastGuardForContract } from "./sparkle-appcast-guard";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleSparkleAppcastGuardForContract(
        request,
        env,
        dogfoodSparkleReleaseContract,
      );
    } catch (error) {
      const requestId = crypto.randomUUID();
      if (error instanceof ApiError) return errorResponse(error, requestId);
      return errorResponse(new ApiError(500, "INTERNAL_ERROR"), requestId);
    }
  },
};
