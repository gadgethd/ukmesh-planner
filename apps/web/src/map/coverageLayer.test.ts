import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapView } from './mapView.js';
vi.mock('maplibre-gl', () => ({ setWorkerUrl: () => {} }));
vi.mock('./linkLayer3D.js', () => ({ Link3DLayer: class {} }));

const raster = { width: 1, height: 1, codes: new Uint8Array([0]), bounds: [-2, 54, -1, 55] as [number, number, number, number] };
function setup() {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout });
  vi.stubGlobal('ImageData', class {});
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ putImageData: () => {} }), toDataURL: () => 'data:image/png;base64,fixture' }) });
  const sources = new Map<string, { updateImage: ReturnType<typeof vi.fn> }>();
  const layers = new Set<string>();
  const map = {
    getSource: (id: string) => sources.get(id), getLayer: (id: string) => layers.has(id),
    addSource: vi.fn((id: string) => { sources.set(id, { updateImage: vi.fn() }); }),
    addLayer: vi.fn(({ id }: { id: string }) => { layers.add(id); }),
    removeSource: (id: string) => sources.delete(id), removeLayer: (id: string) => layers.delete(id),
  };
  // Exercise the real async renderer/retry logic without creating a GL context.
  const view = Object.create(MapView.prototype) as MapView;
  Object.assign(view, { map, coverageRevision: 0 });
  map.addSource.mockImplementationOnce(() => { throw new Error('Style is not done loading'); });
  return { view, map, sources, layers };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('coverage layer generations', () => {
  it('cannot resurrect a cancelled overlay after a delayed style retry', async () => {
    const s = setup();
    const pending = s.view.setCoverage(raster);
    await s.view.setCoverage(null);
    await vi.advanceTimersByTimeAsync(300); await pending;
    expect(s.layers.size).toBe(0); expect(s.sources.size).toBe(0);
    expect(s.map.addLayer).not.toHaveBeenCalled();
  });
  it('does not overwrite a newer raster when an old style retry completes', async () => {
    const s = setup();
    const old = s.view.setCoverage(raster);
    await s.view.setCoverage({ ...raster, codes: new Uint8Array([3]) });
    const source = s.sources.get('coverage')!;
    await vi.advanceTimersByTimeAsync(300); await old;
    expect(s.layers.has('coverage-raster')).toBe(true);
    expect(s.sources.get('coverage')).toBe(source);
    expect(source.updateImage).not.toHaveBeenCalled();
  });
});
