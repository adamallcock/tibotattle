/**
 * Build-time PostgreSQL migration receipt expected by the Worker runtime.
 *
 * The migration runner owns applying SQL fragments. The application still
 * needs a source-owned admission fence so a host cannot point an older
 * reader at a missing, newer, or checksum-drifted schema and begin a write.
 * Keep this small manifest in product code instead of importing the Node-only
 * migration script or reading the filesystem from a Worker.
 */

export interface PostgresRuntimeMigrationReceipt {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
}

export const POSTGRES_RUNTIME_SCHEMA_VERSION =
  "tibotattle-postgres-migration-manifest-v2" as const;

type MigrationEntry = readonly [name: string, sha256: string];

function receipt(
  entry: readonly [string, string],
  version: number,
): PostgresRuntimeMigrationReceipt {
  const [name, sha256] = entry;
  return Object.freeze({ version, name, sha256 });
}

export const POSTGRES_RUNTIME_MIGRATIONS: Readonly<{
  readonly primary: readonly PostgresRuntimeMigrationReceipt[];
}> = Object.freeze({
  primary: Object.freeze(([
    ["0001_schema_metadata.sql", "2bcf95c2954d3194696d24574d916391bf09525bf6951d7f6a825f5beb70efb2"],
    ["0002_authority_identity.sql", "06f12e6993d814b748577432c4c5a5ebeb25f5ea1f4843911815a73607e17160"],
    ["0003_device_and_enrollment_authority.sql", "62319ef5c7902800564368ce0ddf551907411412718d84bf798f634227d4493b"],
    ["0004_telemetry_v1_ingest.sql", "45c611d5c3e9cdcf07fe37887f15e74bdf2568c880b286e0667450e77f1a45c3"],
    ["0005_telemetry_v11_transport_and_domain.sql", "bb939ab3d6355c4021c4a3a8eb689fd377e73a074d738408e42e0de03dc76c76"],
    ["0006_telemetry_v12_usage_quota_session.sql", "48485a8929f177a9cda22333ed93e2a7a073ede8fd3ae0cbfbfd9f124e209d50"],
    ["0007_analytics_lifecycle.sql", "b5bcf7f33cb9c046def75dae34a6789a411b417859433440d6ae71623d23af10"],
    ["0008_pending_object_reconciliation.sql", "c43fc6b4ef4b1592a60798a50eddf683973a10df6844aa42a7c88b351ea3ce7e"],
    ["0009_owner_scoped_analytics.sql", "c5a936af6132bb903f14e1bfb739f8a74e26e98ce96f1a4fb40ce9ad83577253"],
    ["0010_v1_analytical_side_effects.sql", "60a5a159610bb4e627382a0ac4ae4292e78e75bd269b67fbc91f70d0f88c62e5"],
    ["0011_retained_telemetry.sql", "3ae149ee1c907cd548458c0c23627a0509c19d45bdd1fc7b0e97dd9cfbdc8aa7"],
    ["0012_provider_preparation.sql", "3c1a5fcf9ede24f3380bd90257695c01cd89e0d5571c0e7811e2f33eb9a8c0e2"],
    ["0013_postgres_runtime_guards.sql", "c2bb4e8ac5d4b802d5457f1aaf1d9cc2afc33836d2bbd4dfbc851f016bb9c20f"],
    ["0014_effective_source_revision.sql", "ad124ecdc7b008e18c11a7faf45886c666b7ca42b40322089d597641a515ed3c"],
    ["0015_enrollment_grants.sql", "7b362f377b3b9e2dbb671d18db61e09d05cf2bcc70c1b3739577850faee05754"],
    ["0016_publication_authority.sql", "a97c64175d4af12a2b06782007491c7acb9da2364003cc09110e7b5356b31b9d"],
    ["0017_readiness_sweep_fence.sql", "96ad7866bb6083a2f0e0415c6a86a7a4efe492310a1fced1606c5c012493986c"],
    ["0018_admin_analytics_caches.sql", "f4d7df1e75c0d3bd880bba7d3653ca53b5c19d8af2e5fb0a5ada35abb915f6c5"],
    ["0019_signin_start_admission.sql", "a5fe389848a1ec7bf11c9f4408c43ca5e547c03e1299adaa86697d1eca24db72"],
    ["0020_analytics_results_and_delivery.sql", "7725f2a57d290e3aa25387b84c0f1cf50509bfb560a2f92fb7c209d4f8cede74"],
    ["0021_upload_ingress_budget.sql", "a8bc582e17eb518e670fa50e40bab1526b800a86d3a0acb1e9e0138094ae912b"],
    ["0022_github_distribution_history.sql", "412b3555bd2b1aff5b667c92499cadca8d0abbdd0111fbac50a3f0eba65841e6"],
    ["0023_analytics_fit_results.sql", "3cd6cfbdff5ed8a9c8da56f6f3b03343049655952b7169a989f8fb09cbcbd43a"],
    ["0024_scheduler_source_cutoff.sql", "7a0819d714ea5ba8a7191e9a0eb923a8625cbe1bbbae2a9161248dd2e003fe22"],
    ["0025_typed_v12_normalized.sql", "7b789441ac5b1489ec42a90daec9cf1120c10bc192beaed31f9162ee0add1d40"],
    ["0026_v12_domain_days_and_input_revision.sql", "7e15b4d82b196e1ad8b6ef98c253e91f6204921d2f54207ab3346a8cf0a025e5"],
    ["0027_typed_v12_published_delete_guard.sql", "95de20d5e64bb5087ee4de5900b41f6ffa88446216440e10b3d08d79abce3997"],
    ["0028_typed_v12_ready_integrity_guard.sql", "bb0406a7c2f3963ad5dd73b981da3ae5305bb5fa3b19154c413a5d176b2ae3f9"],
    ["0029_legacy_source_membership.sql", "c8d9bb75659705492d3d14f23570ad3207677e75b17b27f032ccfd6c24b15c87"],
    ["0030_legacy_typed_telemetry.sql", "b6ea645e97aa0aef8d9a790ae97a8c11662e3ca459a5dcb7299c98cba80d9d8a"],
    ["0031_typed_legacy_source_family_receipts.sql", "64c115c7593c358fa41c27aae2e0ff60ad82d20f0a205828a115c539a6e123cb"],
    ["0032_analytics_publication_fences.sql", "153fa64c761cac3176d84d129c452246db05623609e2e3c843ed833a4df808d9"],
    ["0033_legacy_admission_proofs.sql", "894901da1e9976a66ef5780d375fe4ed324650bc5f11fb79594a68617fcac236"],
    ["0034_usage_correction_history.sql", "34a837e9646cf0d966d416c01ce39f604a000edc82c3120b2a57229d777bae9d"],
    ["0035_v12_ready_manifest_retention.sql", "a3fb5f597f7e202b7803a5345f52f4a1a2285fc56cc2c5d119c0b2a2571a0872"],
    ["0036_streamed_publication_proofs.sql", "136645a7a262d756813c43f305930c8cf5435ab5415ef8bad3c38a6c3e07dee8"],
    ["0037_community_daily_publications.sql", "885add3276a9f3e41a9a528854b9ff3dade842ce0546503c525ce1501d1d77c3"],
    ["0038_analytics_event_tuple_versions.sql", "c20e692d07cd16ae5f870832610ce6bdf7b97eb734fe4ed96b821fdd85757b2f"],
    ["0039_analytics_applied_projection_v1.sql", "5750810077d5a9124e8605007b514e841136177f88db473905cec289ff833ecc"],
    ["0040_historical_transport_headers.sql", "4d239036e397b68e62d4a9ba3a2022178dc33243af88294845908c06fe0b6816"],
    ["0041_accountless_history_retention.sql", "19c1f19a1ec333012c70334bf8ac8f6c1ca5b2a2c9e67d3b716eaa81dcbcd45b"],
    ["0042_accountless_history_retention_import.sql", "c072c60b22d77c850eacc081e39e73c02fb5f7a4d74e209f1e797e18a7dac2f8"],
    ["0043_accountless_history_d1_import.sql", "417709f265294a547d7585617241922bf633042a141d08dbf51f418dcd653b00"],
    ["0044_accountless_import_claim_erasure.sql", "bdbf53078ffbb3b5f2ae7eb61a62f396b0d273004eee6caf0bc7947a097711cf"],
    ["0045_accountless_v12_history_retention.sql", "e7cb2176022da277ef26be8cab8b3cbaabce548ff4ccde37c25fd10b2908661d"],
    ["0046_owner_journal_authority.sql", "ca26390533fdc9a053319a9e128ef94a074a44037e9e581f56b2a1f4e90be062"],
    ["0047_host_diagnostic_errors.sql", "6cdb5a6f78cb50ee33cda6e82a03c5ec7434374a4327211a538dda1df1b5864b"],
    ["0048_rate_limit_buckets_unlogged.sql", "fb2d458fd7a369e99d962e2dbcaa510da34908c532c9d296fe38369b98146dff"],
    ["0049_lifecycle_readiness_state.sql", "6f2770085b9a6b0b1e068312685e09a24594178f92327d89a98d37279a38bb22"],
    ["0050_admin_audit_and_collection_controls.sql", "234e455574620c19041dcd4a3ee19947b9b4db346190aaaa3a8c5406ad50cc81"],
    ["0051_transport_floor_parity.sql", "1f36dc7558ab85b8a90a05530efeca23abad432c9808a32a7515e7c412c591bd"],
    ["0052_typed_telemetry_live_allocators.sql", "8257867f0c707a30f57f1bf16c21c2012f89108a7e4d0abe9e4926976e58a093"],
    ["0053_community_publication_authority.sql", "dd3f7f293d63295688ced56a558befa5f2018a85a61304c8cab9e0df6993ae15"],
    ["0054_signin_handoff_claim_shape.sql", "8aef7018969cd1438c11ac20f262d82acd0319ba621357150e8bd9f26d722185"],
    ["0055_v12_owner_bridge.sql", "bd6027ef988dea6c9a34a9c8fb494c33bc8d820bdd77c5e165ada3bcdd627681"],
    ["0056_production_transfer_control.sql", "bfc8637b903b33ec02b07f087f3b5345edd4fbcab7ebcb08d732b846edc0e346"],
    ["0057_upload_path_analytics_retirement.sql", "439cbf18d64fdcaa2ea33ab34762d99471b2214e176c8f695c8b444d69043faa"],
    ["0058_owner_journal_emitter_head_precheck.sql", "c8f1133799e7c19a7c60cd61f96ad110911446a35a3654c14ec9c61a64cc744f"],
    ["0059_analytics_v2.sql", "e25a529b6f7b7fd754a51cc6f6e8399bcd1e46b7c74ad60c76cddebb9568ccea"],
    ["0060_telemetry_v11_live_admission.sql", "9216078e27d695c3615b888cd1a27df0ff7a5af94583fc97208c6f2ca16e47f0"],
    ["0061_legacy_contribution_admission.sql", "9a22c0f0fa4b1dc1c0694cb2020b89546ede6c8cc6e949b4cb6e87b42465c5c8"],
    ["0062_telemetry_contribution_trigger_search_path.sql", "b9eaaa7c19948a778c0d3e857b872cea6ce5026ab82566438d7f295b0a2ea876"],
    ["0063_enrollment_grants_erased_redeemer.sql", "0341b5a6b7165b918e7e18c11873243aff4906a81a8376a0ae46ec5f14007ce9"],
    ["0064_append_only_residue.sql", "74fb4aed9c0b1eef7f1433e9e0ea6501bdb8beedffefa17a928ad7774cce37be"],
    ["0065_interim_public_read.sql", "220228e87405edbfe0a235f884bb365d71431d99a679701efc6872509e0c0244"],
    ["0066_community_aggregate_exclusions.sql", "49271ce58d0f34c5317df3e8636b2b47bfc2204bd1510bb5e6053a189d823c10"],
    ["0067_pending_object_transfer_holds.sql", "a6c7df2329760ec484802065abc8589d7e6f075c0e27464018783ff8c1553b9b"],
    ["0068_v12_ready_manifest_ready_at_index.sql", "3c2797c3fcbcc740dab8e4e42bdbdbddff8a5d5b8d6fb745e4939158bd08a2ad"],
    ["0069_analytics_v2_run_stamps.sql", "97d4ef47627dec182f61eb5f94478e5cd2e5f87d6044d891f4d756155170e59d"],
    ["0070_catalog_manifest_store.sql", "513562422851fb82e55686400ab6cb47e923fabaff781c34e456ff1f14f1fb43"],
  ] as readonly MigrationEntry[]).map((entry, index) => receipt(entry, index + 1))),
});
