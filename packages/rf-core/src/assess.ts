/**
 * Link-budget assessment: free-space loss, diffraction, margin and the
 * user-facing classification used by the Simple journey.
 *
 * Classification (documented model, see docs/rf/model-assumptions.md):
 *   likely          margin ≥ rf.marginGreenDb
 *   marginal        margin ≥ rf.marginMarginalDb AND not physically obstructed
 *   blocked         physically obstructed (worst clearance < 0) and below margins
 *   unlikely        clear geometry but insufficient margin
 *   unknown-terrain any sample with missing DEM data (fail closed)
 */
import type {
  LinkClassification,
  LinkResult,
  RfSettings,
} from '@ukmesh-planner/contracts';
import { haversineDistanceM, type LatLon } from './geo.js';
import { deygoutLossDb } from './diffraction.js';
import { buildProfile, wavelengthM, type ProfileOptions, type TerrainProvider } from './los.js';

export interface LinkEndpoint extends LatLon {
  id: string;
  antennaHeightAglM: number;
}

export function freeSpaceLossDb(distanceKm: number, frequencyMhz: number): number {
  if (distanceKm <= 0) return 0;
  return 32.44 + 20 * Math.log10(distanceKm) + 20 * Math.log10(frequencyMhz);
}

export interface AssessLinkInput {
  provider: TerrainProvider;
  source: LinkEndpoint;
  target: LinkEndpoint;
  rf: RfSettings;
  profile?: Pick<ProfileOptions, 'targetSpacingM' | 'minSamples' | 'maxSamples'>;
}

export function assessLink(input: AssessLinkInput): LinkResult {
  const { provider, source, target, rf } = input;
  const distanceM = haversineDistanceM(source, target);
  const distanceKm = distanceM / 1000;
  const lambdaM = wavelengthM(rf.frequencyMhz);
  const warnings: string[] = [];

  const profile = buildProfile(
    provider,
    { ...source, antennaHeightAglM: source.antennaHeightAglM },
    { ...target, antennaHeightAglM: target.antennaHeightAglM },
    { frequencyMhz: rf.frequencyMhz, ...input.profile },
  );

  const fspl = freeSpaceLossDb(distanceKm, rf.frequencyMhz);

  if (distanceKm > rf.maxRangeKm) {
    warnings.push(`beyond nominal range (${Math.round(distanceKm)} km > ${rf.maxRangeKm} km)`);
  }

  if (profile.unknownCount > 0) {
    return {
      targetId: target.id,
      classification: 'unknown-terrain',
      distanceKm,
      marginDb: null,
      freeSpaceLossDb: fspl,
      diffractionDb: null,
      pathLossDb: null,
      fresnelClearanceRatio: profile.worstClearanceRatio,
      profileSource: provider.revision,
      warnings: [...warnings, `missing terrain at ${profile.unknownCount} sample(s)`],
    };
  }

  const { lossDb: diffractionDb } = deygoutLossDb(profile.points, lambdaM, 3);
  const pathLossDb = fspl + diffractionDb;
  const rxPowerDbm = rf.txPowerDbm + rf.txGainDbi + rf.rxGainDbi - pathLossDb;
  const marginDb = rxPowerDbm - rf.rxSensitivityDbm;
  const worstRatio = profile.worstClearanceRatio;

  let classification: LinkClassification;
  if (marginDb >= rf.marginGreenDb) {
    classification = 'likely';
    if (worstRatio !== null && worstRatio < 0) {
      warnings.push('terrain obstruction present but budget margin is positive (diffraction)');
    }
  } else if (marginDb >= rf.marginMarginalDb && (worstRatio === null || worstRatio >= 0)) {
    classification = 'marginal';
  } else if (worstRatio !== null && worstRatio < 0) {
    classification = 'blocked';
  } else {
    classification = 'unlikely';
  }

  if (worstRatio !== null && worstRatio < 0.6 && classification !== 'blocked') {
    warnings.push('first Fresnel zone partially obstructed');
  }

  return {
    targetId: target.id,
    classification,
    distanceKm,
    marginDb,
    freeSpaceLossDb: fspl,
    diffractionDb,
    pathLossDb,
    fresnelClearanceRatio: worstRatio,
    profileSource: provider.revision,
    warnings,
  };
}
