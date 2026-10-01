import providers from './d1-provider-schema.json';

// Exact remote D1 and native local D1 metadata shapes. Unknown names,
// altered DDL and attached SQL remain part of application-schema drift evidence.
// The caller's sqlite_schema alias must be `s`.
const literal=(value:string)=>`'${value.replaceAll("'", "''")}'`;
export const D1_PROVIDER_SCHEMA_PREDICATE = providers.map(provider=>`(s.type=${literal(provider.type)}
 AND s.name=${literal(provider.name)} AND s.tbl_name=${literal(provider.tbl_name)}
 AND s.sql=${literal(provider.sql)} AND NOT EXISTS(
 SELECT 1 FROM sqlite_master provider_attached WHERE provider_attached.tbl_name=${literal(provider.tbl_name)}
 AND provider_attached.name!=${literal(provider.name)} AND provider_attached.sql IS NOT NULL))`).join(' OR ');
