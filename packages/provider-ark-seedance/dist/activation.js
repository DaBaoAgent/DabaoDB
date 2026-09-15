import { createRuntimeEndpointAdapterFacet, runtimeConfigCredentialRef, runtimeConfigExact, runtimeConfigObject, runtimeConfigPositiveInteger, runtimeConfigString, } from "@hypit/hypit/runtime-kit";
import { arkModelByCapability, createArkSeedanceProvider, providerModule } from "./provider.js";
const CONFIG_FIELDS = [
    "baseUrl", "apiKey", "capability", "arkModel", "watermark", "concurrency", "pollIntervalMs",
];
export default {
    format: "hypit.node-package@1",
    hostFacets: [createRuntimeEndpointAdapterFacet({
            use: providerModule.name,
            activate(context) {
                const config = runtimeConfigObject(context.config, "Ark Seedance");
                runtimeConfigExact(config, [...CONFIG_FIELDS], "Ark Seedance");
                const baseUrl = runtimeConfigString(config.baseUrl, "Ark baseUrl")
                    ?? "https://ark.cn-beijing.volces.com/api/v3";
                const apiKey = runtimeConfigCredentialRef(config.apiKey, "Ark apiKey");
                const requested = runtimeConfigString(config.capability, "Ark capability") ?? "seedance-2-mini";
                if (!(requested in arkModelByCapability)) {
                    throw new Error(`Ark capability must be one of ${Object.keys(arkModelByCapability).join(", ")}`);
                }
                const capabilityName = requested;
                if (!apiKey || !context.pool)
                    throw new Error("Ark Seedance requires apiKey and pool");
                const watermark = config.watermark;
                if (watermark !== undefined && typeof watermark !== "boolean")
                    throw new Error("Ark watermark must be a boolean");
                return {
                    endpoint: createArkSeedanceProvider({
                        instance: context.instance,
                        pool: context.pool,
                        baseUrl,
                        capabilityName,
                        arkModel: runtimeConfigString(config.arkModel, "Ark model") ?? arkModelByCapability[capabilityName],
                        ...(watermark === undefined ? {} : { watermark }),
                        concurrency: runtimeConfigPositiveInteger(config.concurrency, "concurrency") ?? 2,
                        pollIntervalMs: runtimeConfigPositiveInteger(config.pollIntervalMs, "pollIntervalMs") ?? 5_000,
                    }),
                };
            },
        })],
};
