export declare const providerModule: {
    readonly name: "@volcengine/provider-ark-seedance";
    readonly version: "1";
};
/** Ark model id per Hypit capability name. Kept in one place so the Profile only names a variant. */
export declare const arkModelByCapability: {
    readonly "seedance-2": "doubao-seedance-2-0-260128";
    readonly "seedance-2-fast": "doubao-seedance-2-0-fast-260128";
    readonly "seedance-2-mini": "doubao-seedance-2-0-mini-260615";
    readonly "seedance-2.5": "doubao-seedance-2-5-260628";
};
export type ArkCapabilityName = keyof typeof arkModelByCapability;
export declare function createArkSeedanceProvider(options: {
    instance: string;
    pool: string;
    baseUrl: string;
    arkModel: string;
    capabilityName: ArkCapabilityName;
    watermark?: boolean;
    concurrency?: number;
    pollIntervalMs?: number;
    fetch?: typeof globalThis.fetch;
}): import("@hypit/hypit/endpoint-kit").EndpointPackage;
