/**
 * Advanced: link-budget / RF settings editor (plan §5.2.2).
 *
 * Edits the shared RfSettings used by Simple and Advanced alike. Presets are
 * named UK MeshCore-style configurations; every field stays editable. The
 * TX/EIRP line is an advisory helper — it identifies assumptions and never
 * asserts legal compliance. Per-repeater presets are not part of the planner
 * snapshot, so the panel states that assumption explicitly.
 */
import { DEFAULT_UK_RF_SETTINGS, type RfSettings } from '@ukmesh-planner/contracts';

interface Preset {
  id: string;
  label: string;
  rf: RfSettings;
}

export const RF_PRESETS: Preset[] = [
  { id: 'uk-868', label: 'UK 868 MHz (default)', rf: { ...DEFAULT_UK_RF_SETTINGS } },
  {
    id: 'uk-869',
    label: 'UK 869.525 MHz (high duty)',
    rf: { ...DEFAULT_UK_RF_SETTINGS, frequencyMhz: 869.525 },
  },
  {
    id: 'uk-869-low',
    label: 'UK 869.525 MHz (low power)',
    rf: { ...DEFAULT_UK_RF_SETTINGS, frequencyMhz: 869.525, txPowerDbm: 14 },
  },
];

interface Props {
  rf: RfSettings;
  onChange: (rf: RfSettings) => void;
}

const FIELDS: Array<{ key: keyof RfSettings; label: string; step: number; min: number; max: number; unit: string }> = [
  { key: 'frequencyMhz', label: 'Frequency', step: 0.001, min: 100, max: 1000, unit: 'MHz' },
  { key: 'txPowerDbm', label: 'TX power', step: 1, min: 0, max: 30, unit: 'dBm' },
  { key: 'txGainDbi', label: 'TX antenna gain', step: 0.5, min: -5, max: 15, unit: 'dBi' },
  { key: 'rxGainDbi', label: 'RX antenna gain', step: 0.5, min: -5, max: 15, unit: 'dBi' },
  { key: 'rxSensitivityDbm', label: 'RX sensitivity', step: 1, min: -140, max: -80, unit: 'dBm' },
  { key: 'maxRangeKm', label: 'Nominal range', step: 5, min: 5, max: 300, unit: 'km' },
  { key: 'marginGreenDb', label: 'Likely threshold', step: 1, min: 5, max: 30, unit: 'dB' },
  { key: 'marginMarginalDb', label: 'Marginal threshold', step: 1, min: 0, max: 20, unit: 'dB' },
];

export function RfEditor({ rf, onChange }: Props) {
  const set = (key: keyof RfSettings, value: number): void => {
    if (!Number.isFinite(value)) return;
    onChange({ ...rf, [key]: value });
  };
  const eirp = rf.txPowerDbm + rf.txGainDbi;
  const activePreset = RF_PRESETS.find(
    (p) => Math.abs(p.rf.frequencyMhz - rf.frequencyMhz) < 1e-9 && p.rf.txPowerDbm === rf.txPowerDbm,
  );

  return (
    <div className="rf-editor">
      <div className="rf-presets" role="group" aria-label="Radio preset">
        {RF_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={activePreset?.id === p.id ? 'detail-btn detail-btn--active' : 'detail-btn'}
            onClick={() => onChange({ ...p.rf })}
          >
            {p.label}
          </button>
        ))}
        {!activePreset ? <span className="muted small">custom</span> : null}
        <button
          type="button"
          className="detail-btn"
          onClick={() => onChange({ ...DEFAULT_UK_RF_SETTINGS })}
          title="Reset to the UK default preset"
        >
          Reset
        </button>
      </div>
      <div className="rf-grid">
        {FIELDS.map((f) => (
          <label key={f.key} className="rf-field">
            <span className="muted small">
              {f.label} ({f.unit})
            </span>
            <input
              type="number"
              step={f.step}
              min={f.min}
              max={f.max}
              value={rf[f.key] as number}
              onChange={(e) => set(f.key, Number(e.target.value))}
            />
          </label>
        ))}
      </div>
      <p className="muted small">
        EIRP ≈ {eirp.toFixed(1)} dBm (advisory only — check licence conditions). Per-repeater radio presets
        are not in the planner snapshot; the model assumes every repeater matches this preset, so links
        between differing presets are unverified.
      </p>
    </div>
  );
}
