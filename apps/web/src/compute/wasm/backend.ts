/**
 * Loader + runner for the WASM coverage core (Tier B fallback backend).
 *
 * The module is a self-contained AssemblyScript build (`coverage-core.ts`,
 * f64 arithmetic mirroring the CPU oracle). No AS loader runtime is needed:
 * the module exposes the alloc functions plus runBand and its own `memory`.
 */
import type { RfSettings } from '@ukmesh-planner/contracts';
import type { CoverageGeometry } from '../coverage/params.js';

export interface WasmDem {
  data: Float32Array;
  width: number;
  height: number;
  originX: number;
  originY: number;
}

export interface WasmRunInput {
  site: { lat: number; lon: number; antennaHeightAglM: number };
  geometry: CoverageGeometry;
  rf: RfSettings;
  siteTopM: number;
  dem: WasmDem;
  onProgress?: (done: number, total: number) => void;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  allocDem(len: number): number;
  allocMargins(len: number): number;
  allocCodes(len: number): number;
  allocParams(): number;
  runBand(row0: number, rows: number): void;
}

const BAND_ROWS = 16;

export class WasmCoverageCore {
  private constructor(private readonly exports: WasmExports) {}

  static async load(url = '/wasm/coverage-core.wasm'): Promise<WasmCoverageCore> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`WASM core fetch failed (${res.status})`);
    return WasmCoverageCore.fromBytes(await res.arrayBuffer());
  }

  static async fromBytes(bytes: ArrayBuffer | Uint8Array): Promise<WasmCoverageCore> {
    // The AssemblyScript stub runtime imports env.abort (assertion failures;
    // unreachable with --noAssert, but the import must be satisfied).
    const imports = {
      env: {
        abort: (): never => {
          throw new Error('WASM coverage core aborted');
        },
      },
    };
    const result = (await WebAssembly.instantiate(bytes, imports)) as unknown as
      | WebAssembly.Instance
      | WebAssembly.WebAssemblyInstantiatedSource;
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const ex = instance.exports as unknown as WasmExports;
    if (typeof ex.runBand !== 'function' || !(ex.memory instanceof WebAssembly.Memory)) {
      throw new Error('WASM core exports missing');
    }
    return new WasmCoverageCore(ex);
  }

  run(input: WasmRunInput): { margins: Float32Array; codes: Uint8Array; counts: number[] } {
    const { geometry, rf, dem, site } = input;
    const total = geometry.width * geometry.height;
    if (![geometry.width, geometry.height, dem.width, dem.height].every((v) => Number.isSafeInteger(v) && v > 0)
        || geometry.width > 512 || geometry.height > 512 || dem.width * dem.height !== dem.data.length
        || dem.data.byteLength > 96 * 1024 * 1024) {
      throw new Error('WASM coverage dimensions exceed the bounded preview budget');
    }

    // Allocate everything up-front; runBand does not allocate, so the views
    // below stay valid for the whole run.
    const demPtr = this.exports.allocDem(dem.data.length);
    const marginsPtr = this.exports.allocMargins(total);
    const codesPtr = this.exports.allocCodes(total);
    const paramsPtr = this.exports.allocParams();

    const mem = this.exports.memory.buffer;
    new Float32Array(mem, demPtr, dem.data.length).set(dem.data);

    const params = new Float64Array(mem, paramsPtr, 24);
    params[0] = site.lon;
    params[1] = site.lat;
    params[2] = input.siteTopM;
    params[3] = rf.rxHeightAglM;
    params[4] = dem.originX;
    params[5] = dem.originY;
    params[6] = dem.width;
    params[7] = dem.height;
    params[8] = geometry.centerPx.x - geometry.halfPx;
    params[9] = geometry.centerPx.y - geometry.halfPx;
    params[10] = geometry.cellPx;
    params[11] = geometry.width;
    params[12] = geometry.height;
    params[13] = rf.txPowerDbm;
    params[14] = rf.txGainDbi;
    params[15] = rf.rxGainDbi;
    params[16] = rf.rxSensitivityDbm;
    params[17] = rf.marginGreenDb;
    params[18] = rf.marginMarginalDb;
    params[19] = rf.maxRangeKm;
    params[20] = rf.frequencyMhz;
    params[21] = 90; // targetSpacingM (mirrors kernel-cpu)
    params[22] = 24; // minSamples
    params[23] = 512; // maxSamples

    let done = 0;
    for (let row0 = 0; row0 < geometry.height; row0 += BAND_ROWS) {
      const rows = Math.min(BAND_ROWS, geometry.height - row0);
      this.exports.runBand(row0, rows);
      done += rows * geometry.width;
      input.onProgress?.(done, total);
    }

    // Copy out of wasm memory (buffers are transferred to the main thread).
    const margins = new Float32Array(this.exports.memory.buffer, marginsPtr, total).slice();
    const codes = new Uint8Array(this.exports.memory.buffer, codesPtr, total).slice();
    const counts = [0, 0, 0, 0, 0, 0];
    for (const c of codes) counts[c] = (counts[c] ?? 0) + 1;
    return { margins, codes, counts };
  }
}
