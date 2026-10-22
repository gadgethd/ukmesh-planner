import type { RfSettings } from '@ukmesh-planner/contracts';
import type { CoverageDetail } from './params.js';

export interface CoverageJobRequest {
  type: 'coverage';
  jobId: number;
  site: { lat: number; lon: number; antennaHeightAglM: number };
  detail: CoverageDetail;
  rf: RfSettings;
  forceBackend?: 'webgpu' | 'wasm' | 'cpu' | null;
  /** CPU fallback resolution ceiling (cells per side; default 128). */
  cpuMaxResolution?: number;
}
