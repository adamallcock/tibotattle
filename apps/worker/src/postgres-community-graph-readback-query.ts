import { quotePostgresIdentifier } from "./postgres-client";

/** Shared statement for publication-member readback and its Cloud SQL plan probe. */
export function postgresCommunityGraphMemberReadbackSelect(primarySchema: string): string {
  const schema = quotePostgresIdentifier(primarySchema);
  return `SELECT member.owner_digest, member.input_revision, member.owner_revision,
                 member.authority_epoch, member.source_kind, member.input_fingerprint,
                 member.result_sha256, owner.state AS owner_state, link.state AS link_state,
                 participant.state AS participant_state
            FROM ${schema}.analytics_publication_owner_members member
            LEFT JOIN ${schema}.analytics_owner_state owner
              ON owner.source_id = member.source_id AND owner.owner_digest = member.owner_digest
            LEFT JOIN ${schema}.storage_v11_owner_links link ON link.owner_digest = member.owner_digest
            LEFT JOIN ${schema}.participants participant ON participant.id = link.participant_id
           WHERE member.source_id = $1 AND member.day = $2::date
             AND member.metric = 'model' AND member.generation = $3
           ORDER BY member.owner_digest COLLATE "C"`;
}
