/**
 * Shared contracts for ukmesh-planner.
 *
 * Three families:
 *  1. Source snapshot shapes — mirror `planner_export` v1 columns.
 *  2. Planner domain types — plans, planned sites, RF settings.
 *  3. Browser compute protocol — the single input/result schema used by the
 *     WebGPU and WASM/CPU engines (build brief §6.3).
 *
 * Zod v-agnostic style: only basic `z.*` APIs are used.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 1. Source snapshot shapes (`planner_export` v1)
// ---------------------------------------------------------------------------

const isoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'ISO timestamp');

export const canonicalIdSchema = z
  .string()
  .regex(/^[0-9A-F]{64}$/, 'expected 64-char uppercase hex canonical node id');
export type CanonicalId = z.infer<typeof canonicalIdSchema>;

/** One publicly displayable repeater (privacy-filtered upstream). */
export const plannerRepeaterSchema = z.object({
  canonicalId: canonicalIdSchema,
  name: z.string().nullable(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  lastSeen: isoDateTime.nullable(),
  isOnline: z.boolean(),
  hardwareModel: z.string().nullable(),
  firmwareVersion: z.string().nullable(),
  iata: z.string().nullable(),
  advertCount: z.number().int().nonnegative(),
  identityMemberCount: z.number().int().positive(),
});
export type PlannerRepeater = z.infer<typeof plannerRepeaterSchema>;

/** One observed link between two public repeaters. */
export const plannerObservedLinkSchema = z.object({
  sourceId: canonicalIdSchema,
  targetId: canonicalIdSchema,
  observedCount: z.number().int().positive(),
  strongObservationCount: z.number().int().nonnegative(),
  countAToB: z.number().int().nonnegative(),
  countBToA: z.number().int().nonnegative(),
  lastObserved: isoDateTime,
  pathLossDb: z.number().nullable(),
  itmViable: z.boolean().nullable(),
  /** Source semantics: viable = itm_viable OR force_viable (kept separate). */
  forceViable: z.boolean().nullable(),
  evidence: z.literal('observed'),
});
export type PlannerObservedLink = z.infer<typeof plannerObservedLinkSchema>;

/** Privacy-fence snapshot recorded with every published dataset. */
export const visibilityFenceSchema = z.object({
  generation: z.number().int().nonnegative(),
  updatedAt: isoDateTime,
  queriedAt: isoDateTime,
});
export type VisibilityFence = z.infer<typeof visibilityFenceSchema>;

export const snapshotMetaSchema = z.object({
  id: z.string(),
  generation: z.number().int().nonnegative(),
  fetchedAt: isoDateTime,
  repeaters: z.number().int().nonnegative(),
  links: z.number().int().nonnegative(),
});
export type SnapshotMeta = z.infer<typeof snapshotMetaSchema>;

// ---------------------------------------------------------------------------
// 2. Planner domain types
// ---------------------------------------------------------------------------

/** RF model settings. Defaults mirror the documented UK Mesh assumptions. */
export const rfSettingsSchema = z.object({
  frequencyMhz: z.number().positive(),
  txPowerDbm: z.number(),
  txGainDbi: z.number(),
  rxGainDbi: z.number(),
  rxSensitivityDbm: z.number(),
  fadeMarginDb: z.number().nonnegative(),
  antennaHeightAglM: z.number().nonnegative(),
  rxHeightAglM: z.number().nonnegative(),
  maxRangeKm: z.number().positive(),
  /** Link budget margin (rxPower − sensitivity) required for "likely". */
  marginGreenDb: z.number(),
  /** Remaining margin above 0 dB required for "marginal". */
  marginMarginalDb: z.number(),
});
export type RfSettings = z.infer<typeof rfSettingsSchema>;

/**
 * Documented UK Mesh defaults (rf-coverage/config.ukmesh.yaml). These are
 * *assumptions*, clearly labelled as such in the UI — not authoritative radio
 * truth for any specific node.
 */
export const DEFAULT_UK_RF_SETTINGS: RfSettings = {
  frequencyMhz: 868,
  txPowerDbm: 22,
  txGainDbi: 3,
  rxGainDbi: 0,
  rxSensitivityDbm: -124,
  fadeMarginDb: 20,
  antennaHeightAglM: 2,
  rxHeightAglM: 2,
  maxRangeKm: 100,
  marginGreenDb: 15,
  marginMarginalDb: 5,
};

export const plannedSiteSchema = z.object({
  id: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  antennaHeightAglM: z.number().min(0).max(200),
  label: z.string().max(120).nullable(),
  notes: z.string().max(2000).nullable(),
});
export type PlannedSite = z.infer<typeof plannedSiteSchema>;

export const PLAN_VERSION = 1 as const;

export interface PlanState {
  version: typeof PLAN_VERSION;
  sites: PlannedSite[];
  rf: RfSettings;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 3. Compute protocol (single schema for WebGPU + WASM engines)
// ---------------------------------------------------------------------------

/**
 * 'webgpu'  — WGSL engine (hardware adapters only by default).
 * 'cpu'     — the shared TypeScript core running in a Worker (the parity
 *             oracle; used as the bounded fallback when WebGPU is absent or
 *             unsuitable). 'wasm' is reserved for a future compiled build of
 *             the same core.
 */
export const computeBackendSchema = z.enum(['webgpu', 'wasm', 'cpu']);
export type ComputeBackend = z.infer<typeof computeBackendSchema>;

export const computeModelClassSchema = z.enum(['los', 'terrain-link-budget', 'regional-coverage']);
export type ComputeModelClass = z.infer<typeof computeModelClassSchema>;

export const linkEndpointSchema = z.object({
  id: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  antennaHeightAglM: z.number().min(0).max(200),
});
export type LinkEndpoint = z.infer<typeof linkEndpointSchema>;

export const linkClassificationSchema = z.enum([
  'likely',
  'marginal',
  'unlikely',
  'blocked',
  'unknown-terrain',
]);
export type LinkClassification = z.infer<typeof linkClassificationSchema>;

export interface LinkResult {
  targetId: string;
  classification: LinkClassification;
  distanceKm: number;
  /** Link budget margin dB (rxPower − sensitivity); null when terrain unknown. */
  marginDb: number | null;
  freeSpaceLossDb: number;
  diffractionDb: number | null;
  pathLossDb: number | null;
  /** Worst first-Fresnel-zone clearance ratio (1.0 = just grazing). */
  fresnelClearanceRatio: number | null;
  profileSource: string;
  warnings: string[];
}

export interface ProfilePoint {
  distanceM: number;
  terrainM: number | null;
  lineHeightM: number;
  earthBulgeAdjM: number;
  fresnelRadiusM: number;
  clearanceM: number | null;
}

export interface ProfileResult {
  sourceId: string;
  targetId: string;
  points: ProfilePoint[];
  worstPointIndex: number | null;
}

export interface RasterResult {
  width: number;
  height: number;
  bounds: [number, number, number, number]; // [west, south, east, north]
  /** Margin dB per cell; NaN = unknown. */
  values: Float32Array;
  resolutionM: number;
}

export const computeRequestSchema = z.object({
  jobId: z.string().min(1),
  modelVersion: z.string().min(1),
  terrainRevision: z.string().min(1),
  sourceSnapshotId: z.string().min(1),
  modelClass: computeModelClassSchema,
  plannedSites: z.array(plannedSiteSchema).min(1).max(50),
  receiverSites: z.array(linkEndpointSchema).max(5000).optional(),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  resolution: z
    .object({ width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096) })
    .optional(),
  rf: rfSettingsSchema,
});
export type ComputeRequest = z.infer<typeof computeRequestSchema>;

export interface ComputeResult {
  jobId: string;
  backend: ComputeBackend;
  modelVersion: string;
  terrainRevision: string;
  output: LinkResult[] | RasterResult | ProfileResult;
  warnings: string[];
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// API DTOs (planner-origin, same-origin /api/v1/*)
// ---------------------------------------------------------------------------

/** GB + NI + IoM + Channel Islands operational bounds (matches terrain set). */
export const DEFAULT_BOUNDS: [number, number, number, number] = [-11, 49.5, 3, 61];

export const apiConfigSchema = z.object({
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  modelVersion: z.string(),
  datasetVersion: z.string().nullable(),
  computeBackends: z.array(computeBackendSchema),
  snapshot: snapshotMetaSchema.nullable(),
});
export type ApiConfig = z.infer<typeof apiConfigSchema>;

export const apiErrorSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Paginated API responses (planner-origin). */
export const repeatersPageSchema = z.object({
  snapshotId: z.string(),
  items: z.array(plannerRepeaterSchema),
  nextCursor: z.string().nullable(),
});
export type RepeatersPage = z.infer<typeof repeatersPageSchema>;

export const observedLinksPageSchema = z.object({
  snapshotId: z.string(),
  items: z.array(plannerObservedLinkSchema),
  nextCursor: z.string().nullable(),
});
export type ObservedLinksPage = z.infer<typeof observedLinksPageSchema>;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export const SOURCE_CONTRACT_VERSION = 'source-export-v1';
export const RF_MODEL_VERSION = 'rf-model-0.1.0';
