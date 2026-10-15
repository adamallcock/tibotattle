/** Count the same admitted proofs as typed_v11_record_admissions for outer
 * alias `chunk`. Effective readers already require the compact-proof schema.
 * Its immutable membership guard proves every proof's physical chunk has
 * format 11. State that format before the lookup so the existing unique key
 * (namespace_id,format,original_id) seeks one chunk instead of scanning every
 * chunk in the namespace for each completeness check. Keep the allocation and
 * manifest-membership joins from the compatibility view. */
export const TYPED_V11_CHUNK_PROOF_COUNT_SQL = `(SELECT count(*)
  FROM typed_v11_chunk_allocations allocation
  CROSS JOIN typed_telemetry_chunks physical_chunk
    ON physical_chunk.namespace_id=allocation.namespace_id AND physical_chunk.format=11
      AND physical_chunk.original_id=allocation.chunk_original
  CROSS JOIN typed_v11_record_proofs proof ON proof.chunk_key=physical_chunk.id
  JOIN typed_v11_manifest_memberships membership ON membership.typed_manifest_id=proof.manifest_key
  WHERE allocation.chunk_id=chunk.id)`;
