/** D1 meta.changes includes trigger/cascade work. A guarded direct write must
 * prove its own affected row, independently of derived bookkeeping writes. */
export function returnedD1Target(result: D1Result<unknown> | undefined,
  field: string, expected: string | number): boolean {
  const rows = result?.results;
  return Array.isArray(rows) && rows.length === 1 && rows[0] !== null
    && typeof rows[0] === 'object' && Reflect.get(rows[0], field) === expected;
}
