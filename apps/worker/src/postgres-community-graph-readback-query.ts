import { quotePostgresIdentifier } from "./postgres-client";

/** Verify locale-ordered database keys still follow lowercase-hex byte order. */
export function isCanonicalCommunityGraphDigestAfter(value: unknown, previous: string): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && value > previous;
}

/** Validate every row and boundary in a keyset page before advancing its cursor. */
export function isCanonicalCommunityGraphDigestPageAfter(
  values: readonly unknown[],
  previous: string,
): values is readonly string[] {
  let last = previous;
  for (const value of values) {
    if (!isCanonicalCommunityGraphDigestAfter(value, last)) return false;
    last = value;
  }
  return true;
}

/** Shared keyset page statement for publication-member readback and its Cloud SQL plan probe. */
export function postgresCommunityGraphMemberReadbackPageSelect(primarySchema: string): string {
  const schema = quotePostgresIdentifier(primarySchema);
  return `WITH page AS MATERIALIZED (
         SELECT member.owner_digest, member.input_revision, member.owner_revision,
                member.authority_epoch, member.source_kind, member.input_fingerprint,
                member.result_sha256
           FROM ${schema}.analytics_publication_owner_members member
          WHERE member.source_id = $1 AND member.day = $2::date
            AND member.metric = 'model' AND member.generation = $3
            AND member.owner_digest > $4::text
          ORDER BY member.owner_digest
          LIMIT $5::integer
       )
       SELECT page.owner_digest, page.input_revision, page.owner_revision,
              page.authority_epoch, page.source_kind, page.input_fingerprint,
              page.result_sha256, owner.state AS owner_state, link.state AS link_state,
              participant.state AS participant_state
         FROM page
         LEFT JOIN LATERAL (
           SELECT state FROM ${schema}.analytics_owner_state owner
            WHERE owner.source_id = $1 AND owner.owner_digest = page.owner_digest
            LIMIT 1
         ) owner ON true
         LEFT JOIN LATERAL (
           SELECT state, participant_id FROM ${schema}.storage_v11_owner_links link
            WHERE link.owner_digest = page.owner_digest
            LIMIT 1
         ) link ON true
         LEFT JOIN LATERAL (
           SELECT state FROM ${schema}.participants participant
            WHERE participant.id = link.participant_id
            LIMIT 1
         ) participant ON true
        ORDER BY page.owner_digest`;
}
