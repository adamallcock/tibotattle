import { D1_PROVIDER_SCHEMA_PREDICATE } from './d1-provider-schema';
/** Private restore protocol metadata, never a runtime authorization source. */
export const AUTHORITY_RESTORE_SCHEMA = [
`CREATE TABLE _authority_restore_run(id INTEGER PRIMARY KEY CHECK(id=1),run_id TEXT NOT NULL,contract_digest TEXT NOT NULL,limit_bytes INTEGER NOT NULL CHECK(limit_bytes BETWEEN 33554432 AND 9000000000),phase TEXT NOT NULL CHECK(phase IN ('copying','sealed','verified','installed','ready'))) STRICT`,
`CREATE TABLE _authority_restore_tables(name TEXT PRIMARY KEY,ordinal INTEGER NOT NULL UNIQUE,descriptor TEXT NOT NULL,copy_cursor TEXT NOT NULL DEFAULT '[]',verify_cursor TEXT NOT NULL DEFAULT '[]',copied INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0,copy_done INTEGER NOT NULL DEFAULT 0,verify_done INTEGER NOT NULL DEFAULT 0) STRICT`,
`CREATE TRIGGER _authority_restore_descriptor_guard BEFORE UPDATE OF name,ordinal,descriptor ON _authority_restore_tables BEGIN SELECT RAISE(ABORT,'authority_restore_descriptor_immutable'); END`,
`CREATE TABLE _authority_restore_pages(name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('copy','verify')),after_cursor TEXT NOT NULL,through_cursor TEXT NOT NULL,digest TEXT NOT NULL,row_count INTEGER NOT NULL,done INTEGER NOT NULL,PRIMARY KEY(name,kind,after_cursor)) STRICT, WITHOUT ROWID`,
`CREATE TABLE _authority_restore_permission(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL) STRICT`,
`CREATE TABLE _authority_restore_installed_guards(name TEXT PRIMARY KEY,sql TEXT NOT NULL,tbl_name TEXT NOT NULL) STRICT`,
`CREATE TABLE _authority_restore_expected(name TEXT PRIMARY KEY,type TEXT NOT NULL,tbl_name TEXT NOT NULL,sql TEXT NOT NULL) STRICT`,
`CREATE TABLE _authority_restore_adoption(format TEXT PRIMARY KEY CHECK(format IN ('v1','v11')),high_water INTEGER NOT NULL DEFAULT 0,after_id INTEGER NOT NULL DEFAULT 0,copied INTEGER NOT NULL DEFAULT 0,done INTEGER NOT NULL DEFAULT 0,verify_after INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0,verify_done INTEGER NOT NULL DEFAULT 0) STRICT`,
`CREATE TABLE _authority_restore_adoption_assert(id INTEGER NOT NULL CHECK(id=0)) STRICT`,
`CREATE TABLE _authority_restore_typed(format TEXT PRIMARY KEY CHECK(format IN ('v1','v11')),run_id TEXT NOT NULL,verify_cursor INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0,done INTEGER NOT NULL DEFAULT 0) STRICT`,
`CREATE TRIGGER _authority_restore_page_guard BEFORE INSERT ON _authority_restore_pages BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _authority_restore_run WHERE phase=CASE NEW.kind WHEN 'copy' THEN 'copying' ELSE 'sealed' END)
 OR NOT EXISTS(SELECT 1 FROM _authority_restore_tables t WHERE t.name=NEW.name
 AND CASE NEW.kind WHEN 'copy' THEN t.copy_cursor ELSE t.verify_cursor END=NEW.after_cursor
 AND CASE NEW.kind WHEN 'copy' THEN t.copy_done ELSE t.verify_done END=0
 AND (NEW.kind='copy' OR t.copy_done=1)) THEN RAISE(ABORT,'authority_restore_cursor_conflict') END;
END`,
`CREATE TRIGGER _authority_restore_page_commit AFTER INSERT ON _authority_restore_pages BEGIN
 UPDATE _authority_restore_tables SET
 copy_cursor=CASE WHEN NEW.kind='copy' THEN NEW.through_cursor ELSE copy_cursor END,
 verify_cursor=CASE WHEN NEW.kind='verify' THEN NEW.through_cursor ELSE verify_cursor END,
 copied=copied+CASE WHEN NEW.kind='copy' THEN NEW.row_count ELSE 0 END,
 verified=verified+CASE WHEN NEW.kind='verify' THEN NEW.row_count ELSE 0 END,
 copy_done=CASE WHEN NEW.kind='copy' THEN NEW.done ELSE copy_done END,
 verify_done=CASE WHEN NEW.kind='verify' THEN NEW.done ELSE verify_done END WHERE name=NEW.name;
END`,
`CREATE TRIGGER _authority_restore_run_guard BEFORE UPDATE ON _authority_restore_run BEGIN
 SELECT CASE WHEN NEW.run_id IS NOT OLD.run_id OR NEW.contract_digest IS NOT OLD.contract_digest OR NEW.limit_bytes IS NOT OLD.limit_bytes
 OR NOT ((OLD.phase='copying' AND NEW.phase='sealed') OR (OLD.phase='sealed' AND NEW.phase='verified') OR (OLD.phase='verified' AND NEW.phase='installed') OR (OLD.phase='installed' AND NEW.phase='ready'))
 THEN RAISE(ABORT,'authority_restore_state_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM _authority_restore_tables WHERE copy_done!=1 OR (NEW.phase!='sealed' AND (verify_done!=1 OR copied!=verified)))
 OR (NEW.phase!='sealed' AND EXISTS(SELECT 1 FROM _authority_restore_typed WHERE done!=1))
 OR EXISTS(SELECT 1 FROM _authority_restore_adoption WHERE done!=1 OR (NEW.phase!='sealed' AND (verify_done!=1 OR verified!=copied)))
 OR EXISTS(SELECT 1 FROM _authority_restore_permission)
 THEN RAISE(ABORT,'authority_restore_unverified') END;
 SELECT CASE WHEN NEW.phase IN ('installed','ready') AND (
 EXISTS(SELECT 1 FROM _authority_restore_expected e LEFT JOIN sqlite_master s ON s.name=e.name
 WHERE s.name IS NULL OR s.type!=e.type OR s.tbl_name!=e.tbl_name OR s.sql IS NOT e.sql)
 OR EXISTS(SELECT 1 FROM sqlite_master s WHERE s.sql IS NOT NULL AND s.name NOT GLOB 'sqlite_*'
 AND NOT (${D1_PROVIDER_SCHEMA_PREDICATE}) AND s.name NOT GLOB '_authority_*'
 AND NOT EXISTS(SELECT 1 FROM _authority_restore_expected e WHERE e.name=s.name))) THEN RAISE(ABORT,'authority_restore_final_schema_conflict') END;
END`,
`CREATE TRIGGER _authority_restore_run_retained BEFORE DELETE ON _authority_restore_run BEGIN SELECT RAISE(ABORT,'authority_restore_identity_retained'); END`,
];
