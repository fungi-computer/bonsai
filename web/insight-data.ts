import type { Agent, Graph } from "../shared/contract.js";

type ContributorKind = "agent" | "human" | "unknown";
function contributorKind(
  actor: string | null,
  actors: readonly Agent[],
): ContributorKind {
  return actors.find((item) => item.id === actor)?.kind ?? "unknown";
}

export function actorSplit(graph: Graph, actors: readonly Agent[]) {
  const counts = () => ({ agent: 0, human: 0, unknown: 0 });
  const commits = counts();
  const merges = counts();
  for (const node of graph.nodes) {
    const kind = contributorKind(node.agent, actors);
    commits[kind]++;
    if (node.parents.length > 1) merges[kind]++;
  }
  return { commits, merges };
}

const DAY = 86400;
export function contributionDays(graph: Graph, now = Date.now()) {
  const today = Math.floor(now / 1000 / DAY);
  const days = Array.from({ length: 182 }, (_, index) => ({
    day: today - 181 + index,
    count: 0,
  }));
  for (const node of graph.nodes) {
    const index = Math.floor(node.committedAt / DAY) - (today - 181);
    const item = days[index];
    if (item) item.count++;
  }
  return days;
}

export function contributionWeeks(
  graph: Graph,
  actors: readonly Agent[],
  now = Date.now(),
) {
  const end = Math.floor(now / 1000 / (7 * DAY));
  const contributors = new Map<
    string,
    {
      id: string;
      name: string;
      kind: ContributorKind;
      color: string | undefined;
      total: number;
    }
  >();
  const weeks = Array.from({ length: 12 }, (_, index) => ({
    index,
    counts: new Map<string, number>(),
  }));
  for (const node of graph.nodes) {
    const week = weeks[Math.floor(node.committedAt / (7 * DAY)) - end + 11];
    if (!week) continue;
    const id =
      node.agent === null ? `unknown:${node.author}` : `actor:${node.agent}`;
    const actor = actors.find((item) => item.id === node.agent);
    const contributor = contributors.get(id) ?? {
      id,
      name: actor?.name ?? node.agent ?? node.author,
      kind: contributorKind(node.agent, actors),
      color: actor?.color,
      total: 0,
    };
    contributor.total++;
    contributors.set(id, contributor);
    week.counts.set(id, (week.counts.get(id) ?? 0) + 1);
  }
  return { contributors: [...contributors.values()], weeks };
}
