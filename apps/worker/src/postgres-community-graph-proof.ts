import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import type { PostgresCommunityGraphSourceKind } from "./postgres-community-graph-contract";

export const STREAMED_MEMBER_PROOF_ALGORITHM = "sha256-binary-merkle-v1";

export type PostgresCommunityGraphMemberProof = readonly [
  ownerDigest: string,
  sourceKind: PostgresCommunityGraphSourceKind,
  inputRevision: number,
  ownerRevision: number,
  authorityEpoch: number,
  inputFingerprint: string | null,
  resultSha256: string | null,
];

type ProofStackEntry = { readonly level: number; readonly digest: string };

/** Constant-space ordered Merkle accumulator. The root is independent of
 * database page boundaries and is used only by the version-2 capture format. */
export class StreamingMemberProofAccumulator {
  private readonly stack: Array<string | undefined> = [];
  private size = 0;

  async add(proof: PostgresCommunityGraphMemberProof): Promise<void> {
    let level = 0;
    let digest = await sha256Hex(canonicalJson(["postgres-community-member-leaf-v1", proof]));
    while (this.stack[level] !== undefined) {
      const left = this.stack[level]!;
      digest = await sha256Hex(canonicalJson(["postgres-community-member-node-v1", level, left, digest]));
      this.stack[level] = undefined;
      level += 1;
    }
    this.stack[level] = digest;
    this.size += 1;
  }

  async root(): Promise<string> {
    const peaks: ProofStackEntry[] = [];
    for (let level = 0; level < this.stack.length; level += 1) {
      const digest = this.stack[level];
      if (digest !== undefined) peaks.push({ level, digest });
    }
    return await sha256Hex(canonicalJson([
      "postgres-community-member-root-v1", this.size, peaks,
    ]));
  }

  get count(): number { return this.size; }
}
