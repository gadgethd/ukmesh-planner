/**
 * Advanced: network topology summary + site-removal scenario (plan §5.2.4).
 *
 * Graph = all repeaters (observed edges from the snapshot's recorded links,
 * predicted edges from the current assessment). All numbers come from the
 * pure topology module — the panel only renders them.
 */
import type { RemovalImpact, TopoStats } from './topology.js';

interface RemovalOption {
  id: string;
  label: string;
}

interface Props {
  stats: TopoStats | null;
  removalOptions: RemovalOption[];
  removalId: string | null;
  removal: RemovalImpact | null;
  onSelectRemoval: (id: string | null) => void;
}

export function TopologyPanel({ stats, removalOptions, removalId, removal, onSelectRemoval }: Props) {
  if (!stats) {
    return <div className="adv-empty">Topology analysis becomes available once a site is placed.</div>;
  }
  return (
    <div className="topo-panel">
      <ul className="profile-stats">
        <li>
          {stats.nodeCount.toLocaleString()} repeaters · {stats.observedEdgeCount.toLocaleString()} observed links ·{' '}
          {stats.predictedEdgeCount.toLocaleString()} predicted links (this site)
        </li>
        <li>
          {stats.componentCount.toLocaleString()} weakly-connected components · largest{' '}
          {stats.largestComponentSize.toLocaleString()} nodes
          {stats.isolatedNodeIds.length > 0 ? ` · ${stats.isolatedNodeIds.length} isolated` : ''}
        </li>
      </ul>
      <div className="topo-removal">
        <label className="muted small" htmlFor="removal-select">
          Site-removal scenario:
        </label>
        <select
          id="removal-select"
          value={removalId ?? ''}
          onChange={(e) => onSelectRemoval(e.target.value || null)}
        >
          <option value="">— pick a nearby repeater —</option>
          {removalOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {removal ? (
          <ul className="profile-stats">
            <li>
              removing this node: components {removal.componentsBefore} → {removal.componentsAfter}
              {removal.isArticulation ? ' (disconnects its component)' : ' (no disconnection)'}
            </li>
            <li>
              largest component after removal: {removal.largestComponentSizeAfter.toLocaleString()} nodes
              {removal.splitOffNodeIds.length > 0
                ? ` · split off: ${removal.splitOffNodeIds.length} node(s)`
                : ' · nothing split off'}
              {removal.isolatedAfterRemoval.length > 0
                ? ` · newly isolated: ${removal.isolatedAfterRemoval.length}`
                : ''}
            </li>
          </ul>
        ) : null}
      </div>
    </div>
  );
}
