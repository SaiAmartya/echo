// Tree builder for SwarmThread's indented thread display.
// Pure functions; no React dependencies. Extracted from SwarmThread.tsx to
// keep it under 500 lines (R8 / project file-size guideline).
//
// Tree shape per CONTRACTS v1 §3 + v6 §21:
//   - Top-level posts: parent === "seed" (or null/undefined for safety).
//   - Reply posts: parent === some post.id.
//
// Visual model: render top-level → its descendants flattened into level-1
// indented children. Levels 3+ collapse back to level-2 visually; the
// existing "Replying to @x" tag retains the actual parent for clarity.

export interface TreeNodePost {
  id: string;
  parent: string;
  round: number;
  like_count?: number;
  reply_count?: number;
}

export interface ThreadGroup<T extends TreeNodePost> {
  top: T;
  // Descendants are all posts in the subtree rooted at top, flattened and
  // sorted chronologically (round asc, then id-numeric asc). Level-3+
  // descendants collapse here at level-1 visually.
  descendants: T[];
}

// Strip the "p" prefix and parse the numeric monotonic suffix; falls back to
// localeCompare-shape number on malformed ids. We need numeric sort because
// string-sort puts "p10" before "p2".
export function postIdNumeric(id: string): number {
  const m = /^p(\d+)$/.exec(id);
  if (m) return Number(m[1]);
  // Fallback: hash to a stable but unique-ish int so equal-named ids tie consistently.
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return h;
}

function isTopLevelParent(parent: string | null | undefined): boolean {
  return parent === "seed" || parent === null || parent === undefined || parent === "";
}

// Sort comparator: round asc, then id-numeric asc.
function chronComparator<T extends TreeNodePost>(a: T, b: T): number {
  if (a.round !== b.round) return a.round - b.round;
  return postIdNumeric(a.id) - postIdNumeric(b.id);
}

// Engagement score per v6 §22-§23: like_count + 2 * reply_count.
// Higher = more engaged. Used for top-level sorting in "engagement" mode.
export function engagementScore(p: TreeNodePost): number {
  return (p.like_count ?? 0) + 2 * (p.reply_count ?? 0);
}

export type SortMode = "arrival" | "engagement";

// Build groups: one per top-level post. Descendants collected via BFS from
// the top-level's direct children, then flattened + chronologically sorted
// (independent of the top-level sort).
export function buildThreadGroups<T extends TreeNodePost>(
  posts: T[],
  sortMode: SortMode,
): ThreadGroup<T>[] {
  // Index children by parent id so we can walk the subtree without rescanning.
  const childrenByParent = new Map<string, T[]>();
  const tops: T[] = [];
  for (const p of posts) {
    if (isTopLevelParent(p.parent)) {
      tops.push(p);
      continue;
    }
    const arr = childrenByParent.get(p.parent);
    if (arr) arr.push(p);
    else childrenByParent.set(p.parent, [p]);
  }

  // Build subtree for each top-level via BFS. We collect all descendants
  // (level 1, 2, 3+) and then sort chronologically — visual indent caps at
  // level-1 regardless of actual depth, which means level-3+ flatten visually.
  const groups: ThreadGroup<T>[] = tops.map((top) => {
    const descendants: T[] = [];
    const stack: T[] = [...(childrenByParent.get(top.id) ?? [])];
    while (stack.length > 0) {
      const cur = stack.shift() as T;
      descendants.push(cur);
      const kids = childrenByParent.get(cur.id);
      if (kids && kids.length > 0) stack.push(...kids);
    }
    descendants.sort(chronComparator);
    return { top, descendants };
  });

  // Order top-level groups according to sortMode. Sub-thread order is always
  // chronological (set above) — re-ranking sub-threads on engagement would be
  // confusing per the task brief.
  if (sortMode === "engagement") {
    groups.sort((a, b) => {
      const sa = engagementScore(a.top);
      const sb = engagementScore(b.top);
      if (sa !== sb) return sb - sa; // DESC
      return postIdNumeric(a.top.id) - postIdNumeric(b.top.id); // ties → id asc
    });
  } else {
    // "arrival" — chronological by (round asc, id asc), which matches the
    // server's contract-guaranteed ordering of posts[] in §3.
    groups.sort((a, b) => chronComparator(a.top, b.top));
  }

  return groups;
}
