export interface ReviewUnit { readonly id: string; readonly depends_on: readonly string[] }

/** Keep partial review dependency-closed without changing any writer authority. */
export function selectReviewUnit(units: readonly ReviewUnit[], selected: readonly string[], id: string, checked: boolean): string[] {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  if (!byId.has(id) || byId.size !== units.length) throw new Error("提案の単位を確認できません。");
  const next = new Set(selected.filter(value => byId.has(value)));
  if (checked) {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const include = (key: string) => {
      if (visiting.has(key)) throw new Error("提案の依存関係が循環しています。");
      if (visited.has(key)) return;
      const unit = byId.get(key);
      if (!unit) throw new Error("必要な変更単位が見つかりません。");
      visiting.add(key);
      for (const dependency of unit.depends_on) include(dependency);
      visiting.delete(key); visited.add(key); next.add(key);
    };
    include(id);
  } else {
    next.delete(id);
    // Removing a prerequisite also removes every dependent selection.
    let changed = true;
    while (changed) {
      changed = false;
      for (const unit of units) if (next.has(unit.id) && unit.depends_on.some(key => !next.has(key))) {
        next.delete(unit.id); changed = true;
      }
    }
  }
  return units.filter(unit => next.has(unit.id)).map(unit => unit.id);
}
